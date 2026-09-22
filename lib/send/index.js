// dsh-notify-p · 发送层入口
//
// 三条通道同一个接口：send({ from, to, subject, text, html }) → { ok, id }
// 第二期要加新通道（SendGrid / 企业邮中继 / 自建 SMTP）只需要在这里加一个 case。

import { createLogSender } from './log.js';
import { createSmtpSender, MailSendError } from './smtp.js';
import { createResendSender } from './resend.js';
import { channelIssues, resolveTransports } from '../config.js';

export { MailSendError };

/**
 * 按 transport 建发送器，并按"凭据引用名"解析出真值。
 * @param {object} config 已解析配置
 * @param {object} deps 依赖
 * @param {(ref: string) => Promise<string|undefined>} deps.resolveCredential 解析凭据引用
 * @param {object} [deps.logger] 日志器
 * @returns {Promise<{name: string, send: Function}>}
 */
export async function createSender(config, deps) {
  const logger = deps?.logger ?? {};
  const resolveCredential = deps?.resolveCredential;

  switch (config.transport) {
    case 'smtp': {
      const ref = String(config.smtpPasswordRef ?? '').trim();
      const password = ref === '' || typeof resolveCredential !== 'function'
        ? undefined
        : await resolveCredential(ref);
      if (typeof password !== 'string' || password === '') {
        logger.warn?.(`dsh-notify-p: 凭据 "${ref}" 未配置，SMTP 发信会失败。`
          + `请写入 $DSH_HOME/.credentials.yaml 或设为同名环境变量 / credential "${ref}" is not configured.`);
      }
      return createSmtpSender({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        user: config.smtpUser,
        password: password ?? '',
        logger,
      });
    }
    case 'resend': {
      const ref = String(config.resendApiKeyRef ?? '').trim();
      const apiKey = ref === '' || typeof resolveCredential !== 'function'
        ? undefined
        : await resolveCredential(ref);
      if (typeof apiKey !== 'string' || apiKey === '') {
        logger.warn?.(`dsh-notify-p: 凭据 "${ref}" 未配置 / credential "${ref}" is not configured.`);
      }
      return createResendSender({ apiKey: apiKey ?? '', apiBase: config.resendApiBase });
    }
    case 'log':
    default:
      return createLogSender({ logger });
  }
}

/**
 * 拼发件人字符串。
 * @param {object} config 已解析配置
 * @param {string} transport 通道名
 * @returns {string} "名字 <地址>"，或拿不到地址时只返回名字
 */
export function resolveFrom(config, transport) {
  const name = String(config.senderName ?? '').trim();
  let address = String(config.fromAddress ?? '').trim();
  if (address === '' && transport === 'smtp') address = String(config.smtpUser ?? '').trim();
  if (address === '') return name;
  return name === '' ? address : `${name} <${address}>`;
}

/**
 * 发送前能查出来的配置问题（给日志一句中文可读提示，比等到 SMTP 层报错更早）。
 *
 * 保留这个签名是为了兼容调用方（命令行 / 试发），**多通道**应该用 channelIssues 逐条查：
 * 一次只报"第一个有问题的通道"，多通道下会把别的通道的问题藏起来。
 * @param {object} config 已解析配置
 * @param {number} recipientCount 有效收件人数
 * @param {string} [channel] 要查的通道；缺省用配置里的第一个
 * @returns {string[]} 问题列表（空数组表示没发现明显问题）
 */
export function checkSenderConfig(config, recipientCount, channel) {
  const issues = [];
  if (recipientCount === 0) issues.push('收件人为空 / no recipients configured');
  const target = typeof channel === 'string' && channel !== '' ? channel : resolveTransports(config)[0];
  issues.push(...channelIssues(config, target));
  return issues;
}

/**
 * 逐通道发送，**一个通道失败不影响其它通道**。
 *
 * 为什么不是"一个失败就整体抛"：多选的意义就是"记一份账 + 真发一封"，
 * 让没配好的 Resend 把已经写好的账本条目一起带走是最糟的结果。
 * 每个通道的成败单独返回，由 summarizeResults 汇总。
 * @param {string[]} channels 要发的通道（规范顺序）
 * @param {object} config 已解析配置
 * @param {{to: string[], subject: string, text: string, html?: string}} message 邮件内容（不含 from）
 * @param {object} deps 依赖（logger / resolveCredential）
 * @returns {Promise<{transport: string, ok: boolean, ms: number, error: string, retryable: boolean}[]>} 逐通道结果
 */
export async function sendAll(channels, config, message, deps = {}) {
  const logger = deps.logger ?? {};
  const results = [];
  for (const channel of channels) {
    const startedAt = Date.now();
    try {
      // 通道自己的必填项先查：缺主机去连网络只会拿到一句更难读的错。
      const issues = channelIssues(config, channel);
      if (issues.length > 0) {
        throw new MailSendError(`配置不完整，未发信 / incomplete config: ${issues.join('；')}`, {
          code: 'CONFIG',
          retryable: false,
        });
      }
      const sender = await createSender({ ...config, transport: channel }, deps);
      await sender.send({ ...message, from: resolveFrom(config, channel) });
      results.push({ transport: sender.name, ok: true, ms: Date.now() - startedAt, error: '', retryable: false });
    } catch (error) {
      logger.warn?.(`dsh-notify-p: 通道 ${channel} 投递失败 / channel failed: ${error?.message ?? String(error)}`);
      results.push({
        transport: channel,
        ok: false,
        ms: Date.now() - startedAt,
        error: error?.message ?? String(error),
        retryable: error?.retryable === true,
      });
    }
  }
  return results;
}

/**
 * 汇总逐通道结果。
 *
 * 重试规则（防重复投递）：**只要有一个通道成功了就绝不重试**——队列的重试是整条任务重跑，
 * 会把已经成功的那几个通道再发一遍，用户收到重复邮件。只有全军覆没、且失败里确有可重试的
 * 网络类错误时，才允许退避重试（这跟单通道时代的行为一致）。
 * @param {{transport: string, ok: boolean, ms: number, error: string, retryable: boolean}[]} results 逐通道结果
 * @returns {{ok: boolean, transport: string, ms: number, error: string, retryable: boolean, channels: object[]}} 汇总
 */
export function summarizeResults(results) {
  const list = Array.isArray(results) ? results : [];
  const failed = list.filter((item) => item.ok !== true);
  const anyOk = list.some((item) => item.ok === true);
  return {
    ok: list.length > 0 && failed.length === 0,
    transport: list.map((item) => item.transport).join('+'),
    ms: list.reduce((sum, item) => sum + (Number(item.ms) || 0), 0),
    error: failed.map((item) => `${item.transport}: ${item.error}`).join('；'),
    retryable: !anyOk && failed.some((item) => item.retryable === true),
    channels: list,
  };
}
