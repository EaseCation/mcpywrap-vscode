// An independent public CLI contract double, not a game simulator.
const fs = require('node:fs');
const args = process.argv.slice(2);
const project = args[args.indexOf('--project') + 1];
const verb = args[4];
const record = { project, args };
if (args.includes('--file')) record.source = fs.readFileSync(args[args.indexOf('--file') + 1], 'utf8');
if (process.env.MCPY_FIXTURE_LOG) fs.appendFileSync(process.env.MCPY_FIXTURE_LOG, JSON.stringify(record) + '\n');
if (args.includes('--follow')) {
  const session = args.includes('--group') ? 'host-session' : args[args.indexOf('--session') + 1];
  for (const source of ['engine', 'game', 'worker']) process.stdout.write(JSON.stringify({ schema_version: 1, event: 'log', session, source,
    text: source === 'game' ? '[Probe] live game 中文\nRN Call: transport\n[Run] script begin\nprint hidden\n[Run] script end\n__MCPY_RESULT_x__abc\n'
      : source === 'engine' ? '[2026-10-21 10:00:00,001] [ERROR][Engine] live engine 中文\n' : 'live worker 中文\n' })+'\n');
  process.stdout.write(JSON.stringify({ schema_version: 1, event: 'end' })+'\n');
  return;
}
if (args[0] !== '--local' || args[3] !== '--non-interactive' || args.at(-1) !== '--json') {
  process.stdout.write(JSON.stringify({ ok: false, error: 'incorrect public CLI prefix' })); process.exit(1);
}
let result = { ok: true };
if (verb === 'status') result = { ok: true,
  sessions: [
    { session: 'solo-session', state: 'running', mode: 'local', world_ready: true },
    { session: 'host-session', state: 'running', mode: 'local', role: 'host', group: 'group-one' },
    { session: 'guest-session', state: 'running', mode: 'network', role: 'guest', group: 'group-one' }
  ], groups: [{ group: 'group-one', state: 'waiting_for_join', members: [{ session: 'host-session' }, { session: 'guest-session' }] }]
};
else if (verb === 'run') result = args.includes('--list')
  ? { ok: true, instances: [{ level_id: 'world-one', name: '测试世界', state: 'ready' }] }
  : { ok: true, state: args.includes('--clients') ? 'waiting_for_join' : 'running', session: 'solo-session',
    ...(args.includes('--clients') ? { group: 'group-one' } : {}), already_running: true, source_matches: false, hint: '复用现有进程，源码尚未应用。' };
else if (verb === 'runtime' && args.includes('capabilities')) result = {
  ok: true, python: { sides: ['client', 'server'], reload_sides: ['client', 'server'] },
  reload: { python: { state: 'available' } }, coordinated_reload: true
};
else if (verb === 'runtime') result = { ok: true, state: 'completed', stdout: 'fixture stdout', value: 2 };
else if (verb === 'logs') result = { ok: true, text: 'fixture game log\n', logs: [{ role: 'host', session: 'host-session', text: 'host log' }] };
else if (verb === 'doctor') result = { ok: true, state: 'ready', hint: 'contract fixture only' };
process.stdout.write(JSON.stringify(result));
