// dsh-notify-p · 投递账本（落盘，用于"到底发没发出去"的可验证性）
//
// 为什么需要它：cordis 的控制台 exporter 默认只输出 error 级，
// 插件的 info/warn 日志**不会**出现在 dsh 的 stdout 里——
// 所以"看日志确认"是不可行的。这里把每次投递结果落成一个 JSON 文件，
// 出问题时 `cat $DSH_HOME/dsh-notify-p/state.json` 一眼就能看到。
//
// 只写真值，不写密钥、不写正文。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 账本保留的最近投递条数。 */
const RECENT_LIMIT = 50;

/**
 * 解析账本路径：配置优先，其次 $DSH_HOME/dsh-notify-p/state.json，
 * 最后回退 ~/.dsh/dsh-notify-p/state.json。
 * @param {string} [configured] 配置里的 statePath
 * @returns {string} 绝对路径
 */
export function resolveStatePath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  return join(home, 'dsh-notify-p', 'state.json');
}

/**
 * 建一个投递账本。
 * @param {object} [options] 参数
 * @param {string} [options.path] 账本路径
 * @param {object} [options.logger] 日志器
 * @returns {{ record: (entry: object) => void, snapshot: () => object, flush: () => void, path: string }}
 */
export function createLedger(options = {}) {
  const logger = options.logger ?? {};
  const path = resolveStatePath(options.path);
  const startedAt = new Date().toISOString();
  /** @type {object[]} */
  const recent = [];
  const counts = { sent: 0, failed: 0 };

  const persist = () => {
    const payload = {
      version: 1,
      startedAt,
      updatedAt: new Date().toISOString(),
      counts,
      recent,
    };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      // 账本写不进去不能影响发信本身
      logger.debug?.(`dsh-notify-p: 账本写入失败 / ledger write failed: ${String(error)}`);
    }
  };

  // 进程一起来就先落一个文件，避免"文件不存在"被误读成"插件没加载"
  persist();

  return {
    path,
    /**
     * 记一条投递结果。
     * @param {object} entry 结果（at/ok/outcome/sessionId/subject/error/attempts）
     * @returns {void}
     */
    record(entry) {
      if (entry && entry.ok === true) counts.sent += 1;
      else counts.failed += 1;
      recent.push(entry);
      while (recent.length > RECENT_LIMIT) recent.shift();
      persist();
    },
    /**
     * 当前账本内容。
     * @returns {object}
     */
    snapshot() {
      return { version: 1, startedAt, updatedAt: new Date().toISOString(), counts, recent: [...recent] };
    },
    flush: persist,
  };
}

/**
 * 读一个账本文件（排错用）。
 * @param {string} path 账本路径
 * @returns {object|undefined}
 */
export function readLedger(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}
