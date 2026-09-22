import test from 'node:test';
import assert from 'node:assert/strict';

import { createSendQueue } from '../lib/queue.js';

/**
 * 造一个可观测的假时钟 + 任务，等全部落定。
 * @param {object} options 参数
 * @returns {Promise<{ settled: object[], slept: number[], clock: object }>}
 */
async function runQueue(options) {
  const settled = [];
  const slept = [];
  const clock = { t: 0 };
  const total = options.jobs.length;

  const queue = createSendQueue({
    logger: {},
    limitPerMinute: options.limitPerMinute,
    maxAttempts: options.maxAttempts,
    backoffMs: options.backoffMs,
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  });

  for (const job of options.jobs) {
    queue.enqueue({
      label: job.label,
      run: job.run,
      onSuccess: () => settled.push({ label: job.label, ok: true }),
      onFail: (error) => settled.push({ label: job.label, ok: false, error }),
    });
  }

  for (let i = 0; i < 200 && settled.length < total; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(settled.length, total, '所有任务都该落定');
  return { settled, slept, clock };
}

test('队列：串行执行 + 限流（第 3 封要等满窗口）', async () => {
  const order = [];
  const { settled, slept } = await runQueue({
    limitPerMinute: () => 2,
    maxAttempts: 1,
    backoffMs: [1],
    jobs: [1, 2, 3].map((n) => ({ label: `j${n}`, run: async () => { order.push(n); } })),
  });
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(settled.filter((s) => s.ok).length, 3);
  assert.ok(slept.some((ms) => ms > 50000), '第 3 封应该等满一分钟窗口');
});

test('队列：网络类失败退避重试并最终成功', async () => {
  let attempts = 0;
  const { settled, slept } = await runQueue({
    limitPerMinute: () => 100,
    maxAttempts: 3,
    backoffMs: [1000, 5000],
    jobs: [{
      label: 'flaky',
      run: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error('socket hangup');
          error.retryable = true;
          throw error;
        }
      },
    }],
  });
  assert.equal(attempts, 3);
  assert.deepEqual(slept.filter((ms) => ms >= 1000), [1000, 5000]);
  assert.deepEqual(settled, [{ label: 'flaky', ok: true }]);
});

test('队列：不可重试的失败只尝试一次（认证错误不放大风控）', async () => {
  let attempts = 0;
  const { settled } = await runQueue({
    limitPerMinute: () => 100,
    maxAttempts: 3,
    backoffMs: [1],
    jobs: [{
      label: 'auth',
      run: async () => {
        attempts += 1;
        const error = new Error('535 auth failed');
        error.retryable = false;
        throw error;
      },
    }],
  });
  assert.equal(attempts, 1);
  assert.equal(settled[0].ok, false);
});

test('队列：任务抛非对象错误也不会断流', async () => {
  const { settled } = await runQueue({
    limitPerMinute: () => 100,
    maxAttempts: 1,
    backoffMs: [1],
    jobs: [
      { label: 'boom', run: async () => { throw 'plain string'; } },
      { label: 'after', run: async () => {} },
    ],
  });
  assert.equal(settled.length, 2);
  assert.equal(settled[1].ok, true);
});
