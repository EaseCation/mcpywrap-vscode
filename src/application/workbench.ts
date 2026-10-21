import { Capabilities, LogEvent, OperationResult, Project, Session, Side, Snapshot, Target, ToolFailure } from '../domain/model';
import { LogFollower, LogSubscription, McpyGateway } from './ports';

export class Workbench {
  private readonly busy = new Set<string>();
  constructor(private readonly tools: McpyGateway, private readonly logsFollower?: LogFollower) {}
  followLogs(target: Target, event: (event: LogEvent) => void, error: (error: Error) => void): LogSubscription {
    if (!this.logsFollower) throw new ToolFailure('unavailable', '增量日志客户端不可用。');
    return this.logsFollower.follow(target, event, error);
  }
  inspect(project: Project): Promise<Snapshot> { return this.tools.inspect(project); }
  capabilities(target: Target): Promise<Capabilities> { return this.tools.capabilities(target); }
  diagnose(project: Project): Promise<OperationResult> { return this.tools.diagnose(project); }
  logs(target: Target, source: 'game' | 'engine' | 'worker'): Promise<string> { return this.tools.logs(target, source); }
  start(project: Project, options: { world?: string; newWorld?: boolean; clients?: 1 | 2 }): Promise<OperationResult> {
    if (options.world && options.newWorld) throw new ToolFailure('rejected', '已有世界与新建世界不能同时选择。');
    return this.mutate(project, () => this.tools.start(project, options));
  }
  stop(target: Target): Promise<OperationResult> { return this.mutate(target.project, () => this.tools.stop(target)); }
  execute(target: Target, side: Side, code: string): Promise<OperationResult> {
    return this.mutate(target.project, async () => {
      if (target.kind !== 'session' || !code.trim()) throw new ToolFailure('rejected', '执行代码需要单个会话和非空选区。');
      const caps = await this.tools.capabilities(target);
      if (!caps.pythonSides.includes(side)) throw new ToolFailure('rejected', '此会话当前不支持所选执行端侧。', '刷新会话并重新选择目标。');
      return this.tools.execute(target, side, code);
    });
  }
  reload(target: Target, side: Side, file: string): Promise<OperationResult> {
    return this.mutate(target.project, async () => {
      const caps = await this.tools.capabilities(target);
      if (target.kind === 'group' ? !caps.coordinatedReload : !caps.pythonReload || !caps.reloadSides.includes(side)) {
        throw new ToolFailure('rejected', '此目标当前不支持所选模块热更。', '检查组状态、运行包和端侧。');
      }
      return this.tools.reload(target, side, file);
    });
  }
  coordinatedTarget(project: Project, session: Session): Target {
    return { project, kind: session.group ? 'group' : 'session', id: session.group ?? session.id };
  }
  private async mutate<T>(project: Project, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(project.id)) throw new ToolFailure('busy', '此项目已有操作正在等待结果。');
    this.busy.add(project.id);
    try { return await action(); } finally { this.busy.delete(project.id); }
  }
}
