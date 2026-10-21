import * as vscode from 'vscode';
import { Workbench } from '../application/workbench';
import { LogSubscription } from '../application/ports';
import { LogEvent, LogSource, OperationResult, Session, Side, Snapshot, Target } from '../domain/model';

interface BoundSession { key: string; target: Target; session: Session; sides: readonly Side[] }
interface Transcript { source: string; label: string; text: string }
const SOURCES: Record<LogSource, string> = { engine: '引擎', game: '脚本', worker: '启动器' };

export class RuntimeConsole implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly sessions = new Map<string, BoundSession>();
  private readonly subscriptions = new Map<string, { target: Target; subscription: LogSubscription; members: Set<string> }>();
  private readonly channels = new Map<string, { output: vscode.OutputChannel; size: number }>();
  private transcript: (Transcript & { id: number })[] = [];
  private transcriptSize = 0;
  private sequence = 0;
  private lastSent = 0;
  private selected?: string;
  private busy = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private status = '启动游戏测试后会自动连接日志，也可从已有会话连接。';
  private readonly registration: vscode.Disposable;
  constructor(private readonly workbench: Workbench, private readonly extensionUri: vscode.Uri) {
    this.registration = vscode.window.registerWebviewViewProvider('mcpy.console', this, { webviewOptions: { retainContextWhenHidden: true } });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastSent = 0;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/runtime.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media/runtime.css'));
    view.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${view.webview.cspSource}; style-src ${view.webview.cspSource};">
      <link rel="stylesheet" href="${style}"></head><body>
      <header><label>会话 <select id="session" aria-label="执行会话"></select></label>
      <label>端侧 <select id="side" aria-label="执行端侧"></select></label>
      <button id="refresh">刷新端侧</button><button id="reconnect">重新连接日志</button><button id="disconnect">断开全部日志</button>
      <label>显示 <select id="filter" aria-label="日志来源"><option value="all">全部</option><option value="engine">引擎</option><option value="game">脚本</option><option value="worker">启动器</option><option value="python">Python 执行</option></select></label>
      <button id="clear">清空显示</button></header>
      <p id="status" role="status"></p><section id="transcript" aria-label="运行日志与执行结果"></section>
      <section id="composer"><label for="code">运行时 Python 片段</label><textarea id="code" rows="5" spellcheck="false" placeholder="输入游戏内 Python 代码，例如：1 + 1"></textarea>
      <div><button id="run">运行片段</button><span>Ctrl / ⌘ + Enter · 在所选会话内执行</span></div></section>
      <script src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage(message => { void this.onMessage(message); });
    view.onDidDispose(() => { if (this.view === view) this.view = undefined; });
    view.onDidChangeVisibility(() => { if (view.visible) this.publish(); });
    this.publish();
  }
  async attach(target: Target, snapshot: Snapshot): Promise<void> {
    const group = snapshot.groups.find(g => g.id === target.id);
    const members = target.kind === 'group' ? group?.members ?? [] : [target.id];
    const selectedSessions = snapshot.sessions.filter(s => members.includes(s.id));
    for (const session of selectedSessions) {
      const key = `${target.project.id}:${session.id}`;
      this.sessions.set(key, { key, target: { project: target.project, kind: 'session', id: session.id }, session, sides: [] });
    }
    const preferred = selectedSessions.find(session => session.id === target.id) ?? selectedSessions[0];
    if (preferred) this.selected = `${target.project.id}:${preferred.id}`;
    if (this.sessions.size > 64) {
      for (const [oldKey, old] of this.sessions) {
        if (this.sessions.size <= 64) break;
        if (oldKey !== this.selected && !['running', 'starting', 'pending'].includes(old.session.state)) this.sessions.delete(oldKey);
      }
    }
    const key = `${target.project.id}:${target.kind}:${target.id}`;
    if (!this.subscriptions.has(key)) {
      this.append({ source: 'system', label: target.project.label, text: '开始日志订阅（包含近期历史；重新连接可能与先前显示重叠）。' });
      const allowed = new Set(members);
      // Prevent duplicate subscriptions to a group and its member.
      for (const [otherKey, other] of this.subscriptions) {
        if (other.target.project.id === target.project.id && [...allowed].some(id => other.members.has(id))) {
          other.subscription.dispose(); this.subscriptions.delete(otherKey);
        }
      }
      const subscription = this.workbench.followLogs(target, event => this.onLog(target, allowed, event), reason => {
        this.subscriptions.delete(key);
        this.status = `${reason.message} ${'hint' in reason ? String(reason.hint) : ''}`;
        this.append({ source: 'system', label: '日志订阅', text: this.status });
      });
      this.subscriptions.set(key, { target, subscription, members: allowed });
      void subscription.done.then(() => {
        if (this.subscriptions.get(key)?.subscription === subscription) this.subscriptions.delete(key);
      });
    }
    this.status = `已连接 ${target.project.label} · ${target.kind} ${target.id.slice(0, 8)}`;
    await this.refreshCapabilities();
    await vscode.commands.executeCommand('mcpy.console.focus');
    this.publish();
  }
  private onLog(target: Target, members: Set<string>, event: LogEvent): void {
    if (this.disposed) return;
    if (event.kind !== 'end' && !members.has(event.session)) {
      this.status = '成员发生变化，请刷新并重新连接日志。'; this.publish(); return;
    }
    if (event.kind === 'log') {
      const label = `${target.project.label} · ${event.role ?? event.session.slice(0, 8)} · ${SOURCES[event.source]}`;
      const channelKey = `${target.project.id}:${event.session}:${event.source}`;
      let channel = this.channels.get(channelKey);
      if (!channel) {
        channel = { output: vscode.window.createOutputChannel(`mcpy · ${label}`), size: 0 };
        this.channels.set(channelKey, channel);
        if (this.channels.size > 24) {
          const oldest = this.channels.entries().next().value;
          if (oldest) { oldest[1].output.dispose(); this.channels.delete(oldest[0]); }
        }
      }
      channel.size += event.text.length;
      if (channel.size > 2 * 1024 * 1024) { channel.output.clear(); channel.output.appendLine('[仅保留近期日志；完整日志仍由 mcpy 管理]'); channel.size = event.text.length; }
      channel.output.append(event.text);
      this.append({ source: event.source, label, text: event.text });
    } else if (event.kind === 'state') {
      const bound = this.sessions.get(`${target.project.id}:${event.session}`);
      if (bound) {
        bound.session = { ...bound.session, state: event.state };
        if (!['starting', 'running', 'pending'].includes(event.state)) bound.sides = [];
      }
      this.append({ source: 'system', label: `${target.project.label} · ${event.session.slice(0, 8)}`, text: `会话状态：${event.state}` });
    } else {
      if (event.kind === 'end') {
        for (const id of members) {
          const bound = this.sessions.get(`${target.project.id}:${id}`);
          if (bound) { bound.sides = []; if (['running', 'starting', 'pending'].includes(bound.session.state)) bound.session = { ...bound.session, state: 'exited' }; }
        }
        this.status = '会话日志已结束；游戏状态可在会话树中刷新确认。';
      }
      this.append({ source: 'system', label: target.project.label, text: event.kind === 'end' ? '日志已排空，会话已结束。' : `日志文件已重置：${event.source}` });
    }
  }
  private append(entry: Transcript): void {
    if (this.disposed) return;
    entry.text = entry.text.slice(-256 * 1024);
    this.transcript.push({ ...entry, id: ++this.sequence }); this.transcriptSize += entry.text.length;
    while (this.transcript.length > 500 || this.transcriptSize > 512 * 1024) this.transcriptSize -= this.transcript.shift()!.text.length;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.publish(); }, 200);
  }
  private publish(): void {
    if (this.disposed || !this.view?.visible) return;
    const entries = this.transcript.filter(entry => entry.id > this.lastSent);
    void this.view.webview.postMessage({ type: 'state', sessions: [...this.sessions.values()].map(bound => ({
      key: bound.key, label: `${bound.target.project.label} · ${bound.session.role ?? bound.session.id.slice(0, 8)} · ${bound.session.state}`, sides: bound.sides
    })), selected: this.selected, busy: this.busy, status: this.status, entries,
      firstId: this.transcript[0]?.id ?? this.sequence + 1 });
    this.lastSent = this.sequence;
  }
  private async refreshCapabilities(): Promise<void> {
    const bound = this.selected ? this.sessions.get(this.selected) : undefined;
    if (!bound) return;
    try { bound.sides = (await this.workbench.capabilities(bound.target)).pythonSides; }
    catch (reason) { bound.sides = []; this.status = reason instanceof Error ? reason.message : String(reason); }
    this.publish();
  }
  async executeSnippet(key: string, side: Side, code: string): Promise<OperationResult | undefined> {
    if (!vscode.workspace.isTrusted || this.disposed) return undefined;
    const bound = this.sessions.get(key);
    if (!bound || this.busy || !['client', 'server'].includes(side) || !code.trim() || code.length > 32768) return undefined;
    this.busy = true; this.publish();
    const label = `${bound.target.project.label} · ${bound.session.role ?? bound.session.id.slice(0, 8)} · ${side}`;
    this.append({ source: 'python', label, text: `>>> ${code}` });
    try {
      const result = await this.workbench.execute(bound.target, side, code);
      this.append({ source: 'python', label, text: [result.stdout, result.stderr,
        result.value !== undefined ? `结果：${JSON.stringify(result.value, null, 2)}` : '', result.error,
        `状态：${result.state ?? (result.ok ? 'completed' : 'failed')}${result.requestId ? ` · request_id=${result.requestId}` : ''}`, result.hint].filter(Boolean).join('\n') });
      return result;
    } catch (reason) {
      this.append({ source: 'python', label, text: `${reason instanceof Error ? reason.message : String(reason)}${reason && typeof reason === 'object' && 'hint' in reason ? `\n${String(reason.hint)}` : ''}` });
      return undefined;
    } finally { this.busy = false; this.publish(); }
  }
  private async onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object' || !('type' in message) || this.disposed) return;
    const data = message as Record<string, unknown>;
    if (data.type === 'ready') { this.lastSent = 0; this.publish(); }
    else if (data.type === 'select' && typeof data.key === 'string' && this.sessions.has(data.key)) {
      this.selected = data.key; await this.refreshCapabilities();
    } else if (data.type === 'execute' && typeof data.key === 'string' && typeof data.code === 'string' && (data.side === 'client' || data.side === 'server')) {
      await this.executeSnippet(data.key, data.side, data.code);
    } else if (data.type === 'clear') { this.transcript = []; this.transcriptSize = 0; this.publish(); }
    else if (data.type === 'refresh') await this.refreshCapabilities();
    else if (data.type === 'reconnect') {
      const bound = this.selected ? this.sessions.get(this.selected) : undefined;
      if (bound) {
        try {
          await this.attach(this.workbench.coordinatedTarget(bound.target.project, bound.session), await this.workbench.inspect(bound.target.project));
        } catch (reason) { this.status = reason instanceof Error ? reason.message : String(reason); this.publish(); }
      }
    }
    else if (data.type === 'disconnect') {
      for (const value of this.subscriptions.values()) value.subscription.dispose();
      this.subscriptions.clear(); this.status = '已断开日志，游戏保持运行。'; this.publish();
    }
  }
  getState(): { selected?: string; sessions: number; transcript: readonly Transcript[]; busy: boolean } {
    return { selected: this.selected, sessions: this.sessions.size, transcript: this.transcript, busy: this.busy };
  }
  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const value of this.subscriptions.values()) value.subscription.dispose();
    for (const value of this.channels.values()) value.output.dispose();
    this.registration.dispose();
  }
}
