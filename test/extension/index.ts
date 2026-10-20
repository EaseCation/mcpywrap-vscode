import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { OperationResult } from '../../src/domain/model';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('easecation.mcpywrap-vscode');
  assert.ok(extension, 'extension should be installed as a development extension');
  const api = await extension.activate() as { refresh(): Promise<void>; getProjectCount(): number };
  await api.refresh();
  // Linux is deliberately unsupported for local game operations; activation still works.
  if (process.platform === 'linux') { assert.equal(api.getProjectCount(), 0); return; }
  assert.equal(api.getProjectCount(), 2, 'configured nested projects are independently discovered');
  const commands = await vscode.commands.getCommands();
  for (const name of ['refresh', 'run', 'newWorld', 'runTwoClients', 'stop', 'logs', 'executeSelection', 'reloadFile', 'doctor']) {
    assert.ok(commands.includes(`mcpy.${name}`), `missing command: ${name}`);
  }
  if (process.platform !== 'darwin') return;
  const workspace = process.env.MCPY_FIXTURE_WORKSPACE!;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'project-a', 'logic.py')));
  const editor = await vscode.window.showTextDocument(document);
  const started = await vscode.commands.executeCommand<OperationResult>('mcpy.run');
  assert.equal(started?.session, 'solo-session');
  assert.equal(started?.details.source_matches, false, 'reuse evidence must survive presentation');
  const newWorld = await vscode.commands.executeCommand<OperationResult>('mcpy.newWorld');
  assert.equal(newWorld?.state, 'running');
  const two = await vscode.commands.executeCommand<OperationResult>('mcpy.runTwoClients');
  assert.equal(two?.group, 'group-one'); assert.equal(two?.state, 'waiting_for_join');

  // Use real Extension Host APIs; control only human choices for deterministic smoke tests.
  const descriptor = Object.getOwnPropertyDescriptor(vscode.window, 'showQuickPick');
  let chooseHost = false;
  Object.defineProperty(vscode.window, 'showQuickPick', { configurable: true, value: async (items: unknown) => {
    const values = await Promise.resolve(items) as { session?: { role?: string } }[];
    return (chooseHost && values.find(item => item.session?.role === 'host')) || values[0];
  } });
  try {
    editor.selection = new vscode.Selection(1, 0, 2, 0);
    const executed = await vscode.commands.executeCommand<OperationResult>('mcpy.executeSelection');
    assert.equal(executed?.state, 'completed'); assert.equal(executed?.value, 2);
    chooseHost = true;
    const reloaded = await vscode.commands.executeCommand<OperationResult>('mcpy.reloadFile');
    assert.equal(reloaded?.state, 'completed');
    const logs = await vscode.commands.executeCommand<string>('mcpy.logs');
    assert.equal(logs, '[host host-session]\nhost log');
  } finally {
    if (descriptor) Object.defineProperty(vscode.window, 'showQuickPick', descriptor);
  }
  console.log('Extension Host: activation, multi-project discovery, start, Python, reload and log snapshot passed.');
}
