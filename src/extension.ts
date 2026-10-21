import * as vscode from 'vscode';
import { DevelopmentEnvironments } from './application/developmentEnvironments';
import { CliDevelopmentEnvironmentGateway } from './infrastructure/mcpy/developmentEnvironment';
import { DevelopmentEnvironmentPanel } from './presentation/developmentEnvironment';
import { VscodePythonEnvironment } from './presentation/pythonEnvironment';
import { randomUUID } from 'node:crypto';
import { Workbench } from './application/workbench';
import { ProcessTransport } from './infrastructure/mcpy/transport';
import { CliGateway } from './infrastructure/mcpy/gateway';
import { Utf8TemporarySource } from './infrastructure/mcpy/source';
import { FilesystemDiscovery } from './infrastructure/workspace/discovery';
import { WorkbenchController } from './presentation/controller';
import { CliLogFollower } from './infrastructure/mcpy/logs';
import { RuntimeConsole } from './presentation/runtimeConsole';

export async function activate(context: vscode.ExtensionContext) {
  const options = (root: string) => {
    const config = vscode.workspace.getConfiguration('mcpy', vscode.Uri.file(root));
    return { executable: config.get<string>('executable', 'mcpy'),
      queryTimeoutMs: config.get<number>('queryTimeoutSeconds', 30) * 1000,
      operationTimeoutMs: config.get<number>('operationTimeoutSeconds', 600) * 1000 };
  };
  const transport = new ProcessTransport(options);
  const workbench = new Workbench(new CliGateway(transport, new Utf8TemporarySource()), new CliLogFollower(options));
  const snippetRoot = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'snippets');
  const runtime = new RuntimeConsole(workbench, vscode.Uri.joinPath(snippetRoot, randomUUID()), snippetRoot);
  const unsupported = vscode.env.remoteName ? '当前预览支持本机桌面工作区；Remote SSH/WSL 游戏操作尚未接入。'
    : process.platform !== 'darwin' && process.platform !== 'win32' ? '当前预览支持 Windows/macOS 本机桌面。' : undefined;
  const python = new VscodePythonEnvironment();
  const development = new DevelopmentEnvironmentPanel(new DevelopmentEnvironments(new CliDevelopmentEnvironmentGateway(transport), python), python);
  const controller = new WorkbenchController(workbench, new FilesystemDiscovery(), unsupported, runtime, development);
  context.subscriptions.push(controller, transport, runtime, development, python);
  await controller.initialize();
  return { refresh: () => controller.refresh(), getProjectCount: () => controller.projectCount,
    getActiveProjectId: () => controller.activeProjectId, getRuntimeState: () => runtime.getState(),
    executeRuntimeSnippet: (key: string, side: 'client' | 'server', code: string) => runtime.executeSnippet(key, side, code) };
}
