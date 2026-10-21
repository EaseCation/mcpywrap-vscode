import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { VscodePythonEnvironment } from '../../src/presentation/pythonEnvironment';
import { OperationResult } from '../../src/domain/model';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('easecation.mcpywrap-vscode');
  assert.ok(extension, 'extension should be installed as a development extension');
  const api = await extension.activate() as { refresh(): Promise<void>; getProjectCount(): number; getActiveProjectId(): string | undefined;
    getRuntimeState(): { selected?: string; sessions: number; busy: boolean; transcript: { source: string; label: string; text: string }[];
      channels: string[]; raw: boolean; displayed: { engine: string; script: string } };
    executeRuntimeSnippet(key: string, side: 'client' | 'server', code: string): Promise<OperationResult | undefined> };
  // Linux is deliberately unsupported for local game operations; activation still works.
  if (process.platform === 'linux') { assert.equal(api.getProjectCount(), 0); return; }
  assert.equal(api.getProjectCount(), 2, 'nested projects are discovered automatically without settings; generated/cache projects are excluded');
  const allCalls = async () => (await readFile(process.env.MCPY_FIXTURE_LOG!, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[] });
  const callLog = async () => (await allCalls()).filter(call => !call.args.includes('modsdk')).map(call => JSON.stringify(call)).join('\n');
  assert.equal(await callLog(), '', 'activation only identifies projects; it must not launch mcpy');
  const commands = await vscode.commands.getCommands();
  for (const name of ['refresh', 'run', 'newWorld', 'runTwoClients', 'stop', 'logs', 'executeSelection', 'reloadFile', 'doctor', 'developmentEnvironment']) {
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
  assert.ok((await vscode.languages.getLanguages()).includes('mcpy-log'));
  const colorRules = vscode.workspace.getConfiguration('editor').get<{ textMateRules?: { scope: string; settings: { foreground?: string } }[] }>('tokenColorCustomizations');
  assert.ok(colorRules?.textMateRules?.some(rule => rule.scope === 'invalid.mcpy.error' && rule.settings.foreground), 'native output color defaults must actually register');

  const added = path.join(workspace, 'new-project');
  await mkdir(added);
  const waitForCount = async (expected: number) => {
    const deadline = Date.now() + 10000;
    while (api.getProjectCount() !== expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(api.getProjectCount(), expected, 'manifest watcher did not update project discovery');
  };
  const manifestUri = vscode.Uri.file(path.join(added, 'pyproject.toml'));
  const create = new vscode.WorkspaceEdit();
  create.createFile(manifestUri);
  create.insert(manifestUri, new vscode.Position(0, 0), '[tool.mcpywrap]\n');
  assert.ok(await vscode.workspace.applyEdit(create));
  assert.ok(await (await vscode.workspace.openTextDocument(manifestUri)).save());
  await waitForCount(3);
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
  const remove = new vscode.WorkspaceEdit(); remove.deleteFile(manifestUri);
  assert.ok(await vscode.workspace.applyEdit(remove)); await waitForCount(2);
  await rm(added, { recursive: true });
  assert.equal(await callLog(), beforeNavigation, 'manifest changes must not launch mcpy');

  const python = new VscodePythonEnvironment();
  assert.equal(python.current(vscode.Uri.file(path.join(workspace, 'project-a/logic.py')).toString()), undefined, 'Python is not activated by editor navigation');
  const resourceA = vscode.Uri.file(path.join(workspace, 'project-a/logic.py')).toString();
  const resourceB = vscode.Uri.file(path.join(workspace, 'project-b/logic.py')).toString();
  assert.equal((await python.selected(resourceA)).executable, '/fixture/a/bin/python');
  assert.equal((await python.selected(resourceB)).executable, '/fixture/b/bin/python', 'selection must be resource scoped');
  let environmentChanges = 0;
  const changed = python.onDidChange(() => { environmentChanges++; });
  await vscode.commands.executeCommand('mcpyFixture.changePython');
  assert.equal(environmentChanges, 1);
  assert.equal((await python.selected(resourceA)).executable, '/fixture/changed-a/bin/python');
  assert.equal(await callLog(), beforeNavigation, 'environment API discovery must not run CLI or pip');
  changed.dispose(); python.dispose();

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'project-a', 'logic.py')));
  await vscode.window.showTextDocument(document);
  let startupReturned = false;
  const clicked = vscode.Uri.file(path.join(workspace, 'project-b/pyproject.toml'));
  const launching = vscode.commands.executeCommand<OperationResult>('mcpy.run', clicked).then(result => { startupReturned = true; return result; });
  try {
    const deadline = Date.now() + 15000;
    while (!api.getRuntimeState().displayed.engine.includes('准备中 fixture（没有换行）') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const output = api.getRuntimeState().displayed.engine;
    assert.ok(output.includes('获取版本信息 fixture 中文') && output.includes('准备中 fixture（没有换行）'), 'native engine output must show complete and partial stderr before startup returns');
    assert.ok(output.includes('project-b · 启动'), 'startup diagnostics must label the clicked project');
    assert.equal(startupReturned, false, 'the fake CLI is deliberately held before its final JSON');
    await vscode.commands.executeCommand('mcpy.run', clicked);
    const pendingCalls = (await callLog()).split('\n').map(line => JSON.parse(line));
    assert.equal(pendingCalls.length, 1, 'waiting and duplicate clicks must not spawn extra CLI queries or starts');
  } finally { await writeFile(process.env.MCPY_FIXTURE_START_BARRIER!, 'ready'); }
  const routed = await launching;
  assert.equal(routed?.session, 'solo-session', 'title command must accept the clicked editor URI even when another project is active');
  assert.ok(api.getRuntimeState().displayed.script.includes('游戏会话'));
  const started = await vscode.commands.executeCommand<OperationResult>('mcpy.run');
  assert.equal(started?.session, 'solo-session');
  assert.equal(started?.details.source_matches, false, 'reuse evidence must survive presentation');
  const newWorld = await vscode.commands.executeCommand<OperationResult>('mcpy.newWorld');
  assert.equal(newWorld?.state, 'running');
  const two = await vscode.commands.executeCommand<OperationResult>('mcpy.runTwoClients');
  assert.equal(two?.group, 'group-one'); assert.equal(two?.state, 'waiting_for_join');
  const runtime = api.getRuntimeState();
  assert.ok(runtime.sessions >= 3, 'successful runs automatically bind the console');
  assert.ok(runtime.selected);
  let pythonReturned = false;
  const executing = api.executeRuntimeSnippet(runtime.selected!, 'client', '1 + 1').then(result => { pythonReturned = true; return result; });
  try {
    const deadline = Date.now() + 15000;
    while (!(await callLog()).split('\n').some(line => JSON.parse(line).args.includes('py')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(pythonReturned, false, 'game receipt has not been returned yet');
    assert.equal(api.getRuntimeState().busy, true);
    assert.ok(api.getRuntimeState().displayed.script.includes('执行目标：游戏进程内的 客户端'));
    assert.ok(api.getRuntimeState().displayed.script.includes('等待游戏回执'));
    await api.executeRuntimeSnippet(runtime.selected!, 'client', 'do_not_repeat()');
    assert.equal((await callLog()).split('\n').filter(line => JSON.parse(line).args.includes('py')).length, 1, 'repeated execution while awaiting a receipt must not submit code twice');
  } finally { await writeFile(process.env.MCPY_FIXTURE_PY_BARRIER!, 'ready'); }
  const snippet = await executing;
  assert.equal(api.getRuntimeState().busy, false);
  assert.equal(snippet?.value, 2, 'console snippets execute without an editor selection');
  assert.ok(api.getRuntimeState().transcript.some(entry => entry.source === 'python' && entry.text.includes('结果')));
  assert.ok(api.getRuntimeState().transcript.some(entry => entry.source === 'engine' && entry.text.includes('live engine')));
  assert.ok(api.getRuntimeState().transcript.some(entry => entry.source === 'game' && entry.text.includes('live game')));
  assert.deepEqual(api.getRuntimeState().channels, ['mcpy · 引擎', 'mcpy · 脚本系统']);
  assert.ok(api.getRuntimeState().displayed.engine.includes('[Engine]'));
  assert.ok(!api.getRuntimeState().displayed.script.includes('RN Call:'));
  const beforeSwitch = await callLog();
  await vscode.commands.executeCommand('mcpy.showEngineLog');
  await vscode.commands.executeCommand('mcpy.showScriptLog');
  await vscode.commands.executeCommand('mcpy.toggleLogDetails');
  assert.ok(api.getRuntimeState().displayed.script.includes('RN Call:'));
  await vscode.commands.executeCommand('mcpy.toggleLogDetails');
  assert.ok(!api.getRuntimeState().displayed.script.includes('RN Call:'));
  assert.equal(await callLog(), beforeSwitch, 'source/detail switching must replay memory, not invoke mcpy');

  // Use real Extension Host APIs; control only human choices for deterministic smoke tests.
  const descriptor = Object.getOwnPropertyDescriptor(vscode.window, 'showQuickPick');
  let chooseHost = false;
  let chooseServer = false;
  Object.defineProperty(vscode.window, 'showQuickPick', { configurable: true, value: async (items: unknown) => {
    const values = await Promise.resolve(items) as { session?: { role?: string }; side?: string }[];
    return (chooseServer && values.find(item => item.side === 'server')) || (chooseHost && values.find(item => item.session?.role === 'host')) || values[0];
  } });
  try {
    await vscode.commands.executeCommand('mcpy.newSnippet');
    const scratch = vscode.window.activeTextEditor!.document;
    assert.equal(scratch.languageId, 'mcpy-runtime-python', 'game scratch language must not match the local Python run toolbar');
    assert.equal(document.languageId, 'python', 'business Python files keep their normal language and tooling');
    assert.equal(scratch.uri.scheme, 'file', 'snippets have a dedicated path without a Save As step');
    assert.ok(!scratch.uri.fsPath.startsWith(workspace), 'scratch files must stay outside the business workspace');
    const initial = await readFile(scratch.uri.fsPath, 'utf8');
    const dirtySource = '# 未保存的游戏片段\nprint("当前内存 🚀")\n1 + 1\n';
    const edit = new vscode.WorkspaceEdit();
    edit.replace(scratch.uri, new vscode.Range(scratch.positionAt(0), scratch.positionAt(scratch.getText().length)), dirtySource);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(scratch.isDirty);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', scratch.uri);
    const runLens = lenses?.find(lens => lens.command?.command === 'mcpy.runSnippet')?.command;
    assert.ok(runLens, 'native editor exposes an unambiguous game execution action');
    const draftResult = await vscode.commands.executeCommand<OperationResult>(runLens.command, ...runLens.arguments!);
    assert.equal(draftResult?.value, 2);
    assert.ok(api.getRuntimeState().displayed.script.includes('游戏已确认执行完成'));
    assert.ok(api.getRuntimeState().displayed.script.includes('fixture-game-request'));
    assert.ok(scratch.isDirty, 'game execution must not save editor modifications');
    assert.equal(await readFile(scratch.uri.fsPath, 'utf8'), initial, 'execution must leave the scratch disk contents untouched');
    const lastPythonCall = async () => JSON.parse(((await callLog()).split('\n').filter(Boolean).reverse().find(line => {
      const record = JSON.parse(line); return record.args.includes('py');
    }))!);
    const draftCall = await lastPythonCall();
    assert.equal(draftCall.source, dirtySource, 'CLI must receive the exact current dirty UTF-8 contents');
    const executionFile = draftCall.args[draftCall.args.indexOf('--file') + 1];
    assert.notEqual(executionFile, scratch.uri.fsPath, 'execution uses an independent temporary snapshot');
    await assert.rejects(readFile(executionFile), { code: 'ENOENT' }, 'execution snapshot must be removed after use');
    chooseServer = true;
    await vscode.commands.executeCommand('mcpy.changeSnippetTarget', scratch.uri);
    chooseServer = false;
    vscode.window.activeTextEditor!.selection = new vscode.Selection(1, 0, 2, 0);
    await vscode.commands.executeCommand('mcpy.runSnippet', scratch.uri);
    const selectionCall = await lastPythonCall();
    assert.equal(selectionCall.source, 'print("当前内存 🚀")\n', 'selected dirty text takes precedence over the full draft');
    assert.equal(selectionCall.args[selectionCall.args.indexOf('--side') + 1], 'server', 'target change must apply to the same draft');
    assert.ok(await scratch.save(), 'saving in the dedicated directory remains optional');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    await vscode.window.showTextDocument(scratch.uri);
    const reopened = await vscode.commands.executeCommand<OperationResult>('mcpy.runSnippet', scratch.uri);
    assert.equal(reopened?.value, 2, 'closing and reopening a draft must preserve its game target in the current window');
    const legacyUri = vscode.Uri.joinPath(scratch.uri, '..', 'mcpy-runtime-777.py');
    const noResultSource = '# MCPY_NO_RESULT\nprint("hello2")\n';
    await vscode.workspace.fs.writeFile(legacyUri, new TextEncoder().encode(noResultSource));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(legacyUri));
    const languageDeadline = Date.now() + 5000;
    while (vscode.window.activeTextEditor?.document.languageId !== 'mcpy-runtime-python' && Date.now() < languageDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(vscode.window.activeTextEditor?.document.languageId, 'mcpy-runtime-python', 'opened legacy scratch files adopt the game language without directory scanning');
    assert.equal(await readFile(legacyUri.fsPath, 'utf8'), noResultSource, 'language migration must not modify user code');
    const noResult = await vscode.commands.executeCommand<OperationResult>('mcpy.runSnippet', legacyUri);
    assert.equal(noResult?.value, null, 'an unbound restored draft lets the user select a game target before executing');
    const receipt = api.getRuntimeState().transcript.filter(entry => entry.source === 'python').at(-1)?.text ?? '';
    assert.ok(receipt.includes('hello2') && receipt.includes('游戏已确认执行完成'));
    assert.ok(!receipt.includes('结果：null'));
    const editor = await vscode.window.showTextDocument(document);
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
  await writeFile(process.env.MCPY_FIXTURE_START_BARRIER!, 'log-fail');
  await vscode.commands.executeCommand('mcpy.run', clicked);
  const failureDeadline = Date.now() + 10000;
  while (!api.getRuntimeState().displayed.script.includes('fixture 日志失联') && Date.now() < failureDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(api.getRuntimeState().displayed.script.includes('fixture 日志失联'));
  await writeFile(process.env.MCPY_FIXTURE_START_BARRIER!, 'query-fail');
  const knownStart = await vscode.commands.executeCommand<OperationResult>('mcpy.run', clicked);
  assert.equal(knownStart?.session, 'solo-session', 'a failed follow-up query must not erase the confirmed start result');
  assert.ok(api.getRuntimeState().displayed.engine.includes('启动命令已返回，但会话日志尚未连接'));
  await writeFile(process.env.MCPY_FIXTURE_START_BARRIER!, 'fail');
  const failed = await vscode.commands.executeCommand('mcpy.run', clicked);
  assert.equal(failed, undefined);
  assert.ok(api.getRuntimeState().displayed.engine.includes('fixture 启动失败'), 'failed startup leaves its actual error in the engine output');
  const callsAfterFailure = await callLog();
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(await callLog(), callsAfterFailure, 'failed startup must not retry or poll');
  await vscode.window.showTextDocument(document);
  const currentProbe = (call: { args: string[] }) => call.args.includes('modsdk') && call.args[call.args.indexOf('--python') + 1] === '/fixture/changed-a/bin/python';
  const hintDeadline = Date.now() + 10000;
  while (!(await allCalls()).some(currentProbe) && Date.now() < hintDeadline) await new Promise(resolve => setTimeout(resolve, 50));
  const probes = (await allCalls()).filter(call => call.args.includes('modsdk'));
  assert.ok(probes.length, 'recognized workspace must schedule an automatic SDK check');
  assert.ok(probes.every(call => call.args.includes('--inspect') && call.args.includes('--python')), 'automatic checks must be offline/read-only with explicit selected Python');
  const count = probes.filter(currentProbe).length;
  assert.equal(count, 1, 'current resource interpreter must have one cached probe; other workspace scopes can have their own');
  for (let i = 0; i < 4; i++) await vscode.window.showTextDocument(document);
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal((await allCalls()).filter(currentProbe).length, count, 'cached interpreter checks must not repeat on editor navigation');
  console.log('Extension Host: activation, multi-project discovery, start, Python, reload and log snapshot passed.');
}
