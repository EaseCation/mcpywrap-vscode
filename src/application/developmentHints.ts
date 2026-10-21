import { DevelopmentEnvironmentGateway, PythonSelectionSource, sameSelection } from './developmentEnvironments';
import { DevelopmentSnapshot, SdkInspection } from '../domain/developmentEnvironment';
import { Project, ToolFailure } from '../domain/model';

/** One offline probe per selected executable; failed probes also await invalidation. */
export class DevelopmentHints {
  private readonly probes = new Map<string, Promise<SdkInspection>>();
  private readonly prompted = new Set<string>();
  private revision = 0;
  constructor(private readonly gateway: DevelopmentEnvironmentGateway, private readonly python: PythonSelectionSource) {}
  invalidate(): void { this.revision++; this.probes.clear(); }
  async check(project: Project, resource: string): Promise<DevelopmentSnapshot | undefined> {
    const revision = this.revision;
    const selection = await this.python.selected(resource);
    if (revision !== this.revision) return undefined;
    let pending = this.probes.get(selection.executable);
    if (!pending) {
      pending = this.gateway.inspect(project, selection.executable).then(inspection => {
        if (inspection.environment.invocation !== selection.executable) throw new ToolFailure('invalidResponse', '自动检查的 Python 目标不匹配。');
        return inspection;
      });
      this.probes.set(selection.executable, pending);
    }
    const inspection = await pending;
    if (revision !== this.revision || !sameSelection(selection, await this.python.selected(resource))) return undefined;
    return { resource, selection, inspection };
  }
  claimPrompt(snapshot: DevelopmentSnapshot): boolean {
    if (snapshot.inspection.installed?.inEnvironment || this.prompted.has(snapshot.selection.executable)) return false;
    this.prompted.add(snapshot.selection.executable);
    return true;
  }
}
