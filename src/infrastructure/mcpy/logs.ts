import { spawn } from 'node:child_process';
import { LogFollower, LogSubscription } from '../../application/ports';
import { LogEvent, LogSource, Target, ToolFailure } from '../../domain/model';
import { commands } from './commands';
import { ProcessOptions } from './transport';

export function parseLogEvent(line: string): LogEvent {
  const data = JSON.parse(line) as Record<string, unknown>;
  if (!data || data.schema_version !== 1) throw new Error('日志流版本无效。');
  if (data.event === 'end') return { kind: 'end' };
  if (typeof data.session !== 'string' || !data.session) throw new Error('日志流缺少会话身份。');
  const role = typeof data.role === 'string' ? data.role : undefined;
  if (data.event === 'state' && typeof data.state === 'string') return { kind: 'state', session: data.session, state: data.state, role };
  if (!['game', 'engine', 'worker'].includes(String(data.source))) throw new Error('日志来源无效。');
  const source = data.source as LogSource;
  if (data.event === 'reset') return { kind: 'reset', session: data.session, source };
  if (data.event === 'log' && typeof data.text === 'string') return { kind: 'log', session: data.session, source, text: data.text, role };
  throw new Error('日志事件无效。');
}

export class CliLogFollower implements LogFollower {
  constructor(private readonly options: (root: string) => ProcessOptions) {}
  follow(target: Target, event: (event: LogEvent) => void, error: (error: Error) => void): LogSubscription {
    const request = commands.follow(target);
    const child = spawn(this.options(target.project.root).executable, [...request.args], {
      cwd: target.project.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let buffer = '', stderr = '', disposed = false, ended = false, failed = false;
    const fail = (message: string) => {
      if (disposed || failed) return;
      failed = true; child.kill();
      error(new ToolFailure('queryFailed', message, '需要支持 logs --follow --format jsonl 的 mcpy。更新 CLI 后可重新连接日志；游戏仍保持运行。'));
    };
    const consume = (line: string) => {
      if (!line.trim() || disposed || failed) return;
      const item = parseLogEvent(line);
      if (item.kind !== 'end' && target.kind === 'session' && item.session !== target.id) throw new Error('日志会话与目标不匹配。');
      ended = ended || item.kind === 'end';
      event(item);
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      try {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          if (newline > 2 * 1024 * 1024) throw new Error('日志事件超过 2 MiB。');
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); consume(line);
        }
        if (buffer.length > 2 * 1024 * 1024) throw new Error('日志流缓冲超过上限。');
      } catch (reason) { fail(reason instanceof Error ? reason.message : String(reason)); }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16384); });
    child.stdout.on('error', reason => fail(reason.message)); child.stderr.on('error', reason => fail(reason.message));
    child.on('error', reason => fail(`无法跟随日志：${reason.message}`));
    const done = new Promise<void>(resolve => child.on('close', code => {
      if (!disposed && !failed) {
        try { if (buffer.trim()) consume(buffer); }
        catch (reason) { fail(reason instanceof Error ? reason.message : String(reason)); }
        if (!ended || code !== 0) fail(`日志订阅中断（${code}）：${stderr.trim()}`);
      }
      resolve();
    }));
    return { done, dispose() { disposed = true; child.kill(); } };
  }
}
