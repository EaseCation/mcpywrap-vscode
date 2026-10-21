import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogHistory, LogLines, logPart } from '../src/application/logHistory';

test('script protocol filter matches mcpywrap and preserves repeated application logs', () => {
  const lines = new LogLines();
  const result = lines.feed('[Run] script begin\nimport secret\n[Run] script end\nRN Call: x\nRN Return: x\n__MCPY_RESULT_x__abc\n[Probe] 中文\n[Probe] 中文\n');
  assert.equal(result.filter(line => line.visible).map(line => line.text).join(''), '[Probe] 中文\n[Probe] 中文\n');
  assert.equal(result.filter(line => !line.visible).length, 6);
});
test('partial markers, CRLF boundaries and final partial lines keep their context', () => {
  const lines = new LogLines();
  assert.deepEqual(lines.feed('RN Ca'), []);
  assert.equal(lines.feed('ll: hidden\r')[0], undefined);
  assert.equal(lines.feed('\nuser log\r\n')[0]?.visible, false);
  assert.deepEqual(lines.feed('末尾', true), [{ text: '末尾', visible: true }]);
});
test('engine/worker and script/Python remain two distinct native sources', () => {
  assert.equal(logPart('engine'), 'engine'); assert.equal(logPart('worker'), 'engine');
  assert.equal(logPart('game'), 'script'); assert.equal(logPart('python'), 'script');
});
test('raw/filtered replay shares bounded history without requiring another reader', () => {
  const history = new LogHistory(256);
  history.append({ source: 'game', label: 'project · client a123', text: 'RN Call: details\n', visible: false });
  history.append({ source: 'game', label: 'project · client a123', text: '[Probe] ready\n', visible: true });
  assert.ok(history.snapshot(true).includes('RN Call:')); assert.ok(!history.snapshot(false).includes('RN Call:'));
  assert.ok(history.snapshot(false).includes('[Probe] ready'));
  for (let i = 0; i < 1000; i++) history.append({ source: 'game', label: 'p', text: `${i} repeated\n`, visible: true });
  assert.ok(history.snapshot(true).length < 512); assert.ok(history.snapshot(true).includes('999 repeated'));
});
