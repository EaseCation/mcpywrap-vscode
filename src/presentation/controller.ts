import * as vscode from 'vscode';
import { ProjectDiscovery } from '../application/ports';
import { Workbench } from '../application/workbench';
import { OperationResult, Project, Session, Side, Target, ToolFailure } from '../domain/model';
import { WorkspaceNode, WorkspaceTree } from './tree';
import { RuntimeConsole } from './runtimeConsole';

const EXCLUDED_DIRECTORIES = ['.git', '.mcpy', '.runtime', '.venv', 'venv', 'env', 'node_modules',
  'build', 'dist', 'out', 'outputs', '__pycache__', '.cache', '.local', '.local-notes', '.vscode-test'];
const MANIFEST_EXCLUDE = `**/{${EXCLUDED_DIRECTORIES.join(',')}}/**`;
const MANIFEST_LIMIT = 2000;

export class WorkbenchController implements vscode.Disposable {
  readonly tree = new WorkspaceTree();
  private projects: readonly Project[] = [];
  private readonly fileProjects = new Map<string, Project | undefined>();
  private readonly output = vscode.window.createOutputChannel('mcpy · 操作结果');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  private readonly disposables: vscode.Disposable[] = [];
  private selected?: { project: Project; session: Session; side: Side };
  private refreshing?: Promise<void>;
  private discovering?: Promise<void>;
  private discoveryRevision = 0;
  private discoveredRevision = -1;
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly workbench: Workbench, private readonly discovery: ProjectDiscovery,
    private readonly unsupportedReason?: string, private readonly consolePanel?: RuntimeConsole) {
    this.status.text = '$(beaker) mcpy · 选择目标';
    this.status.command = 'mcpy.selectTarget'; this.status.show();
    this.disposables.push(vscode.window.createTreeView('mcpy.sessions', { treeDataProvider: this.tree }));
    const register = (name: string, action: (node?: WorkspaceNode, resource?: vscode.Uri) => Promise<unknown>) => {
      this.disposables.push(vscode.commands.registerCommand(`mcpy.${name}`, async (argument?: unknown) => {
        try {
          this.ensureSupported();
          let node = argument instanceof WorkspaceNode ? argument : undefined;
          if (argument instanceof vscode.Uri) {
            await this.ensureProjects();
            const project = argument.scheme === 'file' ? this.discovery.containing(this.projects, argument.fsPath) : undefined;
            if (!project) throw new ToolFailure('rejected', '此文件不属于已识别的 mcpy 项目。');
            node = new WorkspaceNode('project', project.label, project);
          }
          return await action(node, argument instanceof vscode.Uri ? argument : undefined);
        } catch (error) { this.reportError(error); return undefined; }
      }));
    };
    register('refresh', () => { this.discoveryRevision++; return this.refresh(); });
    register('run', node => this.run(node));
    register('newWorld', node => this.run(node, true));
    register('runTwoClients', node => this.run(node, false, 2));
    register('stop', node => this.stop(node));
    register('logs', node => this.logs(node));
    register('console', node => this.openConsole(node));
    register('selectTarget', async node => { await this.pickPythonTarget(await this.pickProject(node)); });
    register('executeSelection', (node, resource) => this.executeSelection(node, resource));
    register('reloadFile', (node, resource) => this.reloadFile(node, resource));
    register('doctor', async node => {
      const project = await this.pickProject(node);
      if (project) this.showResult('检查运行环境', { project, id: '', kind: 'session' }, await this.progress('检查运行环境', () => this.workbench.diagnose(project)));
    });
    this.disposables.push(vscode.commands.registerCommand('mcpy.configure', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'mcpy.executable')));
    this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.updateEditorContext()));
    this.disposables.push(vscode.workspace.onDidOpenTextDocument(() => this.updateEditorContext()),
      vscode.workspace.onDidCloseTextDocument(document => { this.fileProjects.delete(document.uri.toString()); this.updateEditorContext(); }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document.uri.path.endsWith('/pyproject.toml')) this.onManifestChange(document.uri);
      }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.invalidateProjects()));
    this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('mcpy')) this.invalidateProjects();
    }));
    const watcher = vscode.workspace.createFileSystemWatcher('**/pyproject.toml');
    this.disposables.push(watcher,
      watcher.onDidCreate(uri => this.onManifestChange(uri)),
      watcher.onDidChange(uri => this.onManifestChange(uri)),
      watcher.onDidDelete(uri => this.onManifestChange(uri)));
    // VS Code may coalesce a removed directory into a single delete event,
    // without reporting its pyproject.toml. Observe deletes only, then compare
    // against cached project paths; do not react to ordinary file writes.
    const directories = vscode.workspace.createFileSystemWatcher('**', false, true, false);
    this.disposables.push(directories, directories.onDidDelete(uri => {
      const removed = uri.path.toLowerCase().replace(/\/$/, '');
      if (this.projects.some(project => [project.root, project.workspaceRoot].some(directory => {
        if (!directory) return false;
        const root = vscode.Uri.file(directory).path.toLowerCase();
        return root === removed || root.startsWith(`${removed}/`);
      }))) this.invalidateProjects();
    }), directories.onDidCreate(uri => { void this.onCreatedPath(uri); }),
      vscode.workspace.onDidCreateFiles(event => {
        for (const uri of event.files) if (uri.path.endsWith('/pyproject.toml')) this.onManifestChange(uri);
      }), vscode.workspace.onDidDeleteFiles(event => {
        for (const uri of event.files) if (uri.path.endsWith('/pyproject.toml')) this.onManifestChange(uri);
      }));
  }
  get projectCount(): number { return this.projects.length; }
  get activeProjectId(): string | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri ? this.projectForFile(uri)?.id : undefined;
  }
  private projectForFile(uri: vscode.Uri): Project | undefined {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) return undefined;
    const key = uri.toString();
    if (!this.fileProjects.has(key)) this.fileProjects.set(key, this.discovery.containing(this.projects, uri.fsPath));
    return this.fileProjects.get(key);
  }
  async initialize(): Promise<void> { await this.ensureProjects(); }
  private updateEditorContext(): void {
    if (this.disposed) return;
    void vscode.commands.executeCommand('setContext', 'mcpy.activeProject',
      !this.unsupportedReason && vscode.workspace.isTrusted && this.activeProjectId !== undefined);
    const files: string[] = [];
    if (!this.unsupportedReason && vscode.workspace.isTrusted) {
      for (const document of vscode.workspace.textDocuments) {
        if (this.projectForFile(document.uri)) {
          files.push(document.uri.fsPath, document.uri.path);
        }
      }
    }
    void vscode.commands.executeCommand('setContext', 'mcpy.projectFiles', files);
  }
  private onManifestChange(uri: vscode.Uri): void {
    if (!this.isProjectCandidate(uri)) return;
    this.invalidateProjects();
  }
  private isProjectCandidate(uri: vscode.Uri): boolean {
    if (this.disposed || uri.scheme !== 'file') return false;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return !!folder && !uri.path.slice(folder.uri.path.length).split('/')
      .some(part => EXCLUDED_DIRECTORIES.includes(part));
  }
  private async onCreatedPath(uri: vscode.Uri): Promise<void> {
    if (!this.isProjectCandidate(uri) || uri.path.endsWith('/pyproject.toml')) return;
    try {
      if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
        // A parent-directory event can subsume all its newly written files.
        // The shared debounce collapses bursts; ordinary file edits are ignored.
        this.invalidateProjects();
      }
    } catch { /* The new path can disappear again before the event is processed. */ }
  }
  private invalidateProjects(): void {
    this.discoveryRevision++;
    // Hide stale actions until declarations have been rechecked. No game query.
    void vscode.commands.executeCommand('setContext', 'mcpy.activeProject', false);
    void vscode.commands.executeCommand('setContext', 'mcpy.projectFiles', []);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => { void this.ensureProjects(); }, 250);
  }
  private async ensureProjects(): Promise<void> {
    if (this.disposed || this.discoveredRevision === this.discoveryRevision) return;
    if (this.discovering) { await this.discovering; return this.ensureProjects(); }
    this.discovering = this.discoverProjects().finally(() => { this.discovering = undefined; });
    await this.discovering;
    if (this.discoveredRevision !== this.discoveryRevision) await this.ensureProjects();
  }
  private async discoverProjects(): Promise<void> {
    const revision = this.discoveryRevision;
    if (this.unsupportedReason || !vscode.workspace.isTrusted) {
      this.projects = []; this.tree.setProjects([], [this.unsupportedReason ?? '请先信任工作区。']);
      this.discoveredRevision = revision; this.updateEditorContext(); return;
    }
    try {
      const issues: string[] = [];
      const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
        .map(async folder => {
          const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/pyproject.toml'), MANIFEST_EXCLUDE, MANIFEST_LIMIT);
          if (files.length === MANIFEST_LIMIT) issues.push(`${folder.name}：已达到 ${MANIFEST_LIMIT} 个声明文件上限，请缩小工作区。`);
          return { root: folder.uri.fsPath, manifests: files.map(uri => uri.fsPath) };
        }));
      const found = await this.discovery.discover(roots);
      if (this.disposed) return;
      if (revision !== this.discoveryRevision) return;
      this.projects = found.projects;
      this.fileProjects.clear();
      this.tree.setProjects(this.projects, [...issues, ...found.issues]);
      if (this.selected && !this.projects.some(p => p.id === this.selected?.project.id)) this.clearSelection();
      this.discoveredRevision = revision; this.updateEditorContext();
    } catch (error) {
      this.discoveredRevision = revision;
      if (!this.disposed) this.reportError(error);
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async doRefresh(): Promise<void> {
    if (this.disposed) return;
    await this.ensureProjects();
    // Bound subprocess concurrency even for workspaces containing many projects.
    const pending = [...this.projects];
    await Promise.allSettled(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (pending.length && !this.disposed) { const project = pending.shift(); if (project) await this.refreshProject(project); }
    }));
  }
  private async refreshProject(project: Project): Promise<void> {
    if (this.disposed) return;
    this.tree.update(project, { loading: true });
    try {
      const snapshot = await this.workbench.inspect(project);
      if (this.disposed) return;
      this.tree.update(project, { snapshot, error: undefined, loading: false });
      if (this.selected?.project.id === project.id && !snapshot.sessions.some(s => s.id === this.selected?.session.id && s.state === 'running')) this.clearSelection();
    } catch (error) {
      if (!this.disposed) this.tree.update(project, { error: error instanceof Error ? error.message : String(error), loading: false });
    }
  }
  private async pickProject(node?: WorkspaceNode): Promise<Project | undefined> {
    await this.ensureProjects();
    if (node?.project) return this.projects.find(p => p.id === node.project?.id);
    const editor = vscode.window.activeTextEditor;
    const containing = editor && editor.document.uri.scheme === 'file'
      ? this.discovery.containing(this.projects, editor.document.uri.fsPath) : undefined;
    if (containing) return containing;
    if (this.projects.length === 1) return this.projects[0];
    if (!this.projects.length) throw new ToolFailure('rejected', '未发现 mcpy 项目。', '打开包含 [tool.mcpywrap] 声明的 pyproject.toml 项目。');
    return (await vscode.window.showQuickPick(this.projects.map(project => ({
      label: project.label, description: project.root, project
    })), { title: '选择项目', matchOnDescription: true }))?.project;
  }
  private async pickSession(project: Project): Promise<Session | undefined> {
    await this.refreshProject(project);
    const state = this.tree.states.get(project.id);
    if (state?.error) throw new ToolFailure('queryFailed', state.error, '会话列表无法确认，请检查 CLI 后刷新。');
    const sessions = state?.snapshot?.sessions.filter(s => s.state === 'running') ?? [];
    if (!sessions.length) throw new ToolFailure('rejected', '此项目没有运行中的会话。', '先运行测试，或刷新找回已有会话。');
    return (await vscode.window.showQuickPick(sessions.map(session => ({
      label: `${session.role ?? '会话'} · ${session.id.slice(0, 8)}`,
      description: `${project.label} · ${session.mode} · ${session.state}`,
      detail: `${project.root} · ${session.id}${session.group ? ` · 组 ${session.group}` : ''}`,
      session, picked: this.selected?.project.id === project.id && this.selected.session.id === session.id
    })), { title: '选择执行会话', matchOnDescription: true, matchOnDetail: true }))?.session;
  }
  private async pickPythonTarget(project?: Project, reload = false): Promise<{ target: Target; session: Session; side: Side } | undefined> {
    if (!project) return undefined;
    const session = await this.pickSession(project); if (!session) return undefined;
    const target: Target = { project, id: session.id, kind: 'session' };
    const caps = await this.workbench.capabilities(target);
    const available = reload ? caps.pythonReload ? caps.reloadSides : [] : caps.pythonSides;
    if (!available.length) throw new ToolFailure('rejected', '此会话当前没有可用的 Python 端侧。', '检查游戏就绪状态和运行包能力。');
    const side = (await vscode.window.showQuickPick(available.map(value => ({
      label: value === 'client' ? '客户端 · client' : '服务端 · server', side: value,
      description: `${project.label} · ${session.role ?? session.id.slice(0, 8)}`
    })), { title: reload ? '选择热更端侧' : '选择执行端侧' }))?.side;
    if (!side) return undefined;
    this.selected = { project, session, side };
    this.status.text = `$(beaker) mcpy · ${project.label} · ${session.role ?? session.id.slice(0, 8)} · ${side}`;
    this.status.tooltip = `${project.root}\n${session.id}\n${side}`;
    return { target, session, side };
  }
  private async run(node?: WorkspaceNode, newWorld = false, clients: 1 | 2 = 1): Promise<OperationResult | undefined> {
    const project = await this.pickProject(node); if (!project) return undefined;
    const world = node?.kind === 'world' && !newWorld ? node.value?.id : undefined;
    const result = await this.progress(`运行测试 · ${project.label}`, () => this.workbench.start(project, { world, newWorld, clients }));
    this.showResult('运行测试', { project, id: result.group ?? result.session ?? '', kind: result.group ? 'group' : 'session' }, result);
    await this.refreshProject(project);
    const snapshot = this.tree.states.get(project.id)?.snapshot;
    if (snapshot && this.consolePanel) await this.consolePanel.attach({ project, id: result.group ?? result.session!, kind: result.group ? 'group' : 'session' }, snapshot);
    return result;
  }
  private async openConsole(node?: WorkspaceNode): Promise<void> {
    const target = await this.pickManagementTarget(node);
    if (!target || !this.consolePanel) return;
    const snapshot = this.tree.states.get(target.project.id)?.snapshot;
    if (snapshot) await this.consolePanel.attach(target, snapshot);
  }
  private async pickManagementTarget(node?: WorkspaceNode): Promise<Target | undefined> {
    const project = await this.pickProject(node); if (!project) return undefined;
    await this.refreshProject(project);
    if (node?.target) return node.target;
    const state = this.tree.states.get(project.id);
    if (state?.error) throw new ToolFailure('queryFailed', state.error);
    const snapshot = state?.snapshot;
    const targets: { label: string; description: string; target: Target }[] = [
      ...(snapshot?.groups ?? []).map(g => ({ label: `联调组 · ${g.id.slice(0, 8)}`, description: g.state, target: { project, kind: 'group' as const, id: g.id } })),
      ...(snapshot?.sessions ?? []).filter(s => !s.group).map(s => ({ label: `会话 · ${s.id.slice(0, 8)}`, description: s.state, target: { project, kind: 'session' as const, id: s.id } }))
    ];
    if (!targets.length) throw new ToolFailure('rejected', '此项目还没有会话。');
    return (await vscode.window.showQuickPick(targets, { title: '选择会话或联调组' }))?.target;
  }
  private async stop(node?: WorkspaceNode): Promise<OperationResult | undefined> {
    let target = await this.pickManagementTarget(node); if (!target) return undefined;
    const session = this.tree.states.get(target.project.id)?.snapshot?.sessions.find(s => s.id === target?.id);
    if (target.kind === 'session' && session?.group) target = this.workbench.coordinatedTarget(target.project, session);
    if (target.kind === 'group') {
      const chosen = await vscode.window.showWarningMessage(`停止整个联调组 ${target.id.slice(0, 8)}（${target.project.label}）及其成员？`, { modal: true }, '停止整组');
      if (chosen !== '停止整组') return undefined;
    }
    const selected = target;
    const result = await this.progress(`停止 · ${selected.project.label}`, () => this.workbench.stop(selected));
    this.showResult('停止', selected, result); await this.refreshProject(selected.project); return result;
  }
  private async logs(node?: WorkspaceNode): Promise<string | undefined> {
    const target = await this.pickManagementTarget(node); if (!target) return undefined;
    const choice = await vscode.window.showQuickPick((['game', 'engine', 'worker'] as const).map(source => ({ label: source, source })), { title: '选择日志来源' });
    if (!choice) return undefined;
    const source = choice.source;
    const text = await this.progress('读取日志快照', () => this.workbench.logs(target, source));
    if (this.consolePanel) this.consolePanel.showSnapshot(target, source, text);
    else { this.output.appendLine(text); this.output.show(true); }
    return text;
  }
  private async executeSelection(node?: WorkspaceNode, resource?: vscode.Uri): Promise<OperationResult | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python' || editor.selection.isEmpty) throw new ToolFailure('rejected', '请在 Python 编辑器中选择要执行的代码。');
    if (resource && resource.toString() !== editor.document.uri.toString()) throw new ToolFailure('rejected', '请先选中该编辑器中的 Python 代码。');
    const code = editor.document.getText(editor.selection);
    const picked = await this.pickPythonTarget(await this.pickProject(node)); if (!picked) return undefined;
    if (this.consolePanel) return this.consolePanel.executeInSession(picked.target, picked.session, picked.side, code);
    const result = await this.progress(`执行 Python · ${picked.side}`, () => this.workbench.execute(picked.target, picked.side, code));
    this.showResult(`执行 Python · ${picked.side}`, picked.target, result); return result;
  }
  private async reloadFile(node?: WorkspaceNode, resource?: vscode.Uri): Promise<OperationResult | undefined> {
    const document = resource ? await vscode.workspace.openTextDocument(resource) : vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== 'python' || document.uri.scheme !== 'file') throw new ToolFailure('rejected', '请打开项目内的 Python 文件。');
    if (document.isDirty) throw new ToolFailure('rejected', '请先保存文件，再热更模块。');
    const project = await this.pickProject(node); if (!project) return undefined;
    if (this.discovery.containing(this.projects, document.uri.fsPath)?.id !== project.id) throw new ToolFailure('rejected', '文件不属于所选项目；请从对应项目打开源码。');
    const picked = await this.pickPythonTarget(project, true); if (!picked) return undefined;
    const target = this.workbench.coordinatedTarget(project, picked.session);
    const result = await this.progress(`热更 Python · ${picked.side}`, () => this.workbench.reload(target, picked.side, document.uri.fsPath));
    this.showResult(`热更 Python · ${picked.side}`, target, result); return result;
  }
  private showResult(action: string, target: Target, result: OperationResult): void {
    if (this.disposed) return;
    this.output.appendLine(`\n${action} · ${target.project.root} · ${target.kind} ${target.id}`);
    this.output.appendLine(JSON.stringify(result.details, null, 2)); this.output.show(true);
    const successful = result.ok && result.state !== 'unknown' && result.state !== 'partial' && result.state !== 'failed';
    const label = `${action}：${result.state ?? (successful ? '已返回结果' : '失败')}`;
    if (successful) void vscode.window.showInformationMessage(label);
    else void vscode.window.showWarningMessage(`${label}${result.error ? ` · ${result.error}` : ''}。详情见操作结果。`);
  }
  private reportError(error: unknown): void {
    if (this.disposed) return;
    const message = error instanceof Error ? error.message : String(error);
    this.output.appendLine(`\n错误：${message}`);
    if (error instanceof ToolFailure) {
      this.output.appendLine(`类型：${error.kind}\n${error.hint ?? ''}`);
      if (error.details) this.output.appendLine(JSON.stringify(error.details, null, 2));
    }
    void vscode.window.showErrorMessage(`${message}${error instanceof ToolFailure && error.hint ? ` ${error.hint}` : ''}`);
    this.output.show(true);
  }
  private progress<T>(title: string, action: () => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, action));
  }
  private ensureSupported(): void {
    if (this.unsupportedReason) throw new ToolFailure('rejected', this.unsupportedReason);
    if (!vscode.workspace.isTrusted) throw new ToolFailure('rejected', '请先信任工作区。');
  }
  private clearSelection(): void { this.selected = undefined; this.status.text = '$(beaker) mcpy · 选择目标'; this.status.tooltip = undefined; }
  dispose(): void {
    this.disposed = true;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    void vscode.commands.executeCommand('setContext', 'mcpy.activeProject', false);
    void vscode.commands.executeCommand('setContext', 'mcpy.projectFiles', []);
    for (const disposable of this.disposables) disposable.dispose();
    this.tree.dispose(); this.output.dispose(); this.status.dispose();
  }
}
