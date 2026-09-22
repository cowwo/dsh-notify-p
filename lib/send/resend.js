// dsh-notify-p · Resend HTTP API 发送器
//
// POST {apiBase}/emails  { from, to, subject, text, html }
// 需要已验证域名（否则只能发给注册邮箱）——这是 Resend 的产品限制，不是插件的 bug。
// 走全局 fetch，因此 dsh-http-proxy 的代理策略自动生效，无需额外处理。

import { MailSendError } from './smtp.js';

/**
 * 建一个 Resend 发送器。
 * @param {object} options 配置与凭据
 * @param {string} options.apiKey Resend API Key
 * @param {string} [options.apiBase] API 基地址
 * @param {number} [options.timeoutMs] 请求超时
 * @returns {{name: string, send: (mail: object) => Promise<{ok: boolean, id: string|null}>}}
 */
export function createResendSender(options) {
  const apiBase = String(options.apiBase ?? 'https://api.resend.com').replace(/\/+$/, '');
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 20000;

  return {
    name: 'resend',
    /**
     * 发送一封邮件。
     * @param {{from: string, to: string[], subject: string, text: string, html?: string}} mail 邮件
     * @returns {Promise<{ok: boolean, id: string|null}>}
     */
    send: async (mail) => {
      if (typeof options.apiKey !== 'string' || options.apiKey === '') {
        throw new MailSendError('Resend 未取到 API Key / no Resend API key resolved', { code: 'CONFIG', retryable: false });
      }
      let response;
      try {
        response = await fetch(`${apiBase}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: mail.from,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            ...(typeof mail.html === 'string' && mail.html !== '' ? { html: mail.html } : {}),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new MailSendError(`Resend 网络错误 / network error: ${message}`, { code: 'NETWORK', retryable: true });
      }

      const raw = await response.text().catch(() => '');
      if (response.ok) {
        let id = null;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.id === 'string') id = parsed.id;
        } catch {
          /* 没有 id 也算成功 */
        }
        return { ok: true, id };
      }

      // 429 / 5xx 可重试；403（域名未验证）/ 422（参数问题）不可重试
      const retryable = response.status === 429 || response.status >= 500;
      const detail = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new MailSendError(
        `Resend 拒绝了请求 / rejected (HTTP ${response.status}): ${detail === '' ? '(空响应)' : detail}`,
        { code: 'HTTP', status: response.status, retryable },
      );
    },
  };
}
