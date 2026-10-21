import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionReceipt, executionRequest } from '../src/application/executionReceipt';
import { OperationResult, Target } from '../src/domain/model';

const target: Target = { project: { id: 'project', root: '/project/中文', label: 'project' }, kind: 'session', id: 'game-session' };
const completed: OperationResult = { ok: true, state: 'completed', session: target.id, side: 'client', requestId: 'real-game-request', details: {} };
test('no return value leaves stdout and the game receipt without a null result line', () => {
  for (const value of [null, undefined]) {
    const rendered = executionReceipt(target, 'client', { ...completed, value, stdout: 'hello2\n' }, 1);
    assert.ok(rendered.includes('hello2'));
    assert.ok(rendered.includes('游戏已确认执行完成'));
    assert.ok(rendered.includes('game-session') && rendered.includes('客户端') && rendered.includes('real-game-request'));
    assert.ok(!rendered.includes('结果：'));
  }
});
test('meaningful falsey values and empty collections are still shown', () => {
  for (const value of [0, false, '', [], {}]) assert.ok(executionReceipt(target, 'client', { ...completed, value }, 1).includes(`结果：${JSON.stringify(value)}`));
});
test('unknown, rejected and mismatched receipts never claim game completion', () => {
  for (const result of [
    { ...completed, ok: false, state: 'unknown' }, { ...completed, ok: false, state: 'unavailable' },
    { ...completed, session: 'other-game' }, { ...completed, side: 'server' as const }, { ...completed, side: undefined }
  ]) assert.ok(!executionReceipt(target, 'client', result, 1).includes('游戏已确认执行完成'));
});
test('request preview distinguishes the game target, omits header instructions and remains bounded', () => {
  const rendered = executionRequest(target, 'server', '# 提示\r\n# 编码\r\nprint("hello")\r\n', 4);
  assert.ok(rendered.includes('服务端 (server)') && rendered.includes(target.id) && rendered.includes(target.project.root));
  assert.ok(rendered.includes('print("hello")'));
  assert.ok(!rendered.includes('# 提示') && !rendered.includes('预览已省略'));
  assert.ok(executionRequest(target, 'client', 'x'.repeat(32768), 5).length < 2200);
});
