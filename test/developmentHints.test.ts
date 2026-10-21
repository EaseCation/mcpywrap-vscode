import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevelopmentHints } from '../src/application/developmentHints';
import { DevelopmentEnvironmentGateway, PythonSelectionSource } from '../src/application/developmentEnvironments';
import { PythonSelection, SdkInspection } from '../src/domain/developmentEnvironment';
import { Project } from '../src/domain/model';
const project: Project = { id: 'a', root: '/project', label: 'a' };
const selected: PythonSelection = { id: 'venv', path: '/venv/bin/python', executable: '/venv/bin/python', label: 'venv' };
const inspection: SdkInspection = { environment: { invocation: selected.executable, executable: selected.executable, prefix: '/venv', basePrefix: '/base',
  version: '3.14', identity: 'id', purelib: '/venv/lib/site-packages', platlib: '/venv/lib/site-packages' } };
function fixture() {
  let calls = 0, current = selected;
  const gateway: DevelopmentEnvironmentGateway = { inspect: async () => { calls++; return inspection; }, versions: async () => [], install: async () => { throw new Error('automatic install forbidden'); } };
  const python: PythonSelectionSource = { selected: async () => current };
  return { hints: new DevelopmentHints(gateway, python), gateway, calls: () => calls, change: (s: PythonSelection) => { current = s; } };
}
test('automatic setup merges concurrent/offline probes across files and projects by interpreter', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.hints.check({ ...project, id: String(i) }, `file:///project/${i}.py`)));
  assert.equal(f.calls(), 1); assert.equal(results.filter(Boolean).length, 20);
  assert.equal(results[19]?.resource, 'file:///project/19.py');
});
test('missing and inherited SDK prompt once per environment per window; installed SDK stays quiet', async () => {
  const f = fixture(); const snapshot = (await f.hints.check(project, 'file:///project/x.py'))!;
  assert.equal(f.hints.claimPrompt(snapshot), true); assert.equal(f.hints.claimPrompt(snapshot), false);
  f.hints.invalidate(); const again = (await f.hints.check(project, 'file:///project/x.py'))!;
  assert.equal(f.calls(), 2); assert.equal(f.hints.claimPrompt(again), false, 'dismissed prompts do not reappear');
  const other = { ...snapshot, selection: { ...selected, executable: '/other/python' }, inspection: { ...inspection, installed: { version: '3.9', location: '/base/lib', inEnvironment: false } } };
  assert.equal(f.hints.claimPrompt(other), true);
  assert.equal(f.hints.claimPrompt({ ...other, selection: { ...selected, executable: '/ready/python' }, inspection: { ...inspection, installed: { version: '3.9', location: '/ready/lib', inEnvironment: true } } }), false);
});
test('interpreter changes invalidate pending results; no new target is installed', async () => {
  const f = fixture(); let finish!: (value: SdkInspection) => void;
  f.gateway.inspect = async () => new Promise(resolve => { finish = resolve; });
  const pending = f.hints.check(project, 'file:///project/x.py');
  await new Promise(resolve => setImmediate(resolve)); f.hints.invalidate(); finish(inspection);
  assert.equal(await pending, undefined);
});
test('failed checks are cached without retries until explicit invalidation', async () => {
  const f = fixture(); let calls = 0;
  f.gateway.inspect = async () => { calls++; throw new Error('old CLI'); };
  await assert.rejects(f.hints.check(project, 'file:///project/x.py'), /old CLI/);
  await assert.rejects(f.hints.check(project, 'file:///project/y.py'), /old CLI/);
  assert.equal(calls, 1); f.hints.invalidate();
  await assert.rejects(f.hints.check(project, 'file:///project/y.py'), /old CLI/); assert.equal(calls, 2);
});
test('changed selections and mismatched CLI targets never produce readiness hints', async () => {
  const f = fixture();
  f.gateway.inspect = async () => { f.change({ ...selected, id: 'other' }); return inspection; };
  assert.equal(await f.hints.check(project, 'file:///project/x.py'), undefined);
  const other = fixture(); other.gateway.inspect = async () => ({ ...inspection, environment: { ...inspection.environment, invocation: '/wrong/python' } });
  await assert.rejects(other.hints.check(project, 'file:///project/x.py'), /目标不匹配/);
});
