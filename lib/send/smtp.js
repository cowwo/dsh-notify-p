// dsh-notify-p · 零依赖 SMTP 客户端（只用 node:net / node:tls）
//
// 为什么不用 nodemailer：本插件的既定纪律是"零运行时依赖"，装上就能跑，
// 不引入需要 pnpm 安装的包。这条路在生态里已被验证（同类插件都是几十到两百行）。
//
// 错误分类纪律（来自同类插件的教训）：
//   认证类失败（535 等 5xx）**绝不重试**——重试会放大邮箱风控锁定；
//   网络类失败（ECONNREFUSED / 超时 / 掉线）才允许退避重试。

import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { hostname as osHostname } from 'node:os';
import { buildMimeMessage, extractAddress } from '../mime.js';

/** 结构化发送错误。 */
export class MailSendError extends Error {
  /**
   * @param {string} message 人类可读原因
   * @param {object} [options] 分类信息
   * @param {string} [options.code] NETWORK / AUTH / SMTP / CONFIG / HTTP
   * @param {boolean} [options.retryable] 是否允许退避重试
   * @param {number} [options.status] SMTP 或 HTTP 状态码
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'MailSendError';
    this.code = options.code ?? 'UNKNOWN';
    this.retryable = options.retryable === true;
    this.status = options.status;
  }
}

/**
 * 判断 SMTP 失败码是否属于"不该重试"的认证/策略类。
 * @param {number} code SMTP 状态码
 * @returns {boolean}
 */
export function isPermanentSmtpCode(code) {
  if (typeof code !== 'number') return false;
  if (code === 535 || code === 534 || code === 530) return true; // 认证
  return code >= 500;
}

/**
 * 把底层网络错误映射成分类的 MailSendError。
 * @param {unknown} error 原始错误
 * @returns {MailSendError}
 */
export function classifyNetworkError(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : String(error);
  const retryable = !['ENOTFOUND', 'EAI_AGAIN'].includes(code);
  return new MailSendError(`SMTP 网络错误 / network error: ${code !== '' ? code : message}`, {
    code: 'NETWORK',
    retryable,
  });
}

/**
 * 在 socket 上做逐行 SMTP 应答读取。
 * @param {import('node:net').Socket} socket 已连接的 socket
 * @returns {{ read: () => Promise<{code: number, lines: string[]}>, dispose: () => void, fail: (error: Error) => void }}
 */
function createReader(socket) {
  let buffer = '';
  let waiter = null;
  let failure = null;
  const pending = () => waiter;

  const pump = () => {
    if (waiter === null) return;
    const lines = [];
    let idx = 0;
    for (;;) {
      const nl = buffer.indexOf('\n', idx);
      if (nl === -1) return; // 应答还没收全
      let line = buffer.slice(idx, nl);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      idx = nl + 1;
      lines.push(line);
      if (/^\d{3}[ ]/.test(line)) break; // 多行应答的终止行
    }
    buffer = buffer.slice(idx);
    const w = waiter;
    waiter = null;
    w.resolve({ code: Number.parseInt(lines[lines.length - 1].slice(0, 3), 10), lines });
  };

  const onData = (chunk) => {
    buffer += chunk;
    pump();
  };
  socket.on('data', onData);

  return {
    read: () => new Promise((resolve, reject) => {
      if (failure !== null) {
        reject(failure);
        return;
      }
      waiter = { resolve, reject };
      pump();
    }),
    dispose: () => {
      socket.off('data', onData);
    },
    fail: (error) => {
      failure = error;
      if (waiter !== null) {
        const w = waiter;
        waiter = null;
        w.reject(error);
      }
    },
  };
}

/**
 * 建一个 SMTP 会话（含 STARTTLS 升级与 AUTH）。
 * @param {object} options 连接参数
 * @returns {Promise<{ send: (message: object) => Promise<{ok: boolean, id: null}>, close: () => void }>}
 */
async function openSession(options) {
  const {
    host,
    port,
    secure = 'auto',
    user = '',
    password = '',
    timeoutMs = 30000,
    logger,
  } = options;

  const useImplicitTls = secure === 'tls' || (secure === 'auto' && port === 465);
  const allowStartTls = secure === 'starttls' || (secure === 'auto' && !useImplicitTls);

  /** @type {import('node:net').Socket} */
  let socket = await new Promise((resolve, reject) => {
    const onError = (error) => reject(classifyNetworkError(error));
    const s = useImplicitTls
      ? tlsConnect({ host, port, servername: host }, () => resolve(s))
      : netConnect({ host, port }, () => resolve(s));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      reject(new MailSendError(`SMTP 连接超时 / connect timeout: ${host}:${port}`, { code: 'NETWORK', retryable: true }));
    });
    s.once('error', onError);
  }).catch((error) => {
    throw error instanceof MailSendError ? error : classifyNetworkError(error);
  });

  socket.setEncoding('utf8');
  socket.setTimeout(timeoutMs);

  let reader = createReader(socket);
  const onSocketError = (error) => reader.fail(classifyNetworkError(error));
  const onSocketTimeout = () => reader.fail(new MailSendError('SMTP 空闲超时 / idle timeout', { code: 'NETWORK', retryable: true }));
  const onSocketClose = () => reader.fail(new MailSendError('SMTP 连接被关闭 / connection closed', { code: 'NETWORK', retryable: true }));
  socket.on('error', onSocketError);
  socket.on('timeout', onSocketTimeout);
  socket.on('close', onSocketClose);

  const fail = (message, code, status, retryable) => {
    throw new MailSendError(message, { code, status, retryable });
  };

  const expect = async (allowed, context) => {
    const res = await reader.read();
    if (!allowed.includes(res.code)) {
      const detail = res.lines.join(' | ');
      fail(`SMTP ${context} 失败 / failed: ${detail}`, isPermanentSmtpCode(res.code) ? 'AUTH' : 'SMTP', res.code, !isPermanentSmtpCode(res.code));
    }
    return res;
  };

  /**
   * 把当前明文 socket 升级成 TLS。
   * @returns {Promise<void>}
   */
  const upgradeToTls = async () => {
    reader.dispose();
    const secured = await new Promise((resolve, reject) => {
      const t = tlsConnect({ socket, servername: host }, () => resolve(t));
      t.once('error', (error) => reject(classifyNetworkError(error)));
    });
    secured.setEncoding('utf8');
    secured.setTimeout(timeoutMs);
    socket = secured;
    reader = createReader(socket);
    socket.on('error', onSocketError);
    socket.on('timeout', onSocketTimeout);
    socket.on('close', onSocketClose);
  };

  const write = (line) => {
    socket.write(`${line}\r\n`);
  };

  // 1) 问候
  await expect([220], 'greeting');

  // 2) EHLO（先拿能力表，决定要不要 STARTTLS）
  let ehlo = await (async () => {
    write(`EHLO ${osHostname() || 'localhost'}`);
    return expect([250], 'EHLO');
  })();

  const has = (capability) => ehlo.lines.some((line) => line.toUpperCase().includes(capability));

  // 3) STARTTLS
  if (!useImplicitTls && allowStartTls) {
    if (!has('STARTTLS')) {
      if (secure === 'starttls') fail('SMTP 服务器不支持 STARTTLS / server does not advertise STARTTLS', 'CONFIG', undefined, false);
      else if (logger) logger.warn('dsh-notify-p: SMTP server does not advertise STARTTLS, continuing in plaintext');
    } else {
      write('STARTTLS');
      await expect([220], 'STARTTLS');
      await upgradeToTls();
      write(`EHLO ${osHostname() || 'localhost'}`);
      ehlo = await expect([250], 'EHLO(TLS)');
    }
  }

  // 4) AUTH
  if (typeof user === 'string' && user !== '') {
    if (typeof password !== 'string' || password === '') {
      fail('SMTP 未取到密码 / no SMTP password resolved (检查凭据引用名)', 'CONFIG', undefined, false);
    }
    const supportsLogin = has('AUTH') && (has('LOGIN') || !has('PLAIN'));
    if (supportsLogin) {
      write('AUTH LOGIN');
      await expect([334], 'AUTH LOGIN');
      write(Buffer.from(user, 'utf8').toString('base64'));
      await expect([334], 'AUTH LOGIN(user)');
      write(Buffer.from(password, 'utf8').toString('base64'));
      await expect([235], 'AUTH LOGIN(password)');
    } else {
      write(`AUTH PLAIN ${Buffer.from(`\u0000${user}\u0000${password}`, 'utf8').toString('base64')}`);
      await expect([235], 'AUTH PLAIN');
    }
  }

  const close = () => {
    try {
      socket.end();
    } catch {
      /* 已经关掉了 */
    }
  };

  return {
    close,
    send: async (message) => {
      const from = extractAddress(message.from);
      write(`MAIL FROM:<${from}>`);
      await expect([250], 'MAIL FROM');

      for (const addr of message.to) {
        write(`RCPT TO:<${extractAddress(addr)}>`);
        await expect([250, 251], 'RCPT TO');
      }

      write('DATA');
      await expect([354], 'DATA');

      const payload = buildMimeMessage(message)
        .replace(/\r?\n/g, '\r\n')
        // dot-stuffing：行首的 . 要写成 ..
        .replace(/^\./gm, '..');
      socket.write(`${payload}\r\n.\r\n`);
      await expect([250], 'DATA body');

      write('QUIT');
      await reader.read().catch(() => undefined);
      close();
      return { ok: true, id: null };
    },
  };
}

/**
 * 建一个 SMTP 发送器。
 * @param {object} options 配置与凭据
 * @param {string} options.host SMTP 主机
 * @param {number} options.port 端口
 * @param {string} [options.secure] auto / tls / starttls / plain
 * @param {string} [options.user] 用户名
 * @param {string} [options.password] 密码（授权码）
 * @param {number} [options.timeoutMs] 超时
 * @param {object} [options.logger] 日志器
 * @returns {{name: string, send: (mail: object) => Promise<{ok: boolean, id: null}>}}
 */
export function createSmtpSender(options) {
  return {
    name: 'smtp',
    /**
     * 发送一封邮件（每次开一条新连接，发完 QUIT）。
     * @param {{from: string, to: string[], subject: string, text: string, html?: string}} mail 邮件
     * @returns {Promise<{ok: boolean, id: null}>}
     */
    send: async (mail) => {
      if (typeof options.host !== 'string' || options.host === '') {
        throw new MailSendError('SMTP 未配置主机 / smtpHost is empty', { code: 'CONFIG', retryable: false });
      }
      const session = await openSession(options);
      try {
        return await session.send(mail);
      } catch (error) {
        session.close();
        throw error instanceof MailSendError ? error : classifyNetworkError(error);
      }
    },
  };
}
