import { spawn } from 'node:child_process';
import { CliRequest, CliTransport } from '../../application/ports';
import { ToolFailure } from '../../domain/model';

export interface ProcessOptions { executable: string; queryTimeoutMs: number; operationTimeoutMs: number }
const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export class ProcessTransport implements CliTransport {
  private readonly active = new Set<() => void>();
  private disposed = false;
  constructor(private readonly options: (projectRoot: string) => ProcessOptions) {}
  request(command: CliRequest): Promise<Record<string, unknown>> {
    if (this.disposed) return Promise.reject(new ToolFailure('unavailable', 'CLI 客户端已关闭。'));
    const options = this.options(command.project.root);
    return new Promise((resolve, reject) => {
      let spawned = false;
      let settled = false;
      let stdout = '';
      let stderr = '';
      let bytes = 0;
      const child = spawn(options.executable, [...command.args], {
        cwd: command.project.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
      });
      const fail = (message: string, kind?: 'unavailable' | 'invalidResponse') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active.delete(cancel);
        child.kill();
        const submitted = spawned || child.pid !== undefined;
        reject(new ToolFailure(kind === 'unavailable' ? kind : command.mutation && submitted ? 'unknown' : kind ?? 'queryFailed',
          message, command.mutation && submitted
            ? '操作结果未知；刷新同一项目的会话并检查日志，不要自动重复执行。'
            : '检查 mcpy.executable、CLI 版本和输出。', { stderr }));
      };
      const timer = setTimeout(() => fail('等待 mcpy 响应超时。'),
        command.mutation ? options.operationTimeoutMs : options.queryTimeoutMs);
      const cancel = () => fail('扩展已结束等待；游戏会话保持由 mcpy 管理。');
      this.active.add(cancel);
      child.on('spawn', () => { spawned = true; });
      child.on('error', error => fail(`无法调用 mcpy：${error.message}`, spawned ? undefined : 'unavailable'));
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('error', error => fail(`读取 mcpy 输出失败：${error.message}`));
      child.stderr.on('error', error => fail(`读取 mcpy 诊断失败：${error.message}`));
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_STDOUT) fail('mcpy 响应超过 8 MiB 上限。', 'invalidResponse');
        else stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        if (settled) return;
        stderr = (stderr + chunk).slice(-MAX_STDERR);
        // Observing diagnostics must never change a submitted operation's outcome.
        try { command.diagnostic?.(chunk); } catch { /* The final JSON remains authoritative. */ }
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        let response: unknown;
        try { response = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); }
        catch { fail(`mcpy 未返回有效 JSON（退出码 ${code ?? signal}）。`, 'invalidResponse'); return; }
        if (typeof response !== 'object' || response === null || Array.isArray(response) ||
          typeof (response as Record<string, unknown>).ok !== 'boolean') {
          fail('mcpy 响应缺少 boolean ok 字段。', 'invalidResponse'); return;
        }
        if (code !== 0 && (response as Record<string, unknown>).ok === true) {
          fail(`mcpy 返回成功但进程异常退出（${code ?? signal}）。`, 'invalidResponse'); return;
        }
        settled = true; clearTimeout(timer); this.active.delete(cancel);
        resolve(response as Record<string, unknown>);
      });
    });
  }
  dispose(): void {
    this.disposed = true;
    for (const cancel of [...this.active]) cancel();
  }
}
