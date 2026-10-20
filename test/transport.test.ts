import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ProcessTransport } from '../src/infrastructure/mcpy/transport';
import { Project, ToolFailure } from '../src/domain/model';

const project: Project = { id: 'fixture', root: process.cwd(), label: 'fixture' };
const fixture = path.resolve('test/fixtures/cli.cjs');
function transport(timeout = 3000, executable = process.execPath) {
  return new ProcessTransport(() => ({ executable, queryTimeoutMs: timeout, operationTimeoutMs: timeout }));
}
test('spawn uses argv literally, no shell; cwd is the selected project', async () => {
  const args = [fixture, 'echo', 'a b', '中文路径', '`touch nope`', '$(touch nope)', 'x; echo nope', 'a&b'];
  const result = await transport().request({ project, args, mutation: false });
  assert.deepEqual(result.args, args.slice(1)); assert.equal(result.cwd, project.root);
});
test('UTF-8 characters split across chunks survive; stderr is separate', async () => {
  const result = await transport().request({ project, args: [fixture, 'unicode'], mutation: false });
  assert.equal(result.text, '中文 · 世界 🌍');
});
test('nonzero explicit CLI failure keeps structured data', async () => {
  const result = await transport().request({ project, args: [fixture, 'failed'], mutation: true });
  assert.equal(result.ok, false); assert.equal(result.code, 'busy');
});
for (const mode of ['invalid', 'missing-ok', 'contradiction', 'overflow']) {
  test(`${mode}: submitted mutations become unknown, never success`, async () => {
    await assert.rejects(transport().request({ project, args: [fixture, mode], mutation: true }),
      (error: ToolFailure) => error.kind === 'unknown');
  });
}
test('query with invalid JSON is an invalid response, not an empty list', async () => {
  await assert.rejects(transport().request({ project, args: [fixture, 'invalid'], mutation: false }),
    (error: ToolFailure) => error.kind === 'invalidResponse');
});
test('timeout distinguishes unknown mutation from failed query', async () => {
  for (const mutation of [false, true]) {
    await assert.rejects(transport(150).request({ project, args: [fixture, 'hang'], mutation }),
      (error: ToolFailure) => error.kind === (mutation ? 'unknown' : 'queryFailed'));
  }
});
test('missing executable is not submitted', async () => {
  await assert.rejects(transport(1000, path.resolve('no-such-mcpy')).request({ project, args: [], mutation: true }),
    (error: ToolFailure) => error.kind === 'unavailable');
});
test('disposing the client ends CLI waits without issuing stop or repeating a mutation', async () => {
  const client = transport();
  const waiting = client.request({ project, args: [fixture, 'hang'], mutation: true });
  const rejected = assert.rejects(waiting, (error: ToolFailure) => error.kind === 'unknown');
  client.dispose();
  await rejected;
  await assert.rejects(client.request({ project, args: [fixture, 'echo'], mutation: true }),
    (error: ToolFailure) => error.kind === 'unavailable');
});
