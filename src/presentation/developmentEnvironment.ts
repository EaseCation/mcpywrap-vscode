import * as vscode from 'vscode';
import { DevelopmentHints } from '../application/developmentHints';
import { DevelopmentEnvironments } from '../application/developmentEnvironments';
import { DevelopmentSnapshot } from '../domain/developmentEnvironment';
import { Project, ToolFailure } from '../domain/model';
import { VscodePythonEnvironment } from './pythonEnvironment';

export class DevelopmentEnvironmentPanel implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('mcpy · Python 开发环境');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  private readonly cache = new Map<string, { project: Project; snapshot: DevelopmentSnapshot }>();
  private readonly subscription: vscode.Disposable;
  private active?: { project: Project; resource: vscode.Uri };
  private disposed = false;
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private hintRevision = 0;
  private fallback?: { project: Project; resource: vscode.Uri };
  private readonly automaticErrors = new Set<string>();
  constructor(private readonly environments: DevelopmentEnvironments, private readonly python: VscodePythonEnvironment, private readonly hints: DevelopmentHints) {
    this.status.command = 'mcpy.developmentEnvironment';
    this.subscription = python.onDidChange(() => { this.cache.clear(); this.hints.invalidate(); this.updateStatus(); this.scheduleHint(); });
  }
  setContext(project?: Project, resource?: vscode.Uri): void {
    this.active = project && resource ? { project, resource } : undefined;
    this.updateStatus(); this.scheduleHint();
  }
  workspaceDiscovered(projects: readonly Project[]): void {
    const project = projects[0];
    this.fallback = project ? { project, resource: vscode.Uri.joinPath(vscode.Uri.file(project.root), 'pyproject.toml') } : undefined;
    this.scheduleHint();
  }
  private scheduleHint(): void {
    const revision = ++this.hintRevision;
    if (this.timer) clearTimeout(this.timer);
    const context = this.active ?? this.fallback;
    if (!context || this.disposed || !vscode.workspace.isTrusted || vscode.env.remoteName) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.checkHint(context, revision); }, 1500);
  }
  private async checkHint(context: { project: Project; resource: vscode.Uri }, revision: number): Promise<void> {
    if (this.busy || this.disposed || revision !== this.hintRevision || !vscode.workspace.isTrusted) return;
    // Missing/disabled Python is handled by the explicit setup menu, without startup popups.
    if (!vscode.extensions.getExtension('ms-python.python')) return;
    try {
      const snapshot = await this.hints.check(context.project, context.resource.toString());
      if (!snapshot || this.disposed || this.busy || revision !== this.hintRevision) return;
      this.cache.set(context.project.id, { project: context.project, snapshot }); this.updateStatus();
      if (!this.hints.claimPrompt(snapshot)) return;
      const inherited = snapshot.inspection.installed ? '仅在继承路径发现补全库' : '未安装 ModSDK 补全库';
      const action = await vscode.window.showInformationMessage(
        `${context.project.label}：VS Code 当前 Python ${inherited}。目标：${snapshot.selection.executable}`, '安装补全库', '选择 Python 环境');
      if (!action || this.disposed || this.busy || !vscode.workspace.isTrusted) return;
      if (action === '选择 Python 环境') { await this.python.select(context.resource); return; }
      await this.open(context.project, context.resource);
    } catch (error) {
      if (this.disposed || revision !== this.hintRevision) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!this.automaticErrors.has(message)) { this.automaticErrors.add(message); this.output.appendLine(`后台补全检查：${message}；可从“Python 开发环境与补全”手动处理。`); }
    }
  }
  private updateStatus(): void {
    if (this.disposed || !this.active) { this.status.hide(); return; }
    const { project, resource } = this.active;
    const cached = this.cache.get(project.id)?.snapshot;
    const selected = this.python.current(resource.toString());
    const current = cached && selected && cached.selection.id === selected.id && cached.selection.path === selected.path ? cached : undefined;
    const sdk = current?.inspection.installed;
    this.status.text = `$(package) ModSDK · ${current ? sdk?.inEnvironment ? sdk.version : '待安装' : '检查开发环境'}`;
    this.status.tooltip = current
      ? `${project.label}\nVS Code Python：${current.selection.executable}\nPython ${current.inspection.environment.version}\nModSDK：${sdk ? `${sdk.version} · ${sdk.inEnvironment ? '此环境' : '继承自其他环境'}` : '未安装'}\n最近一次检查结果；点击重新检查 / 管理补全库`
      : `${project.label}：点击确认 VS Code 当前 Python 环境和 ModSDK 补全库`;
    this.status.show();
  }
  private write(project: Project, snapshot: DevelopmentSnapshot): void {
    const { environment: env, installed } = snapshot.inspection;
    this.output.appendLine(`\n项目：${project.label}\n文件作用域：${snapshot.resource}\nVS Code 选择：${snapshot.selection.executable}\nPython：${env.version}\n实际解释器：${env.executable}\n环境前缀：${env.prefix}\n基础环境：${env.basePrefix}\n环境标识：${env.identity}\nModSDK：${installed ? `${installed.version}\n安装位置：${installed.location}\n${installed.inEnvironment ? '已核验位于选中环境内' : '来自继承路径，尚未安装到选中环境'}` : '未安装'}\n`);
    this.output.appendLine('作用域以 Microsoft Python 实际选择为准；同一工作区文件夹内的嵌套项目可能共享解释器。');
    this.output.appendLine('这是宿主开发环境补全库，游戏继续使用引擎内置 Python。普通 .py 文件由 Python/Pylance 提供语言服务；游戏内 Python 草稿仅提供基本编辑支持。');
    if (!vscode.extensions.getExtension('ms-python.vscode-pylance')) {
      this.output.appendLine('[!] 未检测到 Pylance，请安装/启用以获得普通 Python 文件的自动补全。');
    }
    this.output.show(true);
  }
  async open(project: Project, resource: vscode.Uri): Promise<void> {
    if (this.busy) { void vscode.window.showInformationMessage('Python 开发环境操作仍在进行，请查看输出。'); return; }
    if (!vscode.extensions.getExtension('ms-python.python')) {
      const action = await vscode.window.showInformationMessage('需要 Microsoft Python 扩展来确认 VS Code 实际选用的解释器。', '打开 Python 扩展');
      if (action) await vscode.commands.executeCommand('extension.open', 'ms-python.python');
      return;
    }
    this.busy = true; this.hintRevision++; if (this.timer) clearTimeout(this.timer);
    this.hints.invalidate();
    try {
      while (!this.disposed) {
        let snapshot: DevelopmentSnapshot;
        try {
          snapshot = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '检查 VS Code Python 与 ModSDK', cancellable: false },
            () => this.environments.inspect(project, resource.toString()));
        } catch (error) {
          this.cache.delete(project.id); this.updateStatus();
          this.output.appendLine(`检查失败：${error instanceof Error ? error.message : String(error)}`); this.output.show(true);
          const action = await vscode.window.showErrorMessage(`${error instanceof Error ? error.message : String(error)}${error instanceof ToolFailure && error.hint ? ` ${error.hint}` : ''}`, '选择 Python 解释器');
          if (!action) return;
          await this.python.select(resource); continue;
        }
        if (this.disposed) return;
        this.cache.set(project.id, { project, snapshot }); this.updateStatus(); this.write(project, snapshot);
        const env = snapshot.inspection.environment;
        const action = await vscode.window.showQuickPick([
          { label: '$(cloud-download) 安装 / 切换 ModSDK 补全库', action: 'install', detail: `安装目标：${snapshot.selection.executable}` },
          { label: '$(refresh) 重新检查', action: 'inspect', detail: '只读检查当前 Python 选择与安装状态' },
          { label: '$(symbol-variable) 选择 Python 解释器', action: 'select', detail: '使用 Microsoft Python 的原生环境选择器' },
          { label: '$(refresh) 刷新 Python 补全服务', action: 'restart', detail: '调用 Python 原生语言服务重启命令' },
          { label: '$(extensions) 打开 Pylance 扩展', action: 'pylance', detail: '普通 Python 文件的补全与跳转服务' }
        ], { title: `${project.label} · Python ${env.version} · ModSDK ${snapshot.inspection.installed?.version ?? '未安装'}`,
          placeHolder: snapshot.selection.executable, matchOnDetail: true });
        if (!action) return;
        if (action.action === 'inspect') continue;
        if (action.action === 'select') { await this.python.select(resource); continue; }
        if (action.action === 'restart') { await vscode.commands.executeCommand('python.analysis.restartLanguageServer'); return; }
        if (action.action === 'pylance') { await vscode.commands.executeCommand('extension.open', 'ms-python.vscode-pylance'); return; }
        const versions = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '查询 ModSDK 可用版本', cancellable: false },
          () => this.environments.versions(project));
        const selected = await vscode.window.showQuickPick([...versions].reverse().map(version => ({ label: version, version,
          description: version === snapshot.inspection.installed?.version ? '当前可见版本' : undefined })),
        { title: '选择与目标游戏匹配的 ModSDK 版本', placeHolder: '不会自动选择最新版；不同游戏构建的 API 可能不同' });
        if (!selected) return;
        const confirm = await vscode.window.showInformationMessage(`安装 ModSDK ${selected.version} 到以下开发环境？`,
          { modal: true, detail: `解释器：${snapshot.selection.executable}\nPython：${env.version}\n环境前缀：${env.prefix}\n包：mc-netease-sdk（仅补全用途）\n已有版本：${snapshot.inspection.installed?.version ?? '未安装'}\n不会改变 VS Code 的解释器选择。` }, '安装到此环境');
        if (!confirm) return;
        this.cache.delete(project.id); this.updateStatus();
        this.output.appendLine(`\n[>] 安装 ModSDK ${selected.version}\n确定目标：${snapshot.selection.executable}\n请等待安装和环境核验。`); this.output.show(true);
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `安装 ModSDK ${selected.version} · ${snapshot.selection.label}`, cancellable: false },
          () => this.environments.install(project, snapshot, selected.version));
        if (this.disposed) return;
        this.write(project, { ...snapshot, inspection: result.inspection });
        if (result.selectionMatches) {
          this.cache.set(project.id, { project, snapshot: { ...snapshot, inspection: result.inspection } }); this.updateStatus();
          this.output.appendLine('[+] 已核验安装到 VS Code 选中的开发环境。Pylance 会检测环境包变化；如补全未刷新，可使用“Python: Restart Language Server”。');
          void vscode.window.showInformationMessage(`ModSDK ${selected.version} 已安装并核验：${snapshot.selection.executable}`);
        } else {
          this.output.appendLine('[!] 原目标安装已核验，但 VS Code 当前 Python 选择已改变；当前环境需要重新检查，未向新环境安装。');
          void vscode.window.showWarningMessage('补全库已安装到原目标；VS Code 选择已改变，请重新检查当前开发环境。');
        }
        return;
      }
    } catch (error) {
      this.cache.delete(project.id); this.updateStatus();
      this.output.appendLine(`[!] ${error instanceof Error ? error.message : String(error)}`); this.output.appendLine('请重新检查原目标环境确认结果；不会自动重试或改用其他 Python。'); this.output.show(true);
      throw error;
    } finally { this.busy = false; }
  }
  dispose(): void { this.disposed = true; this.hintRevision++; if (this.timer) clearTimeout(this.timer); this.hints.invalidate(); this.cache.clear(); this.subscription.dispose(); this.status.dispose(); this.output.dispose(); }
}
