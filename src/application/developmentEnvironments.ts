import { DevelopmentSnapshot, PythonSelection, SdkInspection } from '../domain/developmentEnvironment';
import { Project, ToolFailure } from '../domain/model';

export interface PythonSelectionSource {
  selected(resource: string): Promise<PythonSelection>;
}
export interface DevelopmentEnvironmentGateway {
  inspect(project: Project, python: string): Promise<SdkInspection>;
  versions(project: Project): Promise<readonly string[]>;
  install(project: Project, python: string, version: string, identity: string): Promise<SdkInspection>;
}
export function sameSelection(a: PythonSelection, b: PythonSelection): boolean {
  return a.id === b.id && a.path === b.path && a.executable === b.executable;
}
export class DevelopmentEnvironments {
  private readonly installing = new Set<string>();
  constructor(private readonly gateway: DevelopmentEnvironmentGateway, private readonly python: PythonSelectionSource) {}
  async inspect(project: Project, resource: string): Promise<DevelopmentSnapshot> {
    const selection = await this.python.selected(resource);
    const inspection = await this.gateway.inspect(project, selection.executable);
    this.verifyInvocation(selection, inspection);
    if (!sameSelection(selection, await this.python.selected(resource))) {
      throw new ToolFailure('rejected', '检查期间 VS Code 的 Python 选择已改变，请重新检查。');
    }
    return { resource, selection, inspection };
  }
  versions(project: Project): Promise<readonly string[]> { return this.gateway.versions(project); }
  async install(project: Project, snapshot: DevelopmentSnapshot, version: string): Promise<{ inspection: SdkInspection; selectionMatches: boolean }> {
    const selection = snapshot.selection;
    const key = selection.executable;
    if (this.installing.has(key)) throw new ToolFailure('rejected', '此 Python 环境的补全库安装仍在进行，请等待并重新检查。');
    this.installing.add(key);
    try {
      if (!sameSelection(selection, await this.python.selected(snapshot.resource))) {
        throw new ToolFailure('rejected', '安装目标已与 VS Code 当前选择不同；未提交安装，请重新检查。');
      }
      const inspection = await this.gateway.install(project, key, version, snapshot.inspection.environment.identity);
      this.verifyInvocation(selection, inspection);
      if (inspection.environment.identity !== snapshot.inspection.environment.identity || !inspection.installed?.inEnvironment || inspection.installed.version !== version) {
        throw new ToolFailure('unknown', '安装回执的环境身份、SDK 版本或安装位置不匹配，请检查原环境。');
      }
      let selectionMatches = false;
      try { selectionMatches = sameSelection(selection, await this.python.selected(snapshot.resource)); } catch { /* Original installation is still verified. */ }
      return { inspection, selectionMatches };
    } finally { this.installing.delete(key); }
  }
  private verifyInvocation(selection: PythonSelection, inspection: SdkInspection): void {
    if (inspection.environment.invocation !== selection.executable) {
      throw new ToolFailure('invalidResponse', 'CLI 检查的 Python 与 VS Code 选中的解释器不匹配。');
    }
  }
}
