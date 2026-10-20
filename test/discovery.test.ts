import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FilesystemDiscovery } from '../src/infrastructure/workspace/discovery';
import { Utf8TemporarySource } from '../src/infrastructure/mcpy/source';
import { access, readFile } from 'node:fs/promises';

test('discovery parses TOML, supports explicit nested roots, deduplicates and does not scan recursively', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcpy-workspace-'));
  try {
    const nested = path.join(root, '中文 child'); await mkdir(nested);
    await writeFile(path.join(root, 'pyproject.toml'), '# [tool.mcpywrap]\n[project]\nname="plain"\n');
    await writeFile(path.join(nested, 'pyproject.toml'), '[tool."mcpywrap"]\nproject_type="addon"\n');
    const discovery = new FilesystemDiscovery();
    assert.equal((await discovery.discover([{ root, configured: [] }])).projects.length, 0);
    const found = await discovery.discover([{ root, configured: ['中文 child', './中文 child'] }]);
    assert.equal(found.projects.length, 1); assert.equal(found.issues.length, 0);
    assert.equal(discovery.containing(found.projects, path.join(nested, 'logic.py'))?.id, found.projects[0]?.id);
    assert.equal(discovery.containing(found.projects, `${nested}-other/logic.py`), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('invalid TOML is an issue, not an unidentified project; configured missing roots are visible', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mcpy-bad-config-'));
  try {
    await writeFile(path.join(root, 'pyproject.toml'), '[tool.');
    const result = await new FilesystemDiscovery().discover([{ root, configured: [] }, { root, configured: ['missing'] }]);
    assert.equal(result.projects.length, 0); assert.equal(result.issues.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('longest containing project wins rather than unrelated active target', () => {
  const parent = { id: 'p', root: path.resolve('fixture'), label: 'p' };
  const child = { id: 'c', root: path.join(parent.root, 'nested'), label: 'c' };
  assert.equal(new FilesystemDiscovery().containing([parent, child], path.join(child.root, 'a.py'))?.id, 'c');
});
test('temporary source preserves exact UTF-8 and is removed after success or failure', async () => {
  for (const fail of [false, true]) {
    let filename = '';
    const action = new Utf8TemporarySource().withFile('print "中文"\n', async file => {
      filename = file; assert.equal(await readFile(file, 'utf8'), 'print "中文"\n');
      if (fail) throw new Error('execution failed'); return 42;
    });
    if (fail) await assert.rejects(action); else assert.equal(await action, 42);
    await assert.rejects(access(filename));
  }
});
