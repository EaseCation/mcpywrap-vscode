import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), 'mcpy-extension-smoke-'));
try {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json'], { stdio: 'inherit' });
  await build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true,
    platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true });
  const workspace = path.join(temporary, 'workspace');
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  for (const label of ['project-a', 'project-b']) {
    await mkdir(path.join(workspace, label));
    await writeFile(path.join(workspace, label, 'pyproject.toml'), '[tool.mcpywrap]\nproject_type="addon"\n');
    await writeFile(path.join(workspace, label, 'logic.py'), '# coding: utf-8\n_result = 1 + 1\n');
  }
  await writeFile(path.join(workspace, 'README.md'), '# Workspace container\n');
  for (const folder of ['project-a/build/ignored', 'project-b/.mcpy/cache']) {
    await mkdir(path.join(workspace, folder), { recursive: true });
    await writeFile(path.join(workspace, folder, 'pyproject.toml'), '[tool.mcpywrap]\n');
  }
  await writeFile(path.join(workspace, 'project-a/config.json'), '{}\n');
  // Unix executable fixture exercises the exact production executable/argv route.
  // Windows still runs activation/discovery; its transport is covered by node tests.
  const executable = path.join(temporary, 'fake-mcpy');
  await writeFile(executable, `#!${process.execPath}\n${await readFile(path.join(root, 'test/fixtures/extension-cli.cjs'), 'utf8')}`, { mode: 0o700 });
  await writeFile(path.join(workspace, '.vscode/settings.json'), JSON.stringify({
    'mcpy.executable': executable,
    'mcpy.queryTimeoutSeconds': 5
  }));
  const log = path.join(temporary, 'cli.jsonl');
  const version = process.env.VSCODE_TEST_VERSION ?? 'stable';
  let vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH;
  if (!vscodeExecutablePath) {
    vscodeExecutablePath = await downloadAndUnzipVSCode({ version });
    if (process.platform === 'darwin') {
      // New Code bundles renamed Electron to Code. Read the bundle metadata
      // instead of relying on the test helper's historical executable name.
      const plist = path.join(path.dirname(path.dirname(vscodeExecutablePath)), 'Info.plist');
      const binary = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
      vscodeExecutablePath = path.join(path.dirname(vscodeExecutablePath), binary);
    }
  }
  await runTests({
    version,
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, '.test-build/test/extension/index.js'),
    extensionTestsEnv: { MCPY_FIXTURE_LOG: log, MCPY_FIXTURE_WORKSPACE: workspace,
      MCPY_FIXTURE_START_BARRIER: path.join(temporary, 'allow-start') },
    launchArgs: [workspace, '--user-data-dir', path.join(temporary, 'user-data'),
      '--extensions-dir', path.join(temporary, 'extensions'), '--disable-extensions',
      '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates']
  });
  const records = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (process.platform === 'darwin') {
    if (!records.some(r => r.args.includes('py') && r.source === '_result = 1 + 1\n')) throw new Error('Python source did not cross the public CLI boundary');
    if (!records.some(r => r.project.endsWith('project-b') && r.args.includes('run') && !r.args.includes('--list'))) throw new Error('Editor title URI was not routed to project B');
    if (!records.some(r => r.args.includes('reload') && r.args.includes('--group') && r.args.includes('group-one'))) throw new Error('Group member reload did not use group coordination');
    console.log(`Verified ${records.length} public CLI calls in isolated VS Code; no game launched.`);
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
