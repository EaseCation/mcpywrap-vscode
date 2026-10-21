import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliRequest, CliTransport, TemporarySource } from '../src/application/ports';
import { Project, Target, ToolFailure } from '../src/domain/model';
import { commands } from '../src/infrastructure/mcpy/commands';
import { CliGateway } from '../src/infrastructure/mcpy/gateway';
import { Workbench } from '../src/application/workbench';

const project: Project = { id: 'a', root: '/space and 中文/project', label: 'a' };
const session: Target = { project, id: 's1', kind: 'session' };
const group: Target = { project, id: 'g1', kind: 'group' };
const source: TemporarySource = { withFile: async (_code, action) => action('/temp/source.py') };
class FixtureTransport implements CliTransport {
  calls: CliRequest[] = [];
  constructor(private readonly reply: (command: CliRequest) => Record<string, unknown>) {}
  async request(command: CliRequest) { this.calls.push(command); return this.reply(command); }
}
test('start forwards diagnostics through the application without polling or changing CLI arguments', async () => {
  const wire = new FixtureTransport(command => {
    command.diagnostic?.('正在准备资源\n');
    return { ok: true, session: 's1', state: 'running' };
  });
  const messages: string[] = [];
  const result = await new Workbench(new CliGateway(wire, source)).start(project, {}, text => messages.push(text));
  assert.equal(result.session, 's1'); assert.deepEqual(messages, ['正在准备资源\n']);
  assert.equal(wire.calls.length, 1);
  assert.deepEqual(wire.calls[0]?.args, commands.start(project, {}).args);
});
test('commands are one-way public CLI calls with explicit route, root and JSON', () => {
  assert.deepEqual(commands.start(project, { world: 'world-id', clients: 2 }).args, [
    '--local', '--project', project.root, '--non-interactive', 'run', 'world-id',
    '--no-gui', '--detach', '--clients', '2', '--json'
  ]);
  assert.deepEqual(commands.reload(group, 'server', '/a b/file.py').args.slice(4), [
    'runtime', 'reload', 'python', '--group', 'g1', '--side', 'server', '--file', '/a b/file.py', '--json'
  ]);
  assert.equal(commands.status(project).mutation, false); assert.equal(commands.execute(session, 'client', '/x').mutation, true);
});
test('inspect keeps worlds, sessions and groups separate; recovers group membership', async () => {
  const gateway = new CliGateway(new FixtureTransport(c => c.args.includes('status') ? {
    ok: true, sessions: [{ session: 's1', state: 'running', mode: 'local', world_ready: true }],
    groups: [{ group: 'g1', state: 'waiting_for_join', members: [{ session: 's1' }] }], future: true
  } : { ok: true, instances: [{ level_id: 'world1', name: '中文世界', state: 'ready' }] }), source);
  const snapshot = await gateway.inspect(project);
  assert.equal(snapshot.sessions[0]?.group, 'g1'); assert.equal(snapshot.groups[0]?.state, 'waiting_for_join');
  assert.equal(snapshot.worlds[0]?.id, 'world1'); assert.equal(snapshot.sessions[0]?.worldReady, true);
});
test('world query failure preserves usable sessions and an explicit issue', async () => {
  const gateway = new CliGateway(new FixtureTransport(c => c.args.includes('status') ? {
    ok: true, sessions: [], groups: []
  } : { ok: false, error: 'unsupported map platform' }), source);
  const snapshot = await gateway.inspect(project);
  assert.equal(snapshot.issues.length, 1); assert.deepEqual(snapshot.sessions, []);
});
test('invalid status identities are rejected, never converted to empty sessions', async () => {
  const gateway = new CliGateway(new FixtureTransport(() => ({ ok: true, sessions: [{ state: 'running' }], groups: [] })), source);
  await assert.rejects(gateway.inspect(project), (e: ToolFailure) => e.kind === 'invalidResponse');
});
test('capabilities fail closed for missing/unknown sides and reload', async () => {
  const gateway = new CliGateway(new FixtureTransport(() => ({ ok: true, python: { sides: ['client', 'both', 'future'], reload_sides: [] } })), source);
  const caps = await gateway.capabilities(session);
  assert.deepEqual(caps.pythonSides, ['client']); assert.equal(caps.pythonReload, false);
});
test('execution preserves failed/unknown results, errors and request identity', async () => {
  const wire = new FixtureTransport(() => ({ ok: false, state: 'unknown', request_id: 'request-original', error: 'timeout', stdout: 'partial output' }));
  const result = await new CliGateway(wire, source).execute(session, 'server', 'print 1');
  assert.equal(result.ok, false); assert.equal(result.requestId, 'request-original'); assert.equal(result.stdout, 'partial output');
  assert.equal(wire.calls.length, 1);
});
test('successful start without target ID is unknown', async () => {
  const gateway = new CliGateway(new FixtureTransport(() => ({ ok: true, state: 'running' })), source);
  await assert.rejects(gateway.start(project, {}), (e: ToolFailure) => e.kind === 'unknown');
});
test('execution and reload with a missing outcome are unknown rather than success', async () => {
  const gateway = new CliGateway(new FixtureTransport(() => ({ ok: true })), source);
  await assert.rejects(gateway.execute(session, 'client', 'side_effect()'), (e: ToolFailure) => e.kind === 'unknown');
  await assert.rejects(gateway.reload(group, 'client', '/file.py'), (e: ToolFailure) => e.kind === 'unknown');
});
test('completed Python receipts require matching game session and side; missing identities are unknown', async () => {
  for (const extra of [{}, { session: 's1' }, { side: 'client' }, { session: 'other', side: 'client' }, { session: 's1', side: 'server' }]) {
    const wire = new FixtureTransport(() => ({ ok: true, state: 'completed', ...extra }));
    await assert.rejects(new CliGateway(wire, source).execute(session, 'client', 'print("hello")'), (e: ToolFailure) => e.kind === 'unknown');
    assert.equal(wire.calls.length, 1);
  }
  const wire = new FixtureTransport(() => ({ ok: true, state: 'completed', session: 's1', side: 'client', value: null, request_id: 'game-request' }));
  const result = await new CliGateway(wire, source).execute(session, 'client', 'print("hello")');
  assert.equal(result.side, 'client'); assert.equal(result.requestId, 'game-request'); assert.equal(result.value, null);
});
test('partial group reload retains per-member evidence', async () => {
  const gateway = new CliGateway(new FixtureTransport(() => ({ ok: false, state: 'partial', results: [{ session: 's1', state: 'completed' }, { session: 's2', state: 'failed' }] })), source);
  const result = await gateway.reload(group, 'client', '/file.py');
  assert.equal(result.state, 'partial'); assert.equal((result.details.results as unknown[]).length, 2);
});
test('group logs label actual session and role; malformed logs fail', async () => {
  const gateway = new CliGateway(new FixtureTransport(() => ({ ok: true, logs: [{ session: 's1', role: 'host', text: 'loaded' }] })), source);
  assert.equal(await gateway.logs(group, 'game'), '[host s1]\nloaded');
  await assert.rejects(gateway.logs(session, 'game'), (e: ToolFailure) => e.kind === 'invalidResponse');
});
