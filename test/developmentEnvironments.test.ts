import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevelopmentEnvironments, DevelopmentEnvironmentGateway, PythonSelectionSource } from '../src/application/developmentEnvironments';
import { PythonSelection, SdkInspection } from '../src/domain/developmentEnvironment';
import { Project } from '../src/domain/model';
import { CliDevelopmentEnvironmentGateway } from '../src/infrastructure/mcpy/developmentEnvironment';
import { CliRequest } from '../src/application/ports';

const project: Project = { id: 'a', root: '/中文 project', label: 'a' };
const a: PythonSelection = { id: 'a', path: '/a/.venv/bin/python', executable: '/a/.venv/bin/python', label: 'a' };
const b: PythonSelection = { id: 'b', path: '/b/.venv/bin/python', executable: '/b/.venv/bin/python', label: 'b' };
const inspect = (selection = a): SdkInspection => ({ environment: { invocation: selection.executable, executable: selection.executable,
  prefix: '/a/.venv', basePrefix: '/system', version: '3.12', identity: 'opaque-a', purelib: '/a/.venv/lib/site-packages', platlib: '/a/.venv/lib/site-packages' },
  installed: { version: '3.9.0.1', location: '/a/.venv/lib/site-packages', inEnvironment: true } });
function fixture() {
  let current = a;
  const calls: unknown[] = [];
  const source: PythonSelectionSource = { selected: async resource => { calls.push({ resource }); return current; } };
  const gateway: DevelopmentEnvironmentGateway = { inspect: async (_p, python) => { calls.push({ inspect: python }); return inspect(current); },
    versions: async () => ['3.9.0.1'], install: async (_p, python, version, identity) => { calls.push({ python, version, identity }); return inspect(); } };
  return { source, gateway, calls, select: (s: PythonSelection) => { current = s; }, service: new DevelopmentEnvironments(gateway, source) };
}
test('development checks use actual resource selection and preserve venv invocation', async () => {
  const f = fixture(); const snapshot = await f.service.inspect(project, 'file:///a/src/code.py');
  assert.equal(snapshot.inspection.environment.invocation, a.executable);
  assert.deepEqual(f.calls, [{ resource: 'file:///a/src/code.py' }, { inspect: a.executable }, { resource: 'file:///a/src/code.py' }]);
});
test('selection changes during inspection invalidate result', async () => {
  const f = fixture(); f.gateway.inspect = async () => { f.select(b); return inspect(); };
  await assert.rejects(f.service.inspect(project, 'file:///a/x.py'), /选择已改变/);
});
test('selection changes before install never submit mutation', async () => {
  const f = fixture(); const snapshot = await f.service.inspect(project, 'file:///a/x.py'); f.calls.length = 0; f.select(b);
  await assert.rejects(f.service.install(project, snapshot, '3.9.0.1'), /未提交安装/);
  assert.equal(f.calls.length, 1);
});
test('selection changes during install keep original target and never mark new env ready', async () => {
  const f = fixture(); const snapshot = await f.service.inspect(project, 'file:///a/x.py');
  f.gateway.install = async (_p, python, _version, identity) => { assert.equal(python, a.executable); assert.equal(identity, 'opaque-a'); f.select(b); return inspect(); };
  const result = await f.service.install(project, snapshot, '3.9.0.1');
  assert.equal(result.selectionMatches, false); assert.equal(result.inspection.environment.invocation, a.executable);
});
test('SDK receipt requires environment identity, target and non-inherited matching version', async () => {
  for (const bad of [ { ...inspect(), installed: undefined }, { ...inspect(), installed: { ...inspect().installed!, inEnvironment: false } },
    { ...inspect(), environment: { ...inspect().environment, identity: 'other' } },
    { ...inspect(), environment: { ...inspect().environment, invocation: b.executable } },
    { ...inspect(), installed: { ...inspect().installed!, version: 'other' } } ]) {
    const f = fixture(); const snapshot = await f.service.inspect(project, 'file:///a/x.py'); f.gateway.install = async () => bad;
    await assert.rejects(f.service.install(project, snapshot, '3.9.0.1'));
  }
});
test('same interpreter cannot have concurrent installs; failed requests never retry and release lock', async () => {
  const f = fixture(); const snapshot = await f.service.inspect(project, 'file:///a/x.py');
  let reject!: (error: Error) => void; let submitted!: () => void;
  const barrier = new Promise<void>(resolve => { submitted = resolve; });
  let calls = 0;
  f.gateway.install = async () => { calls++; submitted(); return new Promise((_resolve, fail) => { reject = fail; }); };
  const first = f.service.install(project, snapshot, '3.9.0.1'); await barrier;
  await assert.rejects(f.service.install(project, snapshot, '3.9.0.1'), /仍在进行/);
  reject(new Error('unknown')); await assert.rejects(first, /unknown/); assert.equal(calls, 1);
  f.gateway.install = async () => inspect(); assert.equal((await f.service.install(project, snapshot, '3.9.0.1')).selectionMatches, true);
});
test('missing Python API selection does not fall back to CLI or default Python', async () => {
  const f = fixture(); f.source.selected = async () => { throw new Error('no interpreter'); };
  await assert.rejects(f.service.inspect(project, 'file:///a/x.py'), /no interpreter/); assert.equal(f.calls.length, 0);
});
test('SDK public CLI argv freeze interpreter and opaque fingerprint; malformed responses fail closed', async () => {
  const calls: CliRequest[] = [];
  const response = { ok: true, environment: { invocation: a.executable, executable: a.executable, prefix: '/a/.venv', base_prefix: '/system',
    version: '3.12', identity: 'opaque-a', purelib: '/lib', platlib: '/lib' }, installed: null };
  const gateway = new CliDevelopmentEnvironmentGateway({ request: async request => { calls.push(request); return response; } });
  await gateway.inspect(project, a.executable);
  assert.equal(calls[0]?.mutation, false);
  assert.deepEqual(calls[0]?.args.slice(4), ['modsdk', '--inspect', '--python', a.executable, '--json']);
  await gateway.install(project, a.executable, '3.9.0.1', 'opaque-a');
  assert.equal(calls[1]?.mutation, true);
  assert.deepEqual(calls[1]?.args.slice(4), ['modsdk', '--version', '3.9.0.1', '--python', a.executable, '--expected-environment', 'opaque-a', '--json']);
  for (const bad of [{ ok: true }, { ok: true, versions: [] }, { ok: false, error: 'No such option: --inspect' }]) {
    const broken = new CliDevelopmentEnvironmentGateway({ request: async () => bad });
    await assert.rejects(broken.inspect(project, a.executable));
  }
});
