import * as vscode from 'vscode';
import { PythonSelectionSource } from '../application/developmentEnvironments';
import { PythonSelection } from '../domain/developmentEnvironment';
import { ToolFailure } from '../domain/model';

// Public API: https://github.com/microsoft/vscode-python/wiki/Python-Environment-APIs
// Only the documented subset is used; defaultInterpreterPath is not the selection.
interface PythonApi {
  environments: {
    getActiveEnvironmentPath(resource: vscode.Uri): { id: string; path: string };
    resolveEnvironment(environment: { id: string; path: string }): Promise<{
      executable: { uri?: vscode.Uri }; environment?: { name?: string };
    } | undefined>;
    readonly onDidChangeActiveEnvironmentPath: vscode.Event<unknown>;
  };
}
export class VscodePythonEnvironment implements PythonSelectionSource, vscode.Disposable {
  private api?: PythonApi;
  private loading?: Promise<PythonApi>;
  private subscription?: vscode.Disposable;
  private disposed = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  current(resource: string): { id: string; path: string } | undefined {
    const extension = vscode.extensions.getExtension('ms-python.python');
    return extension?.isActive ? this.api?.environments.getActiveEnvironmentPath(vscode.Uri.parse(resource)) : undefined;
  }
  private load(): Promise<PythonApi> {
    if (this.disposed) return Promise.reject(new ToolFailure('unavailable', 'Python 环境协调器已关闭。'));
    if (!this.loading) {
      this.loading = (async () => {
        const extension = vscode.extensions.getExtension<PythonApi>('ms-python.python');
        if (!extension) throw new ToolFailure('unavailable', '请安装并启用 Microsoft Python 扩展，再检查开发环境。');
        const api = await extension.activate();
        if (!api?.environments?.getActiveEnvironmentPath || !api.environments.resolveEnvironment) {
          throw new ToolFailure('unavailable', 'Microsoft Python 未提供所需的公开环境 API，请更新并启用扩展。');
        }
        if (!this.disposed) {
          this.api = api;
          this.subscription = api.environments.onDidChangeActiveEnvironmentPath(() => this.changed.fire());
        }
        return api;
      })().catch(error => { this.loading = undefined; throw error; });
    }
    return this.loading;
  }
  async selected(resource: string): Promise<PythonSelection> {
    const api = await this.load();
    const path = api.environments.getActiveEnvironmentPath(vscode.Uri.parse(resource));
    const resolved = await api.environments.resolveEnvironment(path);
    const executable = resolved?.executable.uri;
    if (!path.id || !path.path || !executable || executable.scheme !== 'file') {
      throw new ToolFailure('unavailable', '当前文件尚未选择有效的本机 Python 解释器，请使用“Python: 选择解释器”。');
    }
    const now = api.environments.getActiveEnvironmentPath(vscode.Uri.parse(resource));
    if (now.id !== path.id || now.path !== path.path) throw new ToolFailure('rejected', '解释器选择正在改变，请重新检查。');
    // Keep venv/bin/python as selected. Resolving symlinks would launch base Python.
    return { ...path, executable: executable.fsPath, label: resolved?.environment?.name ?? 'Python' };
  }
  async select(resource: vscode.Uri): Promise<void> {
    await this.load();
    // Select in the clicked resource's actual editor; the Python command is native.
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(resource), { preview: true });
    await vscode.commands.executeCommand('python.setInterpreter');
    this.changed.fire();
  }
  dispose(): void { this.disposed = true; this.subscription?.dispose(); this.changed.dispose(); }
}
