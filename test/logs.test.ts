import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLogEvent } from '../src/infrastructure/mcpy/logs';
import { commands } from '../src/infrastructure/mcpy/commands';
import { readFileSync } from 'node:fs';

test('follow is a single public JSONL command with no finite JSON option', () => {
  const request = commands.follow({ project: { id: 'p', label: 'p', root: '/project' }, kind: 'group', id: 'g1' });
  assert.equal(request.mutation, false);
  assert.deepEqual(request.args.slice(4), ['logs', '--group', 'g1', '--follow', '--source', 'all', '--format', 'jsonl', '--tail', '100']);
  assert.equal(request.args.includes('--json'), false);
});
test('runtime view belongs to a valid bottom panel container, not Explorer fallback', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const panel = manifest.contributes.viewsContainers.panel[0];
  assert.match(panel.id, /^[a-zA-Z0-9_-]+$/);
  assert.ok(manifest.contributes.views[panel.id].some((view: { id: string; type: string }) => view.id === 'mcpy.console' && view.type === 'webview'));
});
test('log parser preserves repeated messages, UTF-8 and partial lines', () => {
  const wire = JSON.stringify({ schema_version: 1, event: 'log', session: 's1', source: 'game', text: '中文\n中文\n半行' });
  assert.deepEqual(parseLogEvent(wire), { kind: 'log', session: 's1', source: 'game', text: '中文\n中文\n半行', role: undefined });
});
test('state, reset, end are separate from log text; invalid contracts fail closed', () => {
  assert.deepEqual(parseLogEvent('{"schema_version":1,"event":"end"}'), { kind: 'end' });
  assert.deepEqual(parseLogEvent('{"schema_version":1,"event":"reset","session":"s1","source":"engine"}'), { kind: 'reset', session: 's1', source: 'engine' });
  for (const wire of ['{}', '{"schema_version":2,"event":"end"}', '{"schema_version":1,"event":"log","source":"game","text":"oops"}']) assert.throws(() => parseLogEvent(wire));
});
