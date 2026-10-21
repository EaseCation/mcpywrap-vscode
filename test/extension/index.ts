import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { OperationResult } from '../../src/domain/model';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('easecation.mcpywrap-vscode');
  assert.ok(extension, 'extension should be installed as a development extension');
  const api = await extension.activate() as { refresh(): Promise<void>; getProjectCount(): number; getActiveProjectId(): string | undefined };
  // Linux is deliberately unsupported for local game operations; activation still works.
  if (process.platform === 'linux') { assert.equal(api.getProjectCount(), 0); return; }
  assert.equal(api.getProjectCount(), 2, 'nested projects are discovered automatically without settings; generated/cache projects are excluded');
  const callLog = async () => (await readFile(process.env.MCPY_FIXTURE_LOG!, 'utf8').catch(() => '')).trim();
  assert.equal(await callLog(), '', 'activation only identifies projects; it must not launch mcpy');
  const commands = await vscode.commands.getCommands();
  for (const name of ['refresh', 'run', 'newWorld', 'runTwoClients', 'stop', 'logs', 'executeSelection', 'reloadFile', 'doctor']) {
    assert.ok(commands.includes(`mcpy.${name}`), `missing command: ${name}`);
  }
  if (process.platform !== 'darwin') return;
  const workspace = process.env.MCPY_FIXTURE_WORKSPACE!;
  const beforeNavigation = await callLog();
  for (const [filename, suffix] of [['project-a/config.json', 'project-a'], ['project-b/pyproject.toml', 'project-b'], ['README.md', undefined]] as const) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, filename))));
    if (suffix) assert.ok(api.getActiveProjectId()?.endsWith(suffix), `wrong project for ${filename}`);
    else assert.equal(api.getActiveProjectId(), undefined, 'container README must not inherit another project');
  }
  assert.equal(await callLog(), beforeNavigation, 'switching files must not run CLI queries');
  const titleMenus = extension.packageJSON.contributes.menus['editor/title'] as { command?: string; when: string }[];
  assert.ok(titleMenus.some(menu => menu.command === 'mcpy.run' && menu.when.includes('resourcePath in mcpy.projectFiles')));
  assert.equal(extension.packageJSON.contributes.configuration.properties['mcpy.projectRoots'], undefined);

  const added = path.join(workspace, 'new-project');
  await mkdir(added);
  const waitForCount = async (expected: number) => {
    const deadline = Date.now() + 10000;
    while (api.getProjectCount() !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(api.getProjectCount(), expected, 'manifest watcher did not update project discovery');
  };
  await writeFile(path.join(added, 'pyproject.toml'), '[tool.mcpywrap]\n'); await waitForCount(3);
  const manifestUri = vscode.Uri.file(path.join(added, 'pyproject.toml'));
  const editManifest = async (source: string) => {
    const manifest = await vscode.workspace.openTextDocument(manifestUri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(manifestUri, new vscode.Range(manifest.positionAt(0), manifest.positionAt(manifest.getText().length)), source);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await manifest.save());
  };
  // Exercise actual editor saves. FSEvents is allowed to coalesce rapid external
  // writes to a freshly created directory; user saves have their own event.
  await editManifest('[project]\nname="ordinary-python"\n'); await waitForCount(2);
  await editManifest('[tool.mcpywrap]\n'); await waitForCount(3);
  await rm(added, { recursive: true }); await waitForCount(2);
  assert.equal(await callLog(), beforeNavigation, 'manifest changes must not launch mcpy');

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'project-a', 'logic.py')));
  const editor = await vscode.window.showTextDocument(document);
  const routed = await vscode.commands.executeCommand<OperationResult>('mcpy.run', vscode.Uri.file(path.join(workspace, 'project-b/pyproject.toml')));
  assert.equal(routed?.session, 'solo-session', 'title command must accept the clicked editor URI even when another project is active');
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
