import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOME,
  classifyTurnEnd,
  classifyAbort,
  isOutcomeEnabled,
  shouldSkipSession,
  dedupeKey,
  errorKey,
  flattenError,
} from '../lib/policy.js';
import { defaultConfig } from '../lib/config.js';

test('classifyTurnEnd：六种 reason 全覆盖', () => {
  assert.deepEqual(classifyTurnEnd({ reason: { kind: 'completed' } }), { outcome: OUTCOME.COMPLETED });
  assert.deepEqual(classifyTurnEnd({ reason: { kind: 'blocked' } }), { outcome: OUTCOME.BLOCKED });
  assert.deepEqual(classifyTurnEnd({ reason: { kind: 'interrupted' } }), { outcome: OUTCOME.INTERRUPTED });
  assert.deepEqual(classifyTurnEnd({ reason: { kind: 'max-tokens' } }), { outcome: OUTCOME.MAX_TOKENS });
  const err = classifyTurnEnd({ reason: { kind: 'error', error: { message: 'boom', code: 'E_X' } } });
  assert.equal(err.outcome, OUTCOME.ERROR);
  assert.match(err.detail, /boom/);
});

test('P0-1：aborted 必须按 cause 细分，disposed 不等于"你主动停止"', () => {
  const user = classifyTurnEnd({ reason: { kind: 'aborted', reason: { kind: 'user' } } });
  assert.equal(user.outcome, OUTCOME.ABORTED_BY_USER);

  for (const cause of [{ kind: 'disposed' }, { kind: 'parent' }, { kind: 'hook', reason: 'denied' }, { kind: 'legacy' }]) {
    const other = classifyTurnEnd({ reason: { kind: 'aborted', reason: cause } });
    assert.equal(other.outcome, OUTCOME.ABORTED_OTHER, `${cause.kind} 不该被当成用户主动停止`);
  }

  const hook = classifyAbort({ kind: 'hook', reason: 'denied' });
  assert.equal(hook.cause, 'hook');
  assert.equal(hook.detail, 'denied');
});

test('classifyTurnEnd：不认识的 reason 返回 null（插件不认识的上游扩展不该乱发信）', () => {
  assert.equal(classifyTurnEnd({ reason: { kind: 'future-reason' } }), null);
  assert.equal(classifyTurnEnd({}), null);
  assert.equal(classifyTurnEnd(null), null);
});

test('开关默认值：完成/出错/卡住/审批开，其余关', () => {
  const config = defaultConfig();
  assert.equal(isOutcomeEnabled(OUTCOME.COMPLETED, config), true);
  assert.equal(isOutcomeEnabled(OUTCOME.ERROR, config), true);
  assert.equal(isOutcomeEnabled(OUTCOME.BLOCKED, config), true);
  assert.equal(isOutcomeEnabled(OUTCOME.APPROVAL, config), true);
  assert.equal(isOutcomeEnabled(OUTCOME.ABORTED_BY_USER, config), false);
  assert.equal(isOutcomeEnabled(OUTCOME.ABORTED_OTHER, config), false);
  assert.equal(isOutcomeEnabled(OUTCOME.INTERRUPTED, config), false);
  assert.equal(isOutcomeEnabled(OUTCOME.MAX_TOKENS, config), false);
});

test('P0-2：子代理会话默认跳过，开关打开后放行', () => {
  const config = defaultConfig();
  assert.equal(shouldSkipSession({ header: { origin: 'subagent' } }, config), true);
  assert.equal(shouldSkipSession({ header: { delegationDepth: 2 } }, config), true);
  assert.equal(shouldSkipSession({ header: { origin: 'subagent' } }, { ...config, includeSubagents: true }), false);
  assert.equal(shouldSkipSession({ header: { cwd: '/tmp/x' } }, config), false);
  assert.equal(shouldSkipSession({}, config), false);
});

test('去重键：错误只按会话+轮次折叠，其它结局各自成键', () => {
  assert.equal(errorKey('s1', 3), dedupeKey('s1', 3, 'error'));
  assert.notEqual(
    dedupeKey('s1', 3, OUTCOME.ABORTED_BY_USER),
    dedupeKey('s1', 3, OUTCOME.ABORTED_OTHER),
  );
  assert.equal(dedupeKey('s1', null, 'completed'), 's1:-:completed');
});

test('flattenError：不抛错、压成一行、有上限', () => {
  assert.equal(flattenError('plain'), 'plain');
  assert.match(flattenError({ message: 'bad', code: 'X' }), /bad \[X\]/);
  assert.equal(flattenError(null), '');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof flattenError(cyclic), 'string');
  assert.ok(flattenError('x'.repeat(1000)).length <= 401);
});
