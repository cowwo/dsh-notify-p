// dsh-notify-p · 发送队列（串行 + 全局限流 + 分类退避重试）
//
// 与"按会话的消抖合并"是两件事，别混：
//   - 消抖（index.js 里的 settle）解决"一个会话多轮 = 几封"
//   - 这个队列解决"几十个会话同时结束 = 打爆 SMTP/Resend"
// 认证类失败绝不重试（重试会放大邮箱风控锁定）；只有网络类才退避。

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 建一个发送队列。
 * @param {object} options 队列参数
 * @param {object} options.logger 日志器
 * @param {() => number} [options.limitPerMinute] 每分钟上限（每次取用都重读，支持热改配置）
 * @param {number} [options.maxAttempts] 单条任务最大尝试次数
 * @param {number[]} [options.backoffMs] 重试退避序列
 * @param {() => number} [options.now] 时钟（测试注入）
 * @param {(ms: number) => Promise<void>} [options.sleep] 睡眠（测试注入）
 * @returns {{ enqueue: (job: object) => number, size: () => number }}
 */
export function createSendQueue(options = {}) {
  const logger = options.logger ?? {};
  const limitOf = typeof options.limitPerMinute === 'function' ? options.limitPerMinute : () => 10;
  const maxAttempts = typeof options.maxAttempts === 'number' ? options.maxAttempts : 3;
  const backoffMs = Array.isArray(options.backoffMs) ? options.backoffMs : [1000, 5000, 15000];
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;

  /** @type {number[]} 最近一分钟内的发送时刻 */
  const stamps = [];
  /** @type {object[]} */
  const jobs = [];
  let draining = false;

  const prereleaseSlot = async () => {
    for (;;) {
      const limit = Math.max(1, Number(limitOf()) || 10);
      const cutoff = now() - 60000;
      while (stamps.length > 0 && stamps[0] <= cutoff) stamps.shift();
      if (stamps.length < limit) {
        stamps.push(now());
        return;
      }
      const wait = Math.max(50, stamps[0] + 60000 - now() + 5);
      logger.debug?.(`dsh-notify-p: 触发限流，等待 ${wait}ms / rate limited, waiting`);
      await sleep(wait);
    }
  };

  const runJob = async (job) => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await prereleaseSlot();
      try {
        const result = await job.run();
        job.onSuccess?.(attempt, result);
        return;
      } catch (error) {
        const retryable = error?.retryable === true;
        if (!retryable || attempt >= maxAttempts) {
          logger.warn?.(`dsh-notify-p: 投递失败 / delivery failed (${job.label ?? 'mail'}): ${error?.message ?? String(error)}`);
          job.onFail?.(error, attempt);
          return;
        }
        const delay = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
        logger.warn?.(`dsh-notify-p: ${error?.message ?? String(error)}；${delay}ms 后重试第 ${attempt + 1}/${maxAttempts} 次`);
        await sleep(delay);
      }
    }
  };

  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      while (jobs.length > 0) {
        const job = jobs.shift();
        try {
          await runJob(job);
        } catch (error) {
          // runJob 自己已经吞掉可预期错误；这里兜底任何意外，保证队列不断流
          logger.warn?.(`dsh-notify-p: 队列任务异常 / queue task threw: ${error?.message ?? String(error)}`);
          job.onFail?.(error, 0);
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    /**
     * 入队一条发送任务；永不抛错、永不阻塞调用方。
     * @param {{ label?: string, run: () => Promise<void>, onSuccess?: Function, onFail?: Function }} job 任务
     * @returns {number} 入队后队列长度
     */
    enqueue(job) {
      jobs.push(job);
      void drain();
      return jobs.length;
    },
    /** @returns {number} 当前排队长度 */
    size: () => jobs.length,
  };
}
