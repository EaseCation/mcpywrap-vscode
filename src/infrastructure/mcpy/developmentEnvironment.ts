import { DevelopmentEnvironmentGateway } from '../../application/developmentEnvironments';
import { CliTransport } from '../../application/ports';
import { SdkInspection } from '../../domain/developmentEnvironment';
import { Project, ToolFailure } from '../../domain/model';
import { command } from './commands';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolFailure('invalidResponse', 'CLI 开发环境信息格式无效。');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ToolFailure('invalidResponse', 'CLI 开发环境信息缺少有效字段。');
  return value;
}
function success(data: Record<string, unknown>): Record<string, unknown> {
  if (data.ok !== true) throw new ToolFailure('rejected', typeof data.error === 'string' ? data.error : '开发环境命令失败。',
    '此功能需要 mcpy 0.5.7+；检查所选解释器和原环境状态，不会自动重试或改用其他 Python。', data);
  return data;
}
function inspection(data: Record<string, unknown>): SdkInspection {
  success(data);
  const e = object(data.environment), s = data.installed === null ? undefined : object(data.installed);
  if (s && typeof s.in_environment !== 'boolean') throw new ToolFailure('invalidResponse', 'CLI 未确认 SDK 安装位置。');
  return { environment: { invocation: string(e.invocation), executable: string(e.executable), prefix: string(e.prefix),
    basePrefix: string(e.base_prefix), version: string(e.version), identity: string(e.identity),
    purelib: string(e.purelib), platlib: string(e.platlib) },
    installed: s ? { version: string(s.version), location: string(s.location), inEnvironment: s.in_environment === true } : undefined };
}
export class CliDevelopmentEnvironmentGateway implements DevelopmentEnvironmentGateway {
  constructor(private readonly transport: CliTransport) {}
  async inspect(project: Project, python: string): Promise<SdkInspection> {
    return inspection(await this.transport.request(command(project, ['modsdk', '--inspect', '--python', python])));
  }
  async versions(project: Project): Promise<readonly string[]> {
    const data = success(await this.transport.request(command(project, ['modsdk', '--list'])));
    if (!Array.isArray(data.versions) || !data.versions.length || data.versions.some(v => typeof v !== 'string' || !v)) {
      throw new ToolFailure('invalidResponse', 'CLI 没有返回可用的 SDK 版本列表。');
    }
    return data.versions as string[];
  }
  async install(project: Project, python: string, version: string, identity: string): Promise<SdkInspection> {
    return inspection(await this.transport.request(command(project,
      ['modsdk', '--version', version, '--python', python, '--expected-environment', identity], true)));
  }
}
