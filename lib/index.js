// dsh-notify-p · Host 半（入口）
//
// 一句话：会话干完活 / 出错 / 卡住 / 等你审批时，发一封邮件到你的邮箱，
// 正文写清"是哪个会话"，并附一条可点击直达该会话的链接。
//
// 四条纪律（都来自对同类插件的调研，写在代码里免得以后改回去）：
//   1. aborted 必须按 cause 细分（重启/热更会以 disposed 结束回合，不是"你主动停止"）
//   2. 子代理会话默认跳过（一个 workflow 能扇出几十个子会话）
//   3. 一个会话的连续多轮只提醒一次（turn/end 后等 settleMs，期间又开新轮就取消）
//   4. 每个订阅处理器都要自吞异常：cordis 的 emit 是 stop-on-throw，
//      一个插件抛错会饿死排在后面的订阅者（含 DSH 自己的持久化/遥测）
//
// 本插件**不实现** `?session=` 的接收端：链接的识别由 dsh-deeplink（或 dsh-session-link）负责，
// 这里只负责把链接拼进邮件正文。

import { NAMESPACE, MailSchema, resolveConfig, parseRecipients, resolveBaseUrl, resolveTransports, recipientIssues } from './config.js';
import {
  OUTCOME,
  classifyTurnEnd,
  isOutcomeEnabled,
  shouldSkipSession,
  dedupeKey,
  errorKey,
  flattenError,
} from './policy.js';
import { renderMail } from './render.js';
import { createSendQueue } from './queue.js';
import { sendAll, summarizeResults, MailSendError } from './send/index.js';
import { createLedger } from './state.js';
import { MailNotifyRemoteService } from './service.js';
import { sendTestMail, toDeliveryView } from './test-send.js';

export const name = 'dsh-notify-p';

/** sessions：扫已有会话补标题；settings：配置命名空间（dsh-base 必挂）。 */
export const inject = ['sessions', 'settings'];

/** 去重表上限，防长跑进程无界增长。 */
const SENT_LIMIT = 5000;
/** 最近投递结果保留条数（目前只进日志，第二期可挂到卡片上）。 */
const RECENT_LIMIT = 20;

/**
 * 插件入口。
 *
 * 这里是最后一道保险：本插件的任何异常都不允许把 DSH 的启动带崩。
 * 真正的装配逻辑在 start() 里，外面只负责"兜住并降级"。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {object} [entryConfig] cordis 行的 config（组合层默认值 = settings 的 base 层）
 * @returns {void}
 */
export function apply(ctx, entryConfig) {
  try {
    start(ctx, entryConfig);
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`dsh-notify-p: 启动失败，插件自行禁用（DSH 不受影响）/ failed to start, plugin disabled: ${String(error)}`);
    } catch {
      /* 连日志都打不出去也无所谓，绝不能往上抛 */
    }
  }
}

/**
 * 真正的装配逻辑。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {object} [entryConfig] cordis 行的 config
 * @returns {void}
 */
function start(ctx, entryConfig) {
  const logger = ctx.logger ?? console;
  const entry = resolveConfig(entryConfig);

  // ---- 配置：settings 命名空间（可选服务，缺了就退回组合层配置）----
  let source = () => entry;
  if (typeof ctx.settings?.installSection === 'function') {
    try {
      ctx.settings.installSection(ctx, NAMESPACE, MailSchema, entry, {
        setSource(current) {
          if (typeof current === 'function') source = current;
        },
        onChange() {
          // config() 每次发送都重读，这里无需额外动作
        },
      });
    } catch (error) {
      logger.warn?.(`dsh-notify-p: settings 命名空间注册失败，退回组合层配置 / settings registration failed: ${String(error)}`);
    }
  }
  const readConfig = () => source();

  // ---- 运行态 ----
  /** @type {Map<string, string>} 会话 id → 标题 */
  const titles = new Map();
  /** @type {Map<string, number>} 会话 id → 本轮回合开始时刻 */
  const turnStarts = new Map();
  /** @type {Map<string, {timer: NodeJS.Timeout, payload: object}>} 消抖窗口 */
  const pending = new Map();
  /** @type {Map<string, {turn: number|null, text: string}>} 会话 id → 最近一次 agent/error（比 turn/end 更原始） */
  const agentErrors = new Map();
  /** @type {Set<string>} 已发过的去重键 */
  const sent = new Set();
  /** @type {object[]} 最近投递结果 */
  const recent = [];

  const queue = createSendQueue({
    logger,
    limitPerMinute: () => {
      const value = readConfig().ratePerMinute;
      return typeof value === 'number' && value > 0 ? value : 10;
    },
  });

  // 投递账本：插件日志默认不落 stdout（cordis 控制台 exporter 只输出 error 级），
  // 所以"到底发出去没有"要靠这个文件，`cat` 一下就知道了。
  const ledger = createLedger({ path: readConfig().statePath, logger });

  // ---- Remote 服务：设置页的「发送测试邮件」与「最近一次投递」----
  //
  // 走 Typert：清单在 lib/typert.host.js，由 dsh-typert-loader 在启动时扫描注册，
  // 浏览器侧通过 connection.rpc.call('/api', 'mailNotify/test') 调用。
  // 这里只把 runtime 递进去，服务本身不碰插件状态。
  try {
    ctx.plugin(MailNotifyRemoteService, {
      /** 立刻发一封测试邮件（不等合并窗口、不占限流额度）。 */
      test: async () => runTestDelivery(),
      /** 投递账本快照。 */
      state: () => {
        const snapshot = ledger.snapshot();
        return {
          counts: { sent: snapshot.counts?.sent ?? 0, failed: snapshot.counts?.failed ?? 0 },
          recent: (snapshot.recent ?? []).slice(-10).reverse().map(toDeliveryView),
        };
      },
    });
  } catch (error) {
    logger.warn?.(`dsh-notify-p: Remote 服务注册失败，「发送测试邮件」不可用 / remote service registration failed: ${String(error)}`);
  }

  // ---- 小工具 ----

  /**
   * 按当前配置真的发一封测试邮件，并把结果记进账本。
   *
   * 实现放在 lib/test-send.js：设置页、命令行（test/send-test.mjs）与单元测试共用同一份，
   * 免得"设置页测通了、命令行测不通"。记账留在这一层——命令行不该动正在跑的进程的账本。
   * @returns {Promise<object>} 扁平结果
   */
  async function runTestDelivery() {
    const result = await sendTestMail({
      config: readConfig(),
      logger,
      resolveCredential,
      webUrl: detectWebUrl(),
    });
    recordResult(result);
    return result;
  }

  /**
   * 解析凭据引用：优先凭据服务（叠加启动环境 > .credentials.yaml > .env），
   * 服务不可用时退回同名环境变量。绝不缓存，避免换 Key 要重启。
   * @param {string} ref 凭据引用名
   * @returns {Promise<string|undefined>}
   */
  async function resolveCredential(ref) {
    const key = typeof ref === 'string' ? ref.trim() : '';
    if (key === '') return undefined;
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(key);
        const value = hit && typeof hit === 'object' ? hit.value : undefined;
        if (typeof value === 'string' && value !== '') return value;
      } catch (error) {
        logger.debug?.(`dsh-notify-p: 凭据解析失败 / credential resolve failed (${key}): ${String(error)}`);
      }
    }
    const env = process.env[key];
    return typeof env === 'string' && env !== '' ? env : undefined;
  }

  /**
   * 探测 Web GUI 地址，用于拼直达链接（用户显式配置的 publicBaseUrl 优先，见 resolveBaseUrl）。
   * @returns {string}
   */
  function detectWebUrl() {
    const env = process.env.DSH_WEB_URL;
    if (typeof env === 'string' && env !== '') return env;
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (webServer && typeof webServer.port === 'number') return `http://127.0.0.1:${webServer.port}`;
    return '';
  }

  /**
   * 读会话标题：优先标题服务，其次本地折叠表，最后空串（渲染层会降级成 ID 前 8 位）。
   * @param {object} session 会话
   * @returns {string}
   */
  function readTitle(session) {
    const cached = titles.get(session.id);
    if (typeof cached === 'string' && cached !== '') return cached;
    const sessionTitle = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined;
    try {
      const snapshot = sessionTitle?.get?.(session);
      const title = snapshot && typeof snapshot.title === 'string' ? snapshot.title : '';
      if (title !== '') {
        titles.set(session.id, title);
        return title;
      }
    } catch (error) {
      logger.debug?.(`dsh-notify-p: sessionTitle.get 失败 / failed: ${String(error)}`);
    }
    return '';
  }

  /**
   * 记录一条投递结果（内存环形缓冲 + 落盘账本）。
   * @param {object} record 结果
   * @returns {void}
   */
  function recordResult(record) {
    recent.push(record);
    while (recent.length > RECENT_LIMIT) recent.shift();
    ledger.record(record);
  }

  /**
   * 标记已发；返回 false 表示这条已经发过。
   * 错误类只看 `会话+轮次`（把 turn/end(error) 与 agent/error 折叠成一封）。
   * @param {string} sessionId 会话 id
   * @param {number|null} turn 轮次
   * @param {string} outcome 结局
   * @returns {boolean}
   */
  function markSent(sessionId, turn, outcome) {
    const key = outcome === OUTCOME.ERROR ? errorKey(sessionId, turn) : dedupeKey(sessionId, turn, outcome);
    if (sent.has(key)) return false;
    sent.add(key);
    while (sent.size > SENT_LIMIT) {
      const oldest = sent.values().next().value;
      sent.delete(oldest);
    }
    return true;
  }

  /**
   * 取消某会话的消抖窗口。
   * @param {string} sessionId 会话 id
   * @param {string} why 取消原因（日志用）
   * @returns {boolean} 是否确实取消了
   */
  function cancelPending(sessionId, why) {
    const item = pending.get(sessionId);
    if (item === undefined) return false;
    clearTimeout(item.timer);
    pending.delete(sessionId);
    logger.debug?.(`dsh-notify-p: 合并窗口内会话继续工作，取消本次提醒 / coalesced (${sessionId}, ${why})`);
    return true;
  }

  /**
   * 安排一次提醒（先过消抖窗口）。
   * @param {object} session 会话
   * @param {object} payload 已判定的结局载荷
   * @returns {void}
   */
  function schedule(session, payload) {
    const cfg = readConfig();
    const sessionId = session.id;
    cancelPending(sessionId, 'superseded');
    const enriched = {
      ...payload,
      sessionTitle: readTitle(session),
      cwd: session.header?.cwd ?? '',
      sessionId,
    };
    const timer = setTimeout(() => {
      pending.delete(sessionId);
      try {
        fire(enriched);
      } catch (error) {
        logger.warn?.(`dsh-notify-p: 提醒发送异常 / fire threw: ${String(error)}`);
      }
    }, Math.max(0, cfg.settleMs));
    timer.unref?.();
    pending.set(sessionId, { timer, payload: enriched });
  }

  /**
   * 真正投递一封（已过消抖与去重）。
   * @param {object} payload 结局载荷
   * @returns {void}
   */
  function fire(payload) {
    if (!markSent(payload.sessionId, payload.turn ?? null, payload.outcome)) {
      logger.debug?.(`dsh-notify-p: 重复结局，跳过 / duplicate outcome, skipped (${payload.sessionId}, ${payload.outcome})`);
      return;
    }
    queue.enqueue({
      label: `${payload.outcome} ${payload.sessionId}`,
      run: () => deliver(payload),
      onSuccess: (attempts, result) => recordResult({
        at: Date.now(),
        ok: true,
        outcome: payload.outcome,
        sessionId: payload.sessionId,
        subject: result?.subject,
        recipients: result?.recipients,
        transport: result?.transport,
        channels: result?.channels,
        attempts,
      }),
      onFail: (error, attempts) => recordResult({
        at: Date.now(),
        ok: false,
        outcome: payload.outcome,
        sessionId: payload.sessionId,
        attempts,
        errorCode: error?.code,
        error: error?.message ?? String(error),
        // 逐通道结果：账本里要看得出"哪个通道成了、哪个没成"
        transport: error?.transport,
        channels: error?.channels,
      }),
    });
  }

  /**
   * 渲染并发送（勾了几个通道就发几个）。
   * @param {object} payload 结局载荷
   * @returns {Promise<{subject: string, recipients: string[], transport: string, channels: object[]}>} 投递摘要
   */
  async function deliver(payload) {
    const cfg = readConfig();
    if (cfg.enabled !== true) return { subject: '', recipients: [], transport: 'disabled', channels: [] };

    const channels = resolveTransports(cfg);
    const { valid, invalid } = parseRecipients(cfg.recipients);
    if (invalid.length > 0) {
      logger.warn?.(`dsh-notify-p: 忽略无法识别的收件人 / ignored invalid recipients: ${invalid.join(', ')}`);
    }
    // 收件人为空要抛出去：让队列把它记成一条 failed 落进账本，
    // 否则"没配收件人"会静默成功，用户永远不知道。
    const globalIssues = recipientIssues(valid.length);
    if (globalIssues.length > 0) {
      throw new MailSendError(`配置不完整，未发信 / incomplete config: ${globalIssues.join('；')}`, {
        code: 'CONFIG',
        retryable: false,
      });
    }

    const rendered = renderMail({
      outcome: payload.outcome,
      sessionId: payload.sessionId,
      sessionTitle: payload.sessionTitle,
      cwd: payload.cwd,
      turn: payload.turn ?? undefined,
      endedAt: payload.endedAt,
      durationMs: payload.durationMs,
      errorText: payload.detail,
      approval: payload.approval,
      config: cfg,
      baseUrl: resolveBaseUrl(cfg, detectWebUrl()),
    });

    // 逐通道发：一个通道坏了不该把已经成功的通道拖下水（多选的意义就是"记账 + 真发"）。
    const results = await sendAll(channels, cfg, {
      to: valid,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    }, { logger, resolveCredential });
    const summary = summarizeResults(results);

    if (!summary.ok) {
      const error = new MailSendError(summary.error, { code: 'CHANNEL', retryable: summary.retryable });
      // 把逐通道结果挂在错误上：账本要留下"哪个通道成了、哪个没成"，而不是一句合并后的黑箱。
      error.channels = results;
      error.transport = summary.transport;
      throw error;
    }

    logger.info?.(`dsh-notify-p: 已投递 / delivered via ${summary.transport} → ${valid.join(', ')} | ${rendered.subject}`);
    return { subject: rendered.subject, recipients: valid, transport: summary.transport, channels: results };
  }

  // ---- 事件判定 ----

  /**
   * 处理一轮结束。
   * @param {object} session 会话
   * @param {object} event turn/end 事件
   * @returns {void}
   */
  function onTurnEnd(session, event) {
    const cfg = readConfig();
    if (cfg.enabled !== true) return;
    if (shouldSkipSession(session, cfg)) return;

    const classified = classifyTurnEnd(event.data);
    if (classified === null) return;
    if (!isOutcomeEnabled(classified.outcome, cfg)) return;

    const turn = typeof event.data?.turn === 'number' ? event.data.turn : null;
    const endedAt = typeof event.time === 'number' ? event.time : Date.now();
    const startedAt = turnStarts.get(session.id);
    const durationMs = typeof startedAt === 'number' ? Math.max(0, endedAt - startedAt) : null;

    // 短任务不打扰只对"完成"生效：出错/卡住/审批永远值得打扰
    if (classified.outcome === OUTCOME.COMPLETED && durationMs !== null && durationMs < cfg.minDurationMs) {
      logger.debug?.(`dsh-notify-p: 任务过短不打扰 / short task skipped (${durationMs}ms < ${cfg.minDurationMs}ms)`);
      return;
    }

    // agent/error 通常先到、且带原始抛出值：用它覆盖 turn/end 里扁平化的报错文本。
    // 注意：这里**不能**"读一次就删"——同一回合可能有第二次 turn/end 上报，
    // 那会把已经排队的富文本又覆盖回扁平文本。靠 turn 号相等来防串味，
    // 真正的清理交给下一条 agent/error 覆盖或 session/disposed。
    let detail = classified.detail ?? '';
    const agentError = agentErrors.get(session.id);
    if (classified.outcome === OUTCOME.ERROR && agentError !== undefined) {
      if (turn === null || agentError.turn === null || agentError.turn === turn) {
        detail = agentError.text !== '' ? agentError.text : detail;
      }
    }

    schedule(session, {
      outcome: classified.outcome,
      turn,
      detail,
      endedAt,
      durationMs: durationMs ?? 0,
      cause: classified.cause,
    });
  }

  /**
   * 处理一条审批请求：立即发（审批是阻塞用户的，晚几分钟就没意义），不参与消抖。
   * @param {object} session 会话
   * @param {object} event approval/asked 事件
   * @returns {void}
   */
  function onApproval(session, event) {
    const cfg = readConfig();
    if (cfg.enabled !== true || cfg.notifyApproval !== true) return;
    if (shouldSkipSession(session, cfg)) return;

    const data = event.data ?? {};
    cancelPending(session.id, 'approval');
    fire({
      outcome: OUTCOME.APPROVAL,
      sessionId: session.id,
      turn: typeof data.turn === 'number' ? data.turn : null,
      sessionTitle: readTitle(session),
      cwd: session.header?.cwd ?? '',
      detail: '',
      endedAt: typeof event.time === 'number' ? event.time : Date.now(),
      durationMs: 0,
      // P0-4：approval/asked 只有 { id, toolName, callId, reason }，没有命令正文。
      // 要显示命令必须用 callId 回查 tool/call——第一期刻意不做，免得猜错。
      approval: {
        toolName: typeof data.toolName === 'string' ? data.toolName : '',
        reason: typeof data.reason === 'string' ? data.reason : '',
      },
    });
  }

  /**
   * 观察一条会话事件。
   * @param {object} session 会话
   * @param {object} event 事件
   * @param {{replay?: boolean}} [opts] replay=true 表示来自挂载时的历史扫描（只折叠状态，绝不发信）
   * @returns {void}
   */
  function observe(session, event, opts = {}) {
    const type = event?.type;
    if (type === 'session/title') {
      const title = event.data?.title;
      if (typeof title === 'string' && title !== '') titles.set(session.id, title);
      return;
    }
    if (type === 'turn/start') {
      turnStarts.set(session.id, typeof event.time === 'number' ? event.time : Date.now());
      if (opts.replay !== true) cancelPending(session.id, 'turn/start');
      return;
    }
    if (type === 'turn/end') {
      if (opts.replay === true) return; // 纪律：回放历史绝不发信
      onTurnEnd(session, event);
      return;
    }
    if (type === 'approval/asked') {
      if (opts.replay === true) return;
      onApproval(session, event);
    }
  }

  /**
   * 接管一个会话：只补标题（热更/重启不会重放 session/created）。
   * @param {object} session 会话
   * @returns {void}
   */
  function adopt(session) {
    if (typeof session?.id !== 'string') return;
    readTitle(session);
    if (titles.has(session.id)) return;
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
      for (const event of events) {
        if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
          titles.set(session.id, event.data.title);
        }
      }
    } catch (error) {
      logger.debug?.(`dsh-notify-p: 折叠会话标题失败 / failed to fold title: ${String(error)}`);
    }
  }

  // ---- 订阅（每个处理器自吞异常，绝不饿死其它订阅者）----

  ctx.on('session/created', (session) => {
    try {
      adopt(session);
    } catch (error) {
      logger.debug?.(`dsh-notify-p: session/created 处理失败: ${String(error)}`);
    }
  });

  ctx.on('session/event', (session, event) => {
    try {
      observe(session, event);
    } catch (error) {
      logger.warn?.(`dsh-notify-p: session/event 处理失败 / handler failed: ${String(error)}`);
    }
  });

  ctx.on('agent/error', (payload) => {
    try {
      const agent = payload?.agent;
      const sessionId = agent?.session?.id
        ?? (typeof agent?.sessionId === 'string' ? agent.sessionId : '')
        ?? (typeof payload?.session?.id === 'string' ? payload.session.id : '');
      if (typeof sessionId !== 'string' || sessionId === '') return;
      agentErrors.set(sessionId, {
        turn: typeof payload?.turn === 'number' ? payload.turn : null,
        text: flattenError(payload?.error),
      });
    } catch (error) {
      logger.debug?.(`dsh-notify-p: agent/error 处理失败: ${String(error)}`);
    }
  });

  ctx.on('session/disposed', (session) => {
    try {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string') return;
      cancelPending(sessionId, 'disposed');
      turnStarts.delete(sessionId);
      agentErrors.delete(sessionId);
      titles.delete(sessionId);
    } catch (error) {
      logger.debug?.(`dsh-notify-p: session/disposed 处理失败: ${String(error)}`);
    }
  });

  // 挂载时扫一遍已有会话（只为补标题，不发信）
  try {
    for (const session of ctx.sessions.list()) adopt(session);
  } catch (error) {
    logger.warn?.(`dsh-notify-p: 初始会话扫描失败 / initial sweep failed: ${String(error)}`);
  }

  // 卸载时清掉未触发的定时器
  ctx.effect(() => () => {
    for (const item of pending.values()) clearTimeout(item.timer);
    pending.clear();
  }, 'dsh-notify-p: pending timers');

  logger.info?.(`dsh-notify-p 已加载 / loaded（通道 ${resolveTransports(readConfig()).join('+')}，`
    + `收件人 ${parseRecipients(readConfig().recipients).valid.length} 个）`);
}
