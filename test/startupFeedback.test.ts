import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartupFeedback } from '../src/application/startupFeedback';

function fixture() {
  let now = 0;
  const logs: string[] = [], statuses: string[] = [];
  const feedback = new StartupFeedback({ log: text => logs.push(text), status: text => statuses.push(text) }, () => now);
  return { feedback, logs, statuses, advance: (seconds: number) => { now = seconds * 1000; feedback.tick(); } };
}
test('startup diagnostics preserve split Unicode, CR progress and partial lines before completion', () => {
  const { feedback, logs, statuses, advance } = fixture();
  feedback.diagnostic('\u001b[3'); feedback.diagnostic('2m下载 中文\u001b[0m\r');
  feedback.diagnostic('\n[script] prepare\n尚未换行');
  assert.ok(logs.some(text => text.includes('下载 中文')));
  assert.ok(!logs.join('').includes('\u001b'));
  advance(1);
  assert.ok(logs.some(text => text.includes('尚未换行')));
  assert.ok(statuses.at(-1)?.includes('1 秒'));
  assert.ok(statuses.at(-1)?.includes('尚未换行'));
});
test('quiet launch reminders are sparse and switch to the observed post-launch stage', () => {
  const { feedback, logs, statuses, advance } = fixture();
  advance(9); assert.equal(logs.filter(line => line.startsWith('[等待]')).length, 0);
  advance(10);
  assert.ok(logs.at(-1)?.includes('尚无新的诊断'));
  for (let second = 11; second < 40; second++) advance(second);
  assert.equal(logs.filter(line => line.startsWith('[等待]')).length, 1);
  feedback.stage('启动已返回；查询会话'); advance(40);
  const reminders = logs.filter(line => line.startsWith('[等待]'));
  assert.equal(reminders.length, 2);
  assert.ok(reminders[1]?.includes('查询会话'));
  assert.ok(!reminders[1]?.includes('登录'));
  assert.ok(!statuses.join('').includes('%'), 'elapsed time must not become invented progress');
});
test('long or unterminated diagnostics are bounded and following normal lines recover', () => {
  const { feedback, logs, advance } = fixture();
  feedback.diagnostic('x'.repeat(100000));
  feedback.diagnostic('y'.repeat(100000)); advance(1);
  feedback.diagnostic('\nnext\n');
  assert.equal(logs.filter(text => text.includes('显示已截断')).length, 1);
  assert.ok(logs.every(text => text.length < 8300));
  assert.ok(logs.at(-1)?.includes('next'));
});
test('completion flushes the last diagnostic and rejects late updates; disposal is silent', () => {
  for (const complete of [true, false]) {
    const { feedback, logs, statuses, advance } = fixture();
    feedback.diagnostic('最后诊断');
    if (complete) { feedback.finish('结果未知；请刷新原会话'); assert.ok(logs.join('').includes('最后诊断')); }
    else feedback.dispose();
    const before = [logs.length, statuses.length];
    feedback.diagnostic('late'); feedback.stage('late'); advance(100); feedback.finish('late');
    assert.deepEqual([logs.length, statuses.length], before);
  }
});
