import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpyGateway } from '../src/application/ports';
import { Workbench } from '../src/application/workbench';
import { OperationResult, Project, Target, ToolFailure } from '../src/domain/model';

const project: Project = { id: 'a', root: '/a', label: 'A' };
const target: Target = { project, id: 's1', kind: 'session' };
const completed: OperationResult = { ok: true, state: 'completed', details: {} };
function fixture() {
  const calls: string[] = [];
  const gateway: McpyGateway = {
    inspect: async () => ({ sessions: [], groups: [], worlds: [], issues: [] }),
    start: async () => { calls.push('start'); return completed; }, stop: async () => completed,
    capabilities: async () => ({ pythonSides: ['client'], reloadSides: ['client'], pythonReload: true, coordinatedReload: true }),
    execute: async () => { calls.push('execute'); return completed; },
    reload: async () => { calls.push('reload'); return completed; }, logs: async () => '', diagnose: async () => completed
  };
  return { gateway, calls };
}
test('fresh capabilities prevent unsupported server execution with no mutation', async () => {
  const { gateway, calls } = fixture(); const app = new Workbench(gateway);
  await assert.rejects(app.execute(target, 'server', 'print 1'), (e: ToolFailure) => e.kind === 'rejected');
  assert.deepEqual(calls, []);
});
test('group membership routes coordination without guessing process identity', async () => {
  const { gateway } = fixture(); const app = new Workbench(gateway);
  assert.deepEqual(app.coordinatedTarget(project, { id: 's1', state: 'running', mode: 'local', group: 'g1', worldReady: false }),
    { project, id: 'g1', kind: 'group' });
});
test('project mutation lock releases after errors; different projects are independent', async () => {
  const { gateway } = fixture(); let release!: (value: OperationResult) => void;
  gateway.start = async () => new Promise(resolve => { release = resolve; });
  const app = new Workbench(gateway); const pending = app.start(project, {});
  await assert.rejects(app.stop(target), (e: ToolFailure) => e.kind === 'busy');
  assert.equal((await app.stop({ ...target, project: { ...project, id: 'b', root: '/b' } })).ok, true);
  release(completed); await pending;
  assert.equal((await app.stop(target)).ok, true);
});
test('unknown execution is returned once and never retried', async () => {
  const { gateway, calls } = fixture();
  gateway.execute = async () => { calls.push('execute'); throw new ToolFailure('unknown', 'lost response'); };
  const app = new Workbench(gateway);
  await assert.rejects(app.execute(target, 'client', 'side_effect()'), (e: ToolFailure) => e.kind === 'unknown');
  assert.deepEqual(calls, ['execute']); assert.equal((await app.stop(target)).ok, true);
});
test('reload requires actual side or group coordinator capability', async () => {
  const { gateway, calls } = fixture(); const app = new Workbench(gateway);
  await assert.rejects(app.reload(target, 'server', '/file.py'));
  await app.reload({ ...target, kind: 'group', id: 'g1' }, 'server', '/file.py');
  assert.deepEqual(calls, ['reload']);
});
