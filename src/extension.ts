import * as vscode from 'vscode';
import { Workbench } from './application/workbench';
import { ProcessTransport } from './infrastructure/mcpy/transport';
import { CliGateway } from './infrastructure/mcpy/gateway';
import { Utf8TemporarySource } from './infrastructure/mcpy/source';
import { FilesystemDiscovery } from './infrastructure/workspace/discovery';
import { WorkbenchController } from './presentation/controller';

export async function activate(context: vscode.ExtensionContext) {
  const transport = new ProcessTransport(root => {
    const config = vscode.workspace.getConfiguration('mcpy', vscode.Uri.file(root));
    return { executable: config.get<string>('executable', 'mcpy'),
      queryTimeoutMs: config.get<number>('queryTimeoutSeconds', 30) * 1000,
      operationTimeoutMs: config.get<number>('operationTimeoutSeconds', 600) * 1000 };
  });
  const unsupported = vscode.env.remoteName ? '当前预览支持本机桌面工作区；Remote SSH/WSL 游戏操作尚未接入。'
    : process.platform !== 'darwin' && process.platform !== 'win32' ? '当前预览支持 Windows/macOS 本机桌面。' : undefined;
  const controller = new WorkbenchController(new Workbench(new CliGateway(transport, new Utf8TemporarySource())),
    new FilesystemDiscovery(), unsupported);
  context.subscriptions.push(controller, transport);
  await controller.refresh();
  return { refresh: () => controller.refresh(), getProjectCount: () => controller.projectCount };
}
