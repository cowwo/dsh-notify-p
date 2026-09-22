// dsh-notify-p · dry-run 发送器
//
// 默认通道。作用：装上就能把整条链路（事件 → 判定 → 渲染 → 投递）跑通，
// 不需要先搞到邮箱授权码，也不会在联调时烧真邮件。日志里能看到完整正文。

/**
 * 建一个只写日志的发送器。
 * @param {object} options 参数
 * @param {object} [options.logger] 日志器
 * @param {number} [options.previewLimit] 正文预览长度上限
 * @returns {{name: string, send: (mail: object) => Promise<{ok: boolean, id: null}>}}
 */
export function createLogSender(options = {}) {
  const logger = options.logger ?? {};
  const previewLimit = typeof options.previewLimit === 'number' ? options.previewLimit : 1200;

  return {
    name: 'log',
    /**
     * 不真发，只打日志。
     * @param {{from: string, to: string[], subject: string, text: string}} mail 邮件
     * @returns {Promise<{ok: boolean, id: null}>}
     */
    send: async (mail) => {
      const to = Array.isArray(mail.to) ? mail.to.join(', ') : String(mail.to ?? '');
      logger.info?.(`dsh-notify-p[log] → ${to} | ${mail.subject}`);
      const text = typeof mail.text === 'string' ? mail.text : '';
      const preview = text.length > previewLimit ? `${text.slice(0, previewLimit)}\n…（已截断 / truncated）` : text;
      logger.info?.(`dsh-notify-p[log] 正文预览 / body preview:\n${preview}`);
      return { ok: true, id: null };
    },
  };
}
