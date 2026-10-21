import * as vscode from 'vscode';
import { Workbench } from '../application/workbench';
import { LogSubscription } from '../application/ports';
import { LogHistory, LogLines, LogPart, LogRecord, logPart, renderRecord } from '../application/logHistory';
import { LogEvent, LogSource, OperationResult, Session, Side, Snapshot, Target } from '../domain/model';

interface BoundSession { key: string; target: Target; session: Session }
interface Draft { key: string; side: Side }
interface Subscription { target: Target; subscription: LogSubscription; members: Set<string> }
const SOURCE_LABEL: Record<LogSource, string> = { engine: '引擎', game: '脚本系统', worker: '启动器' };
const memberName = (session: Session) => `${session.role ? session.role + ' ' : ''}${session.id.slice(0, 8)}`;

/** Native Output + native Python scratch editors. No custom frontend. */
export class RuntimeConsole implements vscode.Disposable {
  private readonly sessions = new Map<string, BoundSession>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly lines = new Map<string, { reader: LogLines; source: LogSource; label: string; projectId: string; session: string }>();
  private readonly histories = { engine: new LogHistory(), script: new LogHistory() };
  private readonly channels = {
    engine: vscode.window.createOutputChannel('mcpy · 引擎', 'mcpy-log'),
    script: vscode.window.createOutputChannel('mcpy · 脚本系统', 'mcpy-log')
  };
  private readonly outputSize = { engine: 0, script: 0 };
  private readonly queued = { engine: '', script: '' };
  private readonly replayNeeded = new Set<LogPart>();
  private readonly drafts = new Map<string, Draft>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  private readonly disposables: vscode.Disposable[] = [];
  private selected?: string;
  private raw = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private busy = false;

  constructor(private readonly workbench: Workbench) {
    this.status.command = 'mcpy.changeSnippetTarget';
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateDraftContext()),
      vscode.workspace.onDidCloseTextDocument(document => { this.drafts.delete(document.uri.toString()); this.updateDraftContext(); }));
    const command = (name: string, action: (resource?: vscode.Uri) => unknown) => this.disposables.push(vscode.commands.registerCommand(`mcpy.${name}`, async (argument?: unknown) => {
      try { return await action(argument instanceof vscode.Uri ? argument : undefined); }
      catch (reason) { this.report(reason); return undefined; }
    }));
    command('showEngineLog', () => this.show('engine'));
    command('showScriptLog', () => this.show('script'));
    command('switchLog', async () => {
      const choice = await vscode.window.showQuickPick([{ label: '引擎', part: 'engine' as const }, { label: '脚本系统', part: 'script' as const }], { title: '切换日志来源' });
      if (choice) this.show(choice.part);
    });
    command('toggleLogDetails', () => { this.raw = !this.raw; this.replay('engine'); this.replay('script'); });
    command('disconnectLogs', () => this.disconnect());
    command('newSnippet', () => this.openSnippet());
    command('runSnippet', resource => this.runDraft(resource));
    command('changeSnippetTarget', () => this.changeDraftTarget());
  }
  async attach(target: Target, snapshot: Snapshot): Promise<void> {
    const members = target.kind === 'group' ? snapshot.groups.find(group => group.id === target.id)?.members ?? [] : [target.id];
    const matched = snapshot.sessions.filter(session => members.includes(session.id));
    for (const session of matched) {
      const key = `${target.project.id}:${session.id}`;
      this.sessions.set(key, { key, target: { project: target.project, kind: 'session', id: session.id }, session });
    }
    const preferred = matched.find(session => session.id === target.id) ?? matched[0];
    if (preferred) this.selected = `${target.project.id}:${preferred.id}`;
    for (const [key, bound] of this.sessions) {
      if (this.sessions.size <= 64) break;
      if (key !== this.selected && !['running', 'starting', 'pending'].includes(bound.session.state)) this.sessions.delete(key);
    }
    const key = `${target.project.id}:${target.kind}:${target.id}`;
    if (!this.subscriptions.has(key)) {
      const allowed = new Set(members);
      for (const [otherKey, other] of this.subscriptions) {
        if (other.target.project.id === target.project.id && [...allowed].some(id => other.members.has(id))) {
          other.subscription.dispose(); this.finish(other.target.project.id, other.members); this.subscriptions.delete(otherKey);
        }
      }
      this.append({ source: 'system', label: target.project.label,
        text: '[+] 开始订阅引擎/脚本系统日志（包含近期历史，重新连接可能重叠）。\n', visible: true });
      const subscription = this.workbench.followLogs(target, event => this.onLog(target, allowed, event), reason => {
        this.subscriptions.delete(key); this.finish(target.project.id, allowed); this.report(reason);
      });
      this.subscriptions.set(key, { target, subscription, members: allowed });
      void subscription.done.then(() => {
        if (this.subscriptions.get(key)?.subscription === subscription) this.subscriptions.delete(key);
        this.updateRuntimeContext();
      });
    }
    this.updateRuntimeContext(); this.show('script');
  }
  private onLog(target: Target, members: Set<string>, event: LogEvent): void {
    if (this.disposed) return;
    if (event.kind !== 'end' && !members.has(event.session)) {
      this.report(new Error('日志成员已变化，请重新连接目标。')); return;
    }
    if (event.kind === 'log') {
      const key = `${target.project.id}:${event.session}:${event.source}`;
      let stream = this.lines.get(key);
      if (!stream) {
        stream = { reader: new LogLines(), source: event.source, projectId: target.project.id, session: event.session,
          label: `${target.project.label} · ${event.role ? event.role + ' ' : ''}${event.session.slice(0, 8)} · ${SOURCE_LABEL[event.source]}` };
        this.lines.set(key, stream);
      }
      for (const line of stream.reader.feed(event.text)) this.append({ source: stream.source, label: stream.label, ...line });
    } else if (event.kind === 'state') {
      const bound = this.sessions.get(`${target.project.id}:${event.session}`);
      if (bound) bound.session = { ...bound.session, state: event.state };
      this.append({ source: 'system', label: `${target.project.label} · ${event.role ?? ''} ${event.session.slice(0, 8)}`,
        text: `会话状态：${event.state}\n`, visible: true });
    } else if (event.kind === 'reset') {
      const key = `${target.project.id}:${event.session}:${event.source}`;
      const previous = this.lines.get(key);
      if (previous) {
        for (const line of previous.reader.feed('', true)) this.append({ source: previous.source, label: previous.label, ...line });
        this.lines.delete(key);
      }
      this.append({ source: event.source, label: target.project.label, text: '日志文件已重置。\n', visible: true });
    } else {
      this.finish(target.project.id, members);
      this.append({ source: 'system', label: target.project.label, text: '[-] 会话日志已排空。\n', visible: true });
    }
  }
  private finish(projectId: string, members: Set<string>): void {
    for (const [key, stream] of this.lines) {
      if (stream.projectId !== projectId || !members.has(stream.session)) continue;
      for (const line of stream.reader.feed('', true)) this.append({ source: stream.source, label: stream.label, ...line });
      this.lines.delete(key);
    }
  }
  private append(record: LogRecord): void {
    if (this.disposed) return;
    const part = logPart(record.source);
    this.histories[part].append(record);
    if (this.raw || record.visible) {
      this.queued[part] += renderRecord(record);
      if (this.queued[part].length > 512 * 1024) { this.queued[part] = ''; this.replayNeeded.add(part); }
    }
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 100);
  }
  private flush(): void {
    for (const part of ['engine', 'script'] as const) {
      if (this.replayNeeded.has(part) || this.outputSize[part] + this.queued[part].length > 4 * 1024 * 1024) this.replay(part);
      else if (this.queued[part]) {
        this.channels[part].append(this.queued[part]); this.outputSize[part] += this.queued[part].length; this.queued[part] = '';
      }
    }
  }
  private replay(part: LogPart): void {
    const text = this.histories[part].snapshot(this.raw);
    this.channels[part].replace(text); this.outputSize[part] = text.length;
    this.queued[part] = ''; this.replayNeeded.delete(part);
  }
  show(part: LogPart): void { if (!this.disposed) { this.flush(); this.channels[part].show(true); } }
  showSnapshot(target: Target, source: LogSource, text: string): void {
    const reader = new LogLines();
    const label = `${target.project.label} · ${target.id.slice(0, 8)} · ${SOURCE_LABEL[source]}快照`;
    for (const line of reader.feed(text, true)) this.append({ source, label, ...line });
    this.show(logPart(source));
  }
  private disconnect(): void {
    for (const value of this.subscriptions.values()) { value.subscription.dispose(); this.finish(value.target.project.id, value.members); }
    this.subscriptions.clear(); this.updateRuntimeContext();
    this.append({ source: 'system', label: 'mcpy', text: '[-] 已断开日志订阅，游戏保持运行。\n', visible: true });
  }
  private async chooseDraft(): Promise<Draft | undefined> {
    if (!vscode.workspace.isTrusted) return undefined;
    const bound = (await vscode.window.showQuickPick([...this.sessions.values()].filter(value => ['running', 'starting'].includes(value.session.state))
      .map(value => ({ label: `${value.target.project.label} · ${memberName(value.session)}`, description: value.session.state,
        detail: `${value.target.project.root} · ${value.target.id}`, bound: value })), { title: '选择运行时 Python 会话', matchOnDetail: true }))?.bound;
    if (!bound) return undefined;
    const caps = await this.workbench.capabilities(bound.target);
    if (!caps.pythonSides.length) throw new Error('此会话没有可用的 Python 端侧；游戏就绪后请重新选择。');
    const side = (await vscode.window.showQuickPick(caps.pythonSides.map(side => ({
      label: side === 'client' ? '客户端 · client' : '服务端 · server', side
    })), { title: '选择执行端侧' }))?.side;
    return side ? { key: bound.key, side } : undefined;
  }
  async openSnippet(): Promise<void> {
    if (!this.sessions.size) throw new Error('请先启动测试，或连接已有会话日志。');
    const draft = await this.chooseDraft(); if (!draft) return;
    const document = await vscode.workspace.openTextDocument({ language: 'python', content:
      '# 运行时 Python：点击右上角运行，或按 Ctrl/⌘+Enter。\n# 目标显示在状态栏；点击状态栏可切换会话和端侧。\n1 + 1\n' });
    this.drafts.set(document.uri.toString(), draft);
    await vscode.window.showTextDocument(document, { preview: false }); this.updateDraftContext();
  }
  private async changeDraftTarget(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !this.drafts.has(document.uri.toString())) return;
    const draft = await this.chooseDraft(); if (draft) this.drafts.set(document.uri.toString(), draft);
    this.updateDraftContext();
  }
  private async runDraft(resource?: vscode.Uri): Promise<OperationResult | undefined> {
    const editor = vscode.window.activeTextEditor;
    const document = resource ? await vscode.workspace.openTextDocument(resource) : editor?.document;
    const draft = document ? this.drafts.get(document.uri.toString()) : undefined;
    if (!document || !draft) throw new Error('请先打开运行时 Python 草稿。');
    const selectedCode = editor?.document.uri.toString() === document.uri.toString() && !editor.selection.isEmpty ? document.getText(editor.selection) : document.getText();
    return this.executeSnippet(draft.key, draft.side, selectedCode);
  }
  private updateDraftContext(): void {
    const document = vscode.window.activeTextEditor?.document;
    const draft = document ? this.drafts.get(document.uri.toString()) : undefined;
    const bound = draft ? this.sessions.get(draft.key) : undefined;
    void vscode.commands.executeCommand('setContext', 'mcpy.snippetActive', !!draft && !!bound);
    void vscode.commands.executeCommand('setContext', 'mcpy.snippetFiles', [...this.drafts.keys()].map(key => vscode.Uri.parse(key).path));
    if (draft && bound) {
      this.status.text = `$(terminal) Python · ${bound.target.project.label} · ${memberName(bound.session)} · ${draft.side}`;
      this.status.tooltip = `${bound.target.project.root}\n${bound.target.id}\n点击切换执行目标`;
      this.status.show();
    } else this.status.hide();
  }
  private updateRuntimeContext(): void {
    void vscode.commands.executeCommand('setContext', 'mcpy.hasRuntime', !this.disposed && this.sessions.size > 0);
  }
  async executeSnippet(key: string, side: Side, code: string): Promise<OperationResult | undefined> {
    if (!vscode.workspace.isTrusted || this.disposed || this.busy) return undefined;
    const bound = this.sessions.get(key);
    if (!bound || !['client', 'server'].includes(side) || !code.trim()) return undefined;
    if (code.length > 32768) throw new Error('片段超过 32 Ki 字符，请缩小执行范围。');
    this.busy = true;
    const label = `${bound.target.project.label} · ${memberName(bound.session)} · ${side}`;
    this.append({ source: 'python', label, text: `>>> ${code}\n`, visible: true });
    try {
      const result = await this.workbench.execute(bound.target, side, code);
      const text = [result.stdout, result.stderr,
        result.value !== undefined ? `结果：${JSON.stringify(result.value, null, 2)}` : '', result.error ? `Error: ${result.error}` : '',
        `状态：${result.state ?? (result.ok ? 'completed' : 'failed')}${result.requestId ? ` · request_id=${result.requestId}` : ''}`, result.hint].filter(Boolean).join('\n') + '\n';
      this.append({ source: 'python', label, text, visible: true }); this.show('script');
      return result;
    } catch (reason) { this.report(reason, label, 'python'); return undefined; }
    finally { this.busy = false; }
  }
  executeInSession(target: Target, session: Session, side: Side, code: string): Promise<OperationResult | undefined> {
    const key = `${target.project.id}:${session.id}`;
    this.sessions.set(key, { key, target, session }); this.selected = key; this.updateRuntimeContext();
    return this.executeSnippet(key, side, code);
  }
  private report(reason: unknown, label = 'mcpy', source: 'system' | 'python' = 'system'): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    const hint = reason && typeof reason === 'object' && 'hint' in reason ? `\n${String(reason.hint)}` : '';
    this.append({ source, label, text: `[!] ${message}${hint}\n`, visible: true });
    this.show(source === 'python' ? 'script' : 'engine');
  }
  getState(): { selected?: string; sessions: number; transcript: readonly LogRecord[]; busy: boolean; channels: readonly string[]; raw: boolean; displayed: { engine: string; script: string } } {
    return { selected: this.selected, sessions: this.sessions.size,
      transcript: [...this.histories.engine.entries(), ...this.histories.script.entries()], busy: this.busy,
      channels: [this.channels.engine.name, this.channels.script.name], raw: this.raw,
      displayed: { engine: this.histories.engine.snapshot(this.raw), script: this.histories.script.snapshot(this.raw) } };
  }
  dispose(): void {
    this.disconnect(); this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const value of this.disposables) value.dispose();
    for (const value of Object.values(this.channels)) value.dispose();
    this.status.dispose();
    void vscode.commands.executeCommand('setContext', 'mcpy.hasRuntime', false);
    void vscode.commands.executeCommand('setContext', 'mcpy.snippetActive', false);
    void vscode.commands.executeCommand('setContext', 'mcpy.snippetFiles', []);
  }
}
