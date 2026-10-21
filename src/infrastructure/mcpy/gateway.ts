import { CliTransport, McpyGateway, TemporarySource } from '../../application/ports';
import { Capabilities, Group, OperationResult, Project, Session, Side, Snapshot, Target, ToolFailure, World } from '../../domain/model';
import { commands } from './commands';

type Json = Record<string, unknown>;
const text = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined;
function object(v: unknown): Json {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ToolFailure('invalidResponse', 'CLI 响应对象格式不正确。');
  return v as Json;
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new ToolFailure('invalidResponse', 'CLI 响应缺少有效列表。');
  return v;
}
function identity(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new ToolFailure('invalidResponse', 'CLI 响应缺少有效目标 ID。');
  return v;
}
function success(data: Json): Json {
  if (data.ok !== true) throw new ToolFailure(data.state === 'unknown' ? 'unknown' : 'rejected',
    text(data.error) ?? 'mcpy 拒绝了操作。', text(data.hint), data);
  return data;
}
function sides(v: unknown): Side[] {
  return Array.isArray(v) ? v.filter((side): side is Side => side === 'client' || side === 'server') : [];
}
function result(data: Json): OperationResult {
  return { ok: data.ok === true, state: text(data.state), session: text(data.session), group: text(data.group),
    side: data.side === 'client' || data.side === 'server' ? data.side : undefined,
    requestId: text(data.request_id), stdout: text(data.stdout), stderr: text(data.stderr),
    error: text(data.error), hint: text(data.hint), value: data.value, details: data };
}

export class CliGateway implements McpyGateway {
  constructor(private readonly transport: CliTransport, private readonly source: TemporarySource) {}
  async inspect(project: Project): Promise<Snapshot> {
    const [status, worlds] = await Promise.allSettled([
      this.transport.request(commands.status(project)), this.transport.request(commands.worlds(project))
    ]);
    if (status.status === 'rejected') throw status.reason;
    const data = success(status.value);
    const groups: Group[] = array(data.groups).map(value => {
      const g = object(value);
      return { id: identity(g.group), state: text(g.state) ?? 'unknown', hint: text(g.hint) ?? text(g.join_instruction),
        members: array(g.members).map(m => identity(object(m).session)) };
    });
    const sessions: Session[] = array(data.sessions).map(value => {
      const s = object(value), id = identity(s.session);
      return { id, state: text(s.state) ?? 'unknown', mode: text(s.mode) ?? 'unknown',
        world: text(s.level_id) ?? text(s.instance), worldReady: s.world_ready === true,
        role: text(s.role), group: text(s.group) ?? groups.find(g => g.members.includes(id))?.id };
    });
    const issues: string[] = [];
    let instances: World[] = [];
    try {
      if (worlds.status === 'rejected') throw worlds.reason;
      instances = array(success(worlds.value).instances).map(value => {
        const w = object(value);
        return { id: identity(w.level_id), name: text(w.name) ?? '测试世界', state: text(w.state) ?? 'unknown' };
      });
    } catch (error) { issues.push(`世界列表查询失败：${error instanceof Error ? error.message : String(error)}`); }
    return { sessions, groups, worlds: instances, issues };
  }
  async start(project: Project, options: { world?: string; newWorld?: boolean; clients?: 1 | 2 }, diagnostic?: (text: string) => void): Promise<OperationResult> {
    const data = success(await this.transport.request({ ...commands.start(project, options), diagnostic }));
    if ((!text(data.session) && !text(data.group)) || !text(data.state)) {
      throw new ToolFailure('unknown', '启动响应缺少会话/组 ID 或状态。', '刷新同一项目找回会话，不重复新建。', data);
    }
    return result(data);
  }
  async stop(target: Target): Promise<OperationResult> {
    return result(success(await this.transport.request(commands.stop(target))));
  }
  async capabilities(target: Target): Promise<Capabilities> {
    const data = success(await this.transport.request(commands.capabilities(target)));
    const python = data.python === undefined ? {} : object(data.python);
    const reload = data.reload === undefined ? {} : object(data.reload);
    return { pythonSides: sides(python.sides), reloadSides: sides(python.reload_sides),
      pythonReload: reload.python !== undefined && object(reload.python).state === 'available',
      coordinatedReload: data.coordinated_reload === true };
  }
  async execute(target: Target, side: Side, code: string): Promise<OperationResult> {
    return this.source.withFile(code, async file => {
      const data = await this.transport.request(commands.execute(target, side, file));
      if (data.ok === true && typeof data.state !== 'string') throw new ToolFailure('unknown', '执行响应缺少状态。', '请检查原会话的日志，不重复执行。', data);
      if ((data.session !== undefined && data.session !== target.id) || (data.side !== undefined && data.side !== side) ||
          (data.ok === true && data.state === 'completed' && (data.session !== target.id || data.side !== side))) {
        throw new ToolFailure('unknown', '执行回执的游戏会话或端侧缺失/不匹配，无法确认执行结果。', '检查原会话日志；不要重复执行代码。', data);
      }
      return result(data);
    });
  }
  async reload(target: Target, side: Side, file: string): Promise<OperationResult> {
    const data = await this.transport.request(commands.reload(target, side, file));
    if (data.ok === true && typeof data.state !== 'string') throw new ToolFailure('unknown', '热更响应缺少状态。', '请检查原目标，不重复注入。', data);
    return result(data);
  }
  async logs(target: Target, source: 'game' | 'engine' | 'worker'): Promise<string> {
    const data = success(await this.transport.request(commands.logs(target, source)));
    if (target.kind === 'session') {
      if (typeof data.text !== 'string') throw new ToolFailure('invalidResponse', 'CLI 日志响应缺少 text。');
      return data.text;
    }
    return array(data.logs).map(value => {
      const item = object(value);
      if (typeof item.text !== 'string') throw new ToolFailure('invalidResponse', '组日志响应缺少 text。');
      return `[${text(item.role) ?? 'member'} ${identity(item.session)}]\n${item.text}`;
    }).join('\n');
  }
  async diagnose(project: Project): Promise<OperationResult> { return result(await this.transport.request(commands.doctor(project))); }
}
