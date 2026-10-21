import { Capabilities, LogEvent, OperationResult, Project, Side, Snapshot, Target } from '../domain/model';

export interface McpyGateway {
  inspect(project: Project): Promise<Snapshot>;
  start(project: Project, options: { world?: string; newWorld?: boolean; clients?: 1 | 2 }): Promise<OperationResult>;
  stop(target: Target): Promise<OperationResult>;
  capabilities(target: Target): Promise<Capabilities>;
  execute(target: Target, side: Side, code: string): Promise<OperationResult>;
  reload(target: Target, side: Side, file: string): Promise<OperationResult>;
  logs(target: Target, source: 'game' | 'engine' | 'worker'): Promise<string>;
  diagnose(project: Project): Promise<OperationResult>;
}
export interface ProjectDiscovery {
  discover(roots: readonly { root: string; manifests: readonly string[] }[]): Promise<{
    projects: readonly Project[]; issues: readonly string[];
  }>;
  containing(projects: readonly Project[], file: string): Project | undefined;
}
export interface CliRequest {
  readonly project: Project; readonly args: readonly string[]; readonly mutation: boolean;
}
export interface CliTransport { request(command: CliRequest): Promise<Record<string, unknown>> }
export interface TemporarySource { withFile<T>(code: string, action: (file: string) => Promise<T>): Promise<T> }
export interface LogSubscription { dispose(): void; readonly done: Promise<void> }
export interface LogFollower {
  follow(target: Target, event: (event: LogEvent) => void, error: (error: Error) => void): LogSubscription;
}
