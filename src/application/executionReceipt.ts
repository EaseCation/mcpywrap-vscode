import { OperationResult, Side, Target } from '../domain/model';

export const sideLabel = (side: Side): string => side === 'client' ? '客户端 (client)' : '服务端 (server)';

export function executionRequest(target: Target, side: Side, code: string, sequence: number): string {
  const body = code.replace(/^(?:[ \t]*#[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)*/, '');
  const lines = body.trimEnd().split(/\r?\n/);
  const shown = lines.slice(0, 12).join('\n');
  const preview = shown.slice(0, 1600);
  return `[游戏内 Python #${sequence} · 请求]\n项目：${target.project.label}\n目录：${target.project.root}\n` +
    `游戏会话：${target.id}\n执行目标：游戏进程内的 ${sideLabel(side)} Python\n` +
    `正在检查能力并请求游戏执行，等待游戏回执…\n代码预览：\n${preview}${lines.length > 12 || shown.length > 1600 ? '\n…（预览已省略，执行仍使用完整代码）' : ''}\n`;
}

export function executionReceipt(target: Target, side: Side, result: OperationResult, sequence: number): string {
  const matched = result.session === target.id && result.side === side;
  const title = result.ok && result.state === 'completed' && matched ? '游戏已确认执行完成'
    : result.state === 'unknown' ? '结果未知，尚未确认游戏执行完成；请检查原会话，不要重复执行'
    : result.state === 'failed' && matched ? '游戏返回执行失败' : '请求未完成，尚未确认游戏执行完成';
  return [`[游戏内 Python #${sequence} · ${title}]`, `游戏会话：${target.id}`, `执行端侧：${sideLabel(side)}`,
    result.requestId ? `游戏请求 ID：${result.requestId}` : '游戏请求 ID：CLI 未提供',
    result.stdout ? `输出：\n${result.stdout.trimEnd()}` : '', result.stderr ? `错误输出：\n${result.stderr.trimEnd()}` : '',
    result.value !== undefined && result.value !== null ? `结果：${JSON.stringify(result.value, null, 2)}` : '',
    result.error ? `Error: ${result.error}` : '', `状态：${result.state ?? (result.ok ? '未确认' : 'failed')}`, result.hint]
    .filter(Boolean).join('\n') + '\n';
}
