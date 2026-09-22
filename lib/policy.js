// dsh-notify-p · 事件判定层（纯函数，无 cordis 依赖，可直接单测）
//
// 承担两件在评审里被点名的正确性的事：
//   P0-1  aborted 必须按 cause 细分，不能一律当"你主动停止"
//         （重启/热更/被父级取消都会以 disposed/parent 结束活跃回合）
//   P0-2  子代理会话默认跳过（一个 workflow 能扇出几十个子会话）

/** 结局类型（插件内部词汇，与 settings 开关一一对应）。 */
export const OUTCOME = {
  COMPLETED: 'completed',
  ERROR: 'error',
  BLOCKED: 'blocked',
  ABORTED_BY_USER: 'abortedByUser',
  ABORTED_OTHER: 'abortedOther',
  INTERRUPTED: 'interrupted',
  MAX_TOKENS: 'maxTokens',
  APPROVAL: 'approval',
};

/** 结局 → settings 开关字段。 */
const SWITCH_FIELD = {
  [OUTCOME.COMPLETED]: 'notifyCompleted',
  [OUTCOME.ERROR]: 'notifyError',
  [OUTCOME.BLOCKED]: 'notifyBlocked',
  [OUTCOME.ABORTED_BY_USER]: 'notifyAbortedByUser',
  [OUTCOME.ABORTED_OTHER]: 'notifyInterrupted',
  [OUTCOME.INTERRUPTED]: 'notifyInterrupted',
  [OUTCOME.MAX_TOKENS]: 'notifyMaxTokens',
  [OUTCOME.APPROVAL]: 'notifyApproval',
};

/**
 * 把任意 error 压成一行可读文本（不抛错、有长度上限）。
 * @param {unknown} error turn/end 的 LlmFailure 或 agent/error 的原始抛出值
 * @param {number} [limit] 长度上限
 * @returns {string}
 */
export function flattenError(error, limit = 400) {
  let text = '';
  if (typeof error === 'string') text = error;
  else if (error && typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : '';
    const code = typeof error.code === 'string' ? error.code : '';
    if (message !== '' || code !== '') {
      text = code !== '' ? `${message}${message === '' ? '' : ' '}[${code}]` : message;
    } else {
      try {
        text = JSON.stringify(error);
      } catch {
        text = String(error);
      }
    }
  } else if (error !== undefined && error !== null) {
    text = String(error);
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 细分 aborted 的取消原因。
 * @param {unknown} cause TurnEndCancelCause
 * @returns {{ outcome: string, cause: string, detail: string }}
 */
export function classifyAbort(cause) {
  const c = cause && typeof cause === 'object' ? cause : { kind: 'legacy' };
  const kind = typeof c.kind === 'string' ? c.kind : 'legacy';
  if (kind === 'user') return { outcome: OUTCOME.ABORTED_BY_USER, cause: 'user', detail: '' };
  return {
    outcome: OUTCOME.ABORTED_OTHER,
    cause: kind,
    detail: typeof c.reason === 'string' ? c.reason : '',
  };
}

/**
 * 判定一个 `turn/end` 事件的结局。
 * @param {{reason?: {kind?: string, reason?: unknown, error?: unknown}}} data turn/end 的事件载荷
 * @returns {{ outcome: string, cause?: string, detail?: string }|null} 不认识的 reason 返回 null
 */
export function classifyTurnEnd(data) {
  const reason = data && typeof data === 'object' ? data.reason : null;
  const kind = reason && typeof reason === 'object' ? reason.kind : null;
  switch (kind) {
    case 'completed':
      return { outcome: OUTCOME.COMPLETED };
    case 'max-tokens':
      return { outcome: OUTCOME.MAX_TOKENS };
    case 'blocked':
      return { outcome: OUTCOME.BLOCKED };
    case 'interrupted':
      return { outcome: OUTCOME.INTERRUPTED };
    case 'error':
      return { outcome: OUTCOME.ERROR, detail: flattenError(reason.error) };
    case 'aborted':
      return classifyAbort(reason.reason);
    default:
      return null;
  }
}

/**
 * 该结局在当前配置下要不要发信。
 * @param {string} outcome OUTCOME 之一
 * @param {object} config 已解析配置
 * @returns {boolean}
 */
export function isOutcomeEnabled(outcome, config) {
  const field = SWITCH_FIELD[outcome];
  if (field === undefined) return false;
  return config?.[field] === true;
}

/**
 * 子代理会话判定（P0-2）。
 * @param {object} session Session 对象（含 header）
 * @param {object} config 已解析配置
 * @returns {boolean} 是否应跳过
 */
export function shouldSkipSession(session, config) {
  if (config?.includeSubagents === true) return false;
  const header = session && typeof session === 'object' ? session.header : null;
  if (!header || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  const depth = header.delegationDepth;
  return typeof depth === 'number' && depth > 0;
}

/**
 * 去重键：会话 + 轮次 + 结局。
 *
 * 注意：`session/event` firehose **不重放历史**（构造 seed 不发事件），
 * 所以这个键不是为了防"重放"，而是为了把同一回合的多源上报
 * （`turn/end(error)` 与 `agent/error`）折叠成一封。
 * @param {string} sessionId 会话 ID
 * @param {number|null|undefined} turn 轮次号
 * @param {string} outcome 结局
 * @returns {string}
 */
export function dedupeKey(sessionId, turn, outcome) {
  const t = typeof turn === 'number' && Number.isFinite(turn) ? String(turn) : '-';
  return `${sessionId}:${t}:${outcome}`;
}

/**
 * 错误去重键：同一回合的错误只发一封（同时忽略 outcome 的细分差异）。
 * @param {string} sessionId 会话 ID
 * @param {number|null|undefined} turn 轮次号
 * @returns {string}
 */
export function errorKey(sessionId, turn) {
  return dedupeKey(sessionId, turn, 'error');
}
