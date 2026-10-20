import { CliRequest } from '../../application/ports';
import { Project, Side, Target } from '../../domain/model';

export function command(project: Project, args: readonly string[], mutation = false): CliRequest {
  return { project, args: ['--local', '--project', project.root, '--non-interactive', ...args, '--json'], mutation };
}
export function targetArgs(target: Target): string[] { return [`--${target.kind}`, target.id]; }
export const commands = {
  status: (p: Project) => command(p, ['status', '--list']),
  worlds: (p: Project) => command(p, ['run', '--list']),
  start: (p: Project, o: { world?: string; newWorld?: boolean; clients?: 1 | 2 }) =>
    command(p, ['run', ...(o.world ? [o.world] : []), '--no-gui', '--detach',
      ...(o.newWorld ? ['--new'] : []), ...(o.clients === 2 ? ['--clients', '2'] : [])], true),
  stop: (t: Target) => command(t.project, ['stop', ...targetArgs(t)], true),
  capabilities: (t: Target) => command(t.project, ['runtime', 'capabilities', ...targetArgs(t)]),
  execute: (t: Target, side: Side, file: string) => command(t.project,
    ['runtime', 'py', ...targetArgs(t), '--side', side, '--file', file], true),
  reload: (t: Target, side: Side, file: string) => command(t.project,
    ['runtime', 'reload', 'python', ...targetArgs(t), '--side', side, '--file', file], true),
  logs: (t: Target, source: string) => command(t.project, ['logs', ...targetArgs(t), '--source', source, '--tail', '300']),
  doctor: (p: Project) => command(p, ['doctor'])
};
