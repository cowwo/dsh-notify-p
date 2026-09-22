// dsh-notify-p · 邮件渲染层（纯函数，无 cordis / 无 IO，可直接单测）
//
// 一封邮件要回答的唯一问题："是哪个会话、发生了什么、我该不该现在去看"。
// 因此正文固定包含：事件、会话标题、工作区、时间、用时、会话 ID，
// 以及一条可点击的直达链接（接收端由 dsh-deeplink / dsh-session-link 提供）。

import { sessionLink } from './config.js';

/** 结局 → 中英并列文案。 */
export const OUTCOME_LABEL = {
  completed: ['任务完成', 'Task completed'],
  error: ['任务出错', 'Task failed'],
  blocked: ['卡住需要你介入', 'Blocked — needs you'],
  abortedByUser: ['你主动停止', 'Stopped by you'],
  abortedOther: ['系统中断', 'Interrupted by system'],
  interrupted: ['被中断', 'Interrupted'],
  maxTokens: ['达到长度上限', 'Token limit reached'],
  approval: ['等你审批', 'Waiting for your approval'],
};

/** 结局 → 主题行里的短标题（中英并列）。 */
const SUBJECT_LABEL = {
  completed: '任务完成 / completed',
  error: '任务出错 / failed',
  blocked: '卡住需要你介入 / blocked',
  abortedByUser: '你主动停止 / stopped',
  abortedOther: '系统中断 / interrupted',
  interrupted: '被中断 / interrupted',
  maxTokens: '达到长度上限 / token limit',
  approval: '等你审批 / approval needed',
};

/**
 * 取工作区名（cwd 的 basename）。兼容 Windows 反斜杠。
 * @param {string} cwd 绝对路径
 * @returns {string}
 */
export function workspaceName(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return '';
  const trimmed = cwd.trim().replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]+/);
  return parts[parts.length - 1] ?? '';
}

/**
 * 人类可读用时（中英并列）。
 * @param {number} ms 毫秒
 * @returns {string}
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const zh = h > 0 ? `${h} 小时 ${m} 分 ${s} 秒` : (m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`);
  const en = h > 0 ? `${h}h ${m}m ${s}s` : (m > 0 ? `${m}m ${s}s` : `${s}s`);
  return `${zh} / ${en}`;
}

/**
 * 本地时间 YYYY-MM-DD HH:mm:ss。
 * @param {number} ts epoch 毫秒
 * @returns {string}
 */
export function formatTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 标题兜底：拿不到会话标题时用会话 ID 前 8 位。
 * @param {string} title 会话标题
 * @param {string} sessionId 会话 ID
 * @returns {string}
 */
export function displayTitle(title, sessionId) {
  const t = typeof title === 'string' ? title.trim() : '';
  if (t !== '') return t;
  const id = typeof sessionId === 'string' ? sessionId : '';
  if (id === '') return '(未知会话 / unknown session)';
  // 注意：DSH 的会话 ID 全以 "session-" 开头，直接取前 8 位只会得到 "session-"，
  // 等于什么都没显示。所以先剥掉前缀再截断。
  const stripped = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return stripped.length > 8 ? stripped.slice(0, 8) : stripped;
}

/**
 * 渲染一封通知邮件。
 * @param {object} input 渲染输入
 * @param {string} input.outcome 结局（OUTCOME 之一）
 * @param {string} input.sessionId 会话 ID
 * @param {string} [input.sessionTitle] 会话标题
 * @param {string} [input.cwd] 会话工作目录
 * @param {number} [input.turn] 轮次号
 * @param {number} [input.endedAt] 结束时间（epoch 毫秒）
 * @param {number} [input.durationMs] 用时
 * @param {string} [input.errorText] 失败原因
 * @param {{toolName?: string, reason?: string, command?: string}} [input.approval] 审批信息
 * @param {object} input.config 已解析配置
 * @param {string} [input.baseUrl] 链接基地址
 * @param {(cwd: string, sessionId: string) => string} [input.resolveWorkspace] 可选的 cwd→工作区名覆盖
 * @returns {{ subject: string, text: string, html: string, link: string, title: string }}
 */
export function renderMail(input) {
  const {
    outcome,
    sessionId,
    sessionTitle,
    cwd,
    turn,
    endedAt,
    durationMs,
    errorText,
    approval,
    config,
    baseUrl,
    resolveWorkspace,
  } = input;

  const [zh, en] = OUTCOME_LABEL[outcome] ?? [outcome, outcome];
  const subjectLabel = SUBJECT_LABEL[outcome] ?? outcome;
  const title = displayTitle(sessionTitle, sessionId);
  const workspace = typeof resolveWorkspace === 'function'
    ? resolveWorkspace(cwd ?? '', sessionId)
    : workspaceName(cwd ?? '');
  const duration = formatDuration(durationMs);
  const time = formatTime(typeof endedAt === 'number' ? endedAt : Date.now());
  const link = config?.linkEnabled === true ? sessionLink(baseUrl, sessionId) : '';

  const subject = `[DSH] ${subjectLabel} · ${title}`;

  // ---- 纯文本版 ----
  const rows = [
    ['发生了什么 / Event', `${zh}（${outcome}）/ ${en}`],
    ['会话标题 / Session', title],
    ['工作区　 / Workspace', workspace === '' ? '(未知 / unknown)' : workspace],
    ['时间　　 / Time', time],
  ];
  if (duration !== '' && typeof durationMs === 'number' && durationMs > 0) {
    rows.push(['用时　　 / Duration', duration]);
  }
  if (typeof turn === 'number') rows.push(['轮次　　 / Turn', String(turn)]);
  rows.push(['会话 ID　/ Session ID', sessionId]);
  if (link !== '') rows.push(['直达会话 / Open session', link]);

  const lines = rows.map(([k, v]) => `${k}：${v}`);
  if (typeof errorText === 'string' && errorText !== '') {
    lines.push('', '失败原因 / Failure：', `  ${errorText}`);
  }
  if (approval) {
    lines.push('', '等待你审批 / Awaiting your approval：');
    if (approval.toolName) lines.push(`  工具 / Tool：${approval.toolName}`);
    if (approval.reason) lines.push(`  说明 / Reason：${approval.reason}`);
    if (approval.command) lines.push(`  命令 / Command：${approval.command}`);
  }
  lines.push('', '— 本邮件由 dsh-notify-p 自动发送 / sent by dsh-notify-p');
  const text = lines.join('\n');

  // ---- HTML 版 ----
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const htmlRows = rows
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;white-space:nowrap">${esc(k)}</td>`
      + `<td style="padding:4px 0;color:#111">${esc(v)}</td></tr>`)
    .join('');
  const detailBlocks = [];
  if (typeof errorText === 'string' && errorText !== '') {
    detailBlocks.push(`<p style="margin:16px 0 4px;color:#b3261e"><strong>失败原因 / Failure</strong></p>`
      + `<pre style="margin:0;padding:10px;background:#f6f6f6;border-radius:6px;white-space:pre-wrap;font-size:12px">${esc(errorText)}</pre>`);
  }
  if (approval) {
    const detail = [approval.toolName ? `工具 / Tool：${approval.toolName}` : '', approval.reason ? `说明 / Reason：${approval.reason}` : '', approval.command ? `命令 / Command：${approval.command}` : '']
      .filter((s) => s !== '').join('\n');
    if (detail !== '') {
      detailBlocks.push(`<p style="margin:16px 0 4px"><strong>等待你审批 / Awaiting your approval</strong></p>`
        + `<pre style="margin:0;padding:10px;background:#f6f6f6;border-radius:6px;white-space:pre-wrap;font-size:12px">${esc(detail)}</pre>`);
    }
  }
  const button = link === ''
    ? ''
    : `<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;padding:9px 16px;background:#1a56db;color:#fff;text-decoration:none;border-radius:6px;font-size:14px">打开该会话 / Open session</a></p>`
      + `<p style="margin:8px 0 0;color:#888;font-size:12px">${esc(link)}</p>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6;color:#111">`
    + `<table style="border-collapse:collapse">${htmlRows}</table>`
    + detailBlocks.join('')
    + button
    + `<p style="margin:20px 0 0;color:#999;font-size:12px">本邮件由 dsh-notify-p 自动发送 / sent by dsh-notify-p</p>`
    + `</body></html>`;

  return { subject, text, html, link, title };
}
