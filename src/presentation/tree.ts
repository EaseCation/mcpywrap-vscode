import * as vscode from 'vscode';
import { Group, Project, Session, Snapshot, Target, World } from '../domain/model';

export class WorkspaceNode extends vscode.TreeItem {
  constructor(readonly kind: 'project' | 'world' | 'session' | 'group' | 'message',
    label: string, readonly project?: Project, readonly value?: World | Session | Group) {
    super(label, kind === 'project' ? vscode.TreeItemCollapsibleState.Expanded :
      kind === 'group' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = `mcpy.${kind}`;
    this.iconPath = new vscode.ThemeIcon({ project: 'folder', world: 'globe', session: 'vm', group: 'organization', message: 'info' }[kind]);
    if (project) this.tooltip = project.root;
    if (value) { this.description = value.state; this.tooltip = `${project?.root}\n${value.id}\n${value.state}`; }
    if (value && 'hint' in value && value.hint) this.tooltip += `\n${value.hint}`;
    if (kind === 'session') this.tooltip += '\nrunning 仅表示进程存活；实际能力按会话查询。';
  }
  get target(): Target | undefined {
    return this.project && this.value && (this.kind === 'session' || this.kind === 'group')
      ? { project: this.project, id: this.value.id, kind: this.kind } : undefined;
  }
}
export interface ProjectState { project: Project; snapshot?: Snapshot; error?: string; loading: boolean }

export class WorkspaceTree implements vscode.TreeDataProvider<WorkspaceNode>, vscode.Disposable {
  private readonly change = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.change.event;
  readonly states = new Map<string, ProjectState>();
  private issues: readonly string[] = [];
  setProjects(projects: readonly Project[], issues: readonly string[]): void {
    const previous = new Map(this.states); this.states.clear();
    for (const project of projects) this.states.set(project.id, { ...previous.get(project.id), project, loading: false });
    this.issues = issues; this.change.fire();
  }
  update(project: Project, patch: Partial<ProjectState>): void {
    const state = this.states.get(project.id);
    if (state) { Object.assign(state, patch); this.change.fire(); }
  }
  getTreeItem(node: WorkspaceNode): vscode.TreeItem { return node; }
  getChildren(node?: WorkspaceNode): WorkspaceNode[] {
    if (!node) return [...this.states.values()].map(state => {
      const item = new WorkspaceNode('project', state.project.label, state.project);
      item.id = state.project.id;
      item.description = state.loading ? '查询中…' : state.error ? '查询失败 · 结果可能过期' : state.snapshot ? undefined : '待查询';
      return item;
    }).concat(this.issues.map(issue => new WorkspaceNode('message', issue)));
    if (!node.project) return [];
    const state = this.states.get(node.project.id);
    if (!state) return [];
    const snapshot = state.snapshot;
    if (node.kind === 'group') return snapshot?.sessions.filter(s => s.group === node.value?.id)
      .map(s => this.sessionNode(node.project!, s)) ?? [];
    if (node.kind !== 'project') return [];
    const items: WorkspaceNode[] = [];
    if (state.error) items.push(new WorkspaceNode('message', `查询失败：${state.error}`, node.project));
    if (!snapshot) { items.push(new WorkspaceNode('message', '点击刷新查看世界与会话，或直接运行测试。', node.project)); return items; }
    items.push(...snapshot.issues.map(issue => new WorkspaceNode('message', issue, node.project)));
    items.push(...snapshot.worlds.map(w => new WorkspaceNode('world', `世界 · ${w.name}`, node.project, w)));
    items.push(...snapshot.groups.map(g => new WorkspaceNode('group', `联调组 · ${g.id.slice(0, 8)}`, node.project, g)));
    items.push(...snapshot.sessions.filter(s => !s.group || !snapshot.groups.some(g => g.id === s.group))
      .map(s => this.sessionNode(node.project!, s)));
    if (items.length === 0) items.push(new WorkspaceNode('message', '暂无世界或会话；可选择“新建测试世界”。', node.project));
    return items;
  }
  private sessionNode(project: Project, session: Session): WorkspaceNode {
    return new WorkspaceNode('session', `${session.role ?? '会话'} · ${session.id.slice(0, 8)}`, project, session);
  }
  dispose(): void { this.change.dispose(); }
}
