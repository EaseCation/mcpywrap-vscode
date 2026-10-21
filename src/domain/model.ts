export interface Project {
  readonly id: string; readonly root: string; readonly label: string;
  /** Workspace spelling of the root, before filesystem aliases are resolved. */
  readonly workspaceRoot?: string;
}
export type Side = 'client' | 'server';
export interface World { readonly id: string; readonly name: string; readonly state: string }
export interface Session {
  readonly id: string; readonly state: string; readonly mode: string;
  readonly group?: string; readonly role?: string; readonly world?: string; readonly worldReady: boolean;
}
export interface Group { readonly id: string; readonly state: string; readonly members: readonly string[]; readonly hint?: string }
export interface Snapshot {
  readonly sessions: readonly Session[]; readonly groups: readonly Group[];
  readonly worlds: readonly World[]; readonly issues: readonly string[];
}
export interface Target { readonly project: Project; readonly id: string; readonly kind: 'session' | 'group' }
export interface Capabilities {
  readonly pythonSides: readonly Side[]; readonly reloadSides: readonly Side[];
  readonly pythonReload: boolean; readonly coordinatedReload: boolean;
}
export interface OperationResult {
  readonly ok: boolean; readonly state?: string; readonly session?: string; readonly group?: string;
  readonly requestId?: string; readonly stdout?: string; readonly stderr?: string;
  readonly error?: string; readonly hint?: string; readonly value?: unknown;
  readonly details: Readonly<Record<string, unknown>>;
}
export type FailureKind = 'unavailable' | 'queryFailed' | 'invalidResponse' | 'unknown' | 'rejected' | 'busy';
export class ToolFailure extends Error {
  constructor(readonly kind: FailureKind, message: string, readonly hint?: string,
    readonly details?: Readonly<Record<string, unknown>>) { super(message); this.name = 'ToolFailure'; }
}
