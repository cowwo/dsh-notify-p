// dsh-notify-p · 配置层
//
// 一个 settings namespace 承载全部非机密配置（落 $DSH_HOME/settings.yaml），
// 机密（SMTP 授权码 / Resend Key）只在这里存"引用名"，真值在凭据库
// （$DSH_HOME/.credentials.yaml 或同名环境变量）——settings 文档里永不出现密钥。
//
// 本文件只依赖 schemastery，不碰 cordis，便于单测。

import z from '@deepseek-ai/schemastery';

/** settings namespace；客户端卡片以同名 key 注册到 settings.plugin.item。 */
export const NAMESPACE = 'dsh-notify-p';

/** 默认凭据引用名（与 $DSH_HOME/.credentials.yaml 的键同名）。 */
export const DEFAULT_SMTP_PASSWORD_REF = 'DSH_MAIL_NOTIFY_SMTP_PASSWORD';
export const DEFAULT_RESEND_KEY_REF = 'RESEND_API_KEY';

/**
 * 三条通道的**规范顺序**。
 *
 * 展示与发送都按它来，用户勾选的先后不影响结果——顺序一旦跟着点击走，
 * "为什么这次 log 先记、上次 smtp 先发"就会变成一个没人能复现的问题。
 */
export const TRANSPORTS = ['log', 'smtp', 'resend'];

/**
 * 本插件的完整配置 schema。
 * 每个字段都会出现在「设置 → 插件 → 插件配置 → 邮件通知」卡片上（中英并列）。
 */
export const MailSchema = z.object({
  /** 总开关。关掉后插件只订阅不动作。 */
  enabled: z.boolean().default(true),

  /** 收件人：一行一个（也接受逗号/分号分隔）。 */
  recipients: z.string().default(''),

  /** 发件人显示名。 */
  senderName: z.string().default('DSH 通知 / DSH Notification'),

  /** 发件人地址；留空时按 transport 取默认（SMTP 用 smtpUser，Resend 用 accounts 默认域）。 */
  fromAddress: z.string().default(''),

  /** 邮件里链接的对外地址，如 http://127.0.0.1:3081 或 https://dsh.example.com；留空则读 DSH_WEB_URL。 */
  publicBaseUrl: z.string().default(''),

  /** 是否在邮件里附带"直达会话"链接（需要另装 dsh-deeplink / dsh-session-link 才能被识别）。 */
  linkEnabled: z.boolean().default(true),

  /** 是否也通知子代理会话（默认关：一个 workflow 能扇出几十个子会话）。 */
  includeSubagents: z.boolean().default(false),

  /** 空闲合并窗口：turn/end 后再等这么久，期间若同会话又开新轮则合并成一封。 */
  settleMs: z.natural().default(1500),

  /** 短任务不打扰：会话总时长低于此值不发。 */
  minDurationMs: z.natural().default(2000),

  /** 全局发信速率上限（封/分钟），多会话并停时保护 Resend/SMTP。 */
  ratePerMinute: z.natural().default(10),

  /** 发送通道：可多选，**勾选的都会发**。旧配置只有一个 `transport`，见 resolveTransports。 */
  transport: z.union([z.const('log'), z.const('smtp'), z.const('resend')]).default('log'),

  /**
   * 通道列表（新形态）。
   *
   * 默认值是空数组且**空数组 = 没设置过**：settings 的 describe() 返回的是 schema 解析后的
   * 完整值，所以"没设置"与"显式清空"在值上无法区分（见 resolveTransports 的约定）。
   */
  transports: z.array(z.union([z.const('log'), z.const('smtp'), z.const('resend')])).default([]),

  /** 投递账本路径；留空 = $DSH_HOME/dsh-notify-p/state.json（排错时 cat 它）。 */
  statePath: z.string().default(''),

  // ---- SMTP ----
  smtpHost: z.string().default(''),
  smtpPort: z.natural().max(65535).default(465),
  /** auto：465 走隐式 TLS，其余走 STARTTLS。 */
  smtpSecure: z.union([z.const('auto'), z.const('tls'), z.const('starttls'), z.const('plain')]).default('auto'),
  smtpUser: z.string().default(''),
  /** 凭据引用名，不是密码本身。 */
  smtpPasswordRef: z.string().default(DEFAULT_SMTP_PASSWORD_REF),

  // ---- Resend ----
  resendApiKeyRef: z.string().default(DEFAULT_RESEND_KEY_REF),
  resendApiBase: z.string().default('https://api.resend.com'),

  // ---- 事件开关 ----
  notifyCompleted: z.boolean().default(true),
  notifyError: z.boolean().default(true),
  notifyBlocked: z.boolean().default(true),
  /** 只有 aborted.reason.kind === 'user'（真·你主动停止）才算。 */
  notifyAbortedByUser: z.boolean().default(false),
  /** 重启/热更/被父级取消 等系统中断。 */
  notifyInterrupted: z.boolean().default(false),
  notifyMaxTokens: z.boolean().default(false),
  notifyApproval: z.boolean().default(true),
});

/**
 * schema 默认值（也给 cordis 行 config 缺省时兜底）。
 * @returns {object} 完整默认配置
 */
export function defaultConfig() {
  return MailSchema({});
}

/**
 * 把（可选）组合层入口配置解析成完整配置。
 * @param {object} [entry] cordis 行的 config
 * @returns {object} 补齐默认值后的配置
 */
export function resolveConfig(entry) {
  return MailSchema(entry ?? {});
}

/**
 * 归一化「发送通道」列表。
 *
 * 为什么需要它：老配置里只有一个 `transport`，新配置是 `transports` 数组，而
 * settings 的 `describe()` 返回的是 **schema 解析后的完整值**——没写过 transports 的
 * 老配置读出来是 `[]`，跟"用户把所有通道都取消了"长得一模一样。两者无法从值上区分，
 * 所以约定：**数组非空才作数，空了就回落到旧的 `transport`**。
 *
 * 推论（设置页必须遵守）：不允许取消最后一个通道——否则那个通道会被旧字段"复活"。
 * 想完全不真发信就只勾「只记录」。
 * @param {object} [config] 已解析配置（或任何带 transport / transports 的对象）
 * @returns {string[]} 规范顺序、去重后的通道列表；永远非空
 */
export function resolveTransports(config) {
  const raw = Array.isArray(config?.transports) ? config.transports : [];
  const picked = TRANSPORTS.filter((key) => raw.includes(key));
  if (picked.length > 0) return picked;
  const legacy = typeof config?.transport === 'string' ? config.transport : '';
  return TRANSPORTS.includes(legacy) ? [legacy] : ['log'];
}

/**
 * 某个通道自己缺什么（发信前能查出来的）。
 *
 * 只查"这个通道特有"的必填项：收件人、发件人显示名之类跟通道无关的，由调用方查一次，
 * 否则多通道下同一句话会被重复报 N 遍。
 * @param {object} config 已解析配置
 * @param {string} channel 通道名
 * @returns {string[]} 问题列表（空数组表示这个通道没发现明显问题）
 */
export function channelIssues(config, channel) {
  const issues = [];
  if (channel === 'smtp') {
    if (String(config?.smtpHost ?? '').trim() === '') {
      issues.push('SMTP 主机为空 / smtpHost is empty');
    }
    // 用户名不填，后面只会拿到一句 SMTP 原始报错；在这里拦住能直接说清缺什么。
    if (String(config?.smtpUser ?? '').trim() === '') {
      issues.push('SMTP 用户名为空（通常是你的完整邮箱地址）/ smtpUser is empty');
    }
  }
  if (channel === 'resend' && String(config?.fromAddress ?? '').trim() === '') {
    issues.push('Resend 必须填发件人地址（且域名需在 Resend 验证）/ Resend requires fromAddress');
  }
  return issues;
}

/**
 * 跟通道无关、只该报一次的问题。
 * @param {number} recipientCount 有效收件人数
 * @returns {string[]} 问题列表
 */
export function recipientIssues(recipientCount) {
  return recipientCount === 0 ? ['收件人为空 / no recipients configured'] : [];
}

/** 常见邮箱的 SMTP 预设（设置页"一键填入"用）。domains 是这个服务商认的账号域名。 */
export const SMTP_PRESETS = {
  qq: { host: 'smtp.qq.com', port: 465, secure: 'tls', user: '@qq.com', name: 'QQ 邮箱', domains: ['qq.com', 'foxmail.com', 'vip.qq.com'] },
  '163': { host: 'smtp.163.com', port: 465, secure: 'tls', user: '@163.com', name: '163 邮箱', domains: ['163.com', '188.com', 'yeah.net'] },
  '126': { host: 'smtp.126.com', port: 465, secure: 'tls', user: '@126.com', name: '126 邮箱', domains: ['126.com'] },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: 'tls', user: '@gmail.com', name: 'Gmail', domains: ['gmail.com', 'googlemail.com'] },
  outlook: { host: 'smtp.office365.com', port: 587, secure: 'starttls', user: '@outlook.com', name: 'Outlook', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'] },
  icloud: { host: 'smtp.mail.me.com', port: 587, secure: 'starttls', user: '@icloud.com', name: 'iCloud', domains: ['icloud.com', 'me.com', 'mac.com'] },
};

/**
 * 账号和服务商对不上时给一句人话。
 *
 * 用 QQ 的服务器 + outlook 的账号去认证，一定是 535 认证失败——但这个错误在发信前
 * 完全可以看出。只是**提示不是错误**：企业中继、同服务商别名都可能合法，所以不拦发送。
 *
 * 只在选了 SMTP 时才有意义（多通道下别的通道照样能发，但这条提示仍值得说）。
 * @param {object} config 已解析配置
 * @returns {string} 提示文案；没问题时返回空串
 */
export function smtpAccountHint(config) {
  if (!resolveTransports(config).includes('smtp')) return '';
  const host = String(config.smtpHost ?? '').trim().toLowerCase();
  const user = String(config.smtpUser ?? '').trim().toLowerCase();
  if (host === '' || user === '') return '';
  const preset = Object.values(SMTP_PRESETS).find((item) => item.host === host);
  if (preset === undefined) return '';
  const at = user.lastIndexOf('@');
  if (at === -1) return '';
  const domain = user.slice(at + 1);
  if (preset.domains.includes(domain)) return '';
  return `${host} 是${preset.name}的服务器，但账号是 ${user}：这两者对不上，认证会失败。`
    + `要么把账号换成 ${preset.user} 结尾的邮箱，要么把服务商改成账号所属的那一家。`;
}

/**
 * 解析收件人：一行一个（兼容逗号/分号），去空、去重、丢弃明显不含 @ 的项。
 * @param {string} raw 用户填写的原始文本
 * @returns {{ valid: string[], invalid: string[] }}
 */
export function parseRecipients(raw) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  if (typeof raw !== 'string' || raw.trim() === '') return { valid, invalid };
  for (const chunk of raw.split(/[\n,;]+/)) {
    const addr = chunk.trim();
    if (addr === '') continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) invalid.push(addr);
    else valid.push(addr);
  }
  return { valid, invalid };
}

/**
 * 解析邮件里链接的基地址：优先用户配置，其次 DSH_WEB_URL，最后回退回环地址。
 * @param {object} config 已解析配置
 * @param {string} [webUrl] 运行时探测到的 Web GUI 地址
 * @returns {string} 不带结尾斜杠的基地址；都拿不到时返回空串
 */
export function resolveBaseUrl(config, webUrl) {
  const raw = typeof config?.publicBaseUrl === 'string' && config.publicBaseUrl.trim() !== ''
    ? config.publicBaseUrl
    : (typeof webUrl === 'string' ? webUrl : '');
  return String(raw).trim().replace(/\/+$/, '');
}

/**
 * 拼一条"直达会话"链接。
 *
 * 本插件**不实现** `?session=` 的接收端——那由 dsh-deeplink（或 dsh-session-link）负责。
 * 这里只负责把链接拼对放进正文。
 * @param {string} baseUrl 基地址（已去掉结尾斜杠）
 * @param {string} sessionId 会话 ID
 * @returns {string} 形如 http://127.0.0.1:3081/?session=session-xxxx；baseUrl 为空时返回空串
 */
export function sessionLink(baseUrl, sessionId) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return '';
  if (typeof sessionId !== 'string' || sessionId === '') return '';
  return `${baseUrl}/?session=${encodeURIComponent(sessionId)}`;
}
