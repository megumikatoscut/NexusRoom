import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from '../src/NexusRoom.Host/Agent/harness-limits.mjs';

function hooks(config) {
  const handlers = new Map();
  apply({ on: (name, handler) => handlers.set(name, handler) }, config);
  return handlers;
}

test('model limit counts model requests, not tool calls, and prevents the excess request', () => {
  const handlers = hooks({ maxCalls: 2, maxSteps: 5 });
  let requests = 0;
  const next = () => ++requests;
  assert.equal(handlers.get('llm/stream')({}, next), 1);
  assert.equal(handlers.get('tools/execute')({}, () => 'tool-result'), 'tool-result');
  assert.equal(handlers.get('llm/stream')({}, next), 2);
  assert.throws(() => handlers.get('llm/stream')({}, next), { code: 'NEXUSROOM_LIMIT' });
  assert.equal(requests, 2);
});

test('tool limit rejects before side effects and concludes the native Harness turn', () => {
  const handlers = hooks({ maxCalls: 10, maxSteps: 1 });
  let executed = 0;
  const next = () => ++executed;
  assert.equal(handlers.get('tools/execute')({}, next), 1);
  const rejected = handlers.get('tools/execute')({}, next);
  assert.equal(executed, 1);
  assert.equal(rejected.isError, true);
  assert.equal(rejected.concludesTurn, true);
  assert.equal(rejected.error.info.code, 'NEXUSROOM_LIMIT');
});

test('all sessions and subagents share a task budget in one runtime', () => {
  const handlers = hooks({ maxCalls: 1, maxSteps: 1 });
  handlers.get('llm/stream')({ sessionId: 'parent' }, () => true);
  assert.throws(() => handlers.get('llm/stream')({ sessionId: 'child' }, () => true), /最多模型调用/);
});

test('invalid budgets fail activation rather than silently disabling limits', () => {
  for (const maxCalls of [0, -1, 201, NaN, 1.5]) assert.throws(() => hooks({ maxCalls, maxSteps: 1 }));
  for (const maxSteps of [0, -1, 101, NaN, 1.5]) assert.throws(() => hooks({ maxCalls: 1, maxSteps }));
});
