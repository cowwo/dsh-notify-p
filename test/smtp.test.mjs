import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { createSmtpSender, MailSendError, isPermanentSmtpCode } from '../lib/send/smtp.js';

/**
 * 起一个脚本化的假 SMTP 服务器，记录会话过程。
 * @param {object} [options] 行为开关
 * @param {boolean} [options.rejectAuth] 是否对 AUTH 回 535
 * @returns {Promise<{ port: number, received: object, close: () => Promise<void> }>}
 */
async function startFakeSmtp(options = {}) {
  const received = { lines: [], data: '', authUser: '', authPassword: '' };
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 fake.example ESMTP\r\n');
    let buffer = '';
    let inData = false;
    let awaiting = null;
    let dataLines = [];

    const handle = (line) => {
      if (awaiting === 'user') {
        received.authUser = line;
        awaiting = 'password';
        socket.write('334 UGFzc3dvcmQ6\r\n');
        return;
      }
      if (awaiting === 'password') {
        received.authPassword = line;
        awaiting = null;
        socket.write(options.rejectAuth === true ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 Accepted\r\n');
        return;
      }
      received.lines.push(line);
      const cmd = line.toUpperCase();
      if (cmd.startsWith('EHLO')) socket.write('250-fake.example\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n');
      else if (cmd.startsWith('AUTH LOGIN')) { awaiting = 'user'; socket.write('334 VXNlcm5hbWU6\r\n'); }
      else if (cmd.startsWith('MAIL FROM')) socket.write('250 2.1.0 OK\r\n');
      else if (cmd.startsWith('RCPT TO')) socket.write('250 2.1.5 OK\r\n');
      else if (cmd === 'DATA') { inData = true; dataLines = []; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (cmd === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
      else socket.write('250 OK\r\n');
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.data = dataLines.join('\n');
            socket.write('250 2.0.0 OK queued\r\n');
          } else {
            dataLines.push(line.replace(/^\.\./, '.'));
          }
          continue;
        }
        handle(line);
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    received,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

test('SMTP：AUTH LOGIN → MAIL/RCPT/DATA 全流程，中文主题被编码', async (t) => {
  const fake = await startFakeSmtp();
  t.after(() => fake.close());

  const sender = createSmtpSender({
    host: '127.0.0.1',
    port: fake.port,
    secure: 'plain',
    user: 'me@example.com',
    password: 'auth-code',
    timeoutMs: 5000,
  });

  const result = await sender.send({
    from: 'DSH 通知 <me@example.com>',
    to: ['you@example.com'],
    subject: '[DSH] 任务完成 · 修复登录页',
    text: '正文',
    html: '<p>正文</p>',
  });

  assert.equal(result.ok, true);
  assert.ok(fake.received.lines.some((l) => l.startsWith('MAIL FROM:<me@example.com>')));
  assert.ok(fake.received.lines.some((l) => l.startsWith('RCPT TO:<you@example.com>')));
  assert.equal(fake.received.authUser, Buffer.from('me@example.com', 'utf8').toString('base64'));
  assert.equal(fake.received.authPassword, Buffer.from('auth-code', 'utf8').toString('base64'));
  assert.match(fake.received.data, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(fake.received.data, /Content-Type: multipart\/alternative/);
});

test('SMTP：535 认证失败 → AUTH 且不可重试（不放大风控锁定）', async (t) => {
  const fake = await startFakeSmtp({ rejectAuth: true });
  t.after(() => fake.close());

  const sender = createSmtpSender({
    host: '127.0.0.1',
    port: fake.port,
    secure: 'plain',
    user: 'me@example.com',
    password: 'wrong',
    timeoutMs: 5000,
  });

  await assert.rejects(
    () => sender.send({ from: 'me@example.com', to: ['you@example.com'], subject: 's', text: 't' }),
    (error) => {
      assert.ok(error instanceof MailSendError);
      assert.equal(error.code, 'AUTH');
      assert.equal(error.retryable, false);
      assert.equal(error.status, 535);
      return true;
    },
  );
});

test('SMTP：没配 host 时直接报 CONFIG，不建连接', async () => {
  const sender = createSmtpSender({ host: '', port: 465, user: '', password: '' });
  await assert.rejects(
    () => sender.send({ from: 'a@b.com', to: ['c@d.com'], subject: 's', text: 't' }),
    (error) => error instanceof MailSendError && error.code === 'CONFIG' && error.retryable === false,
  );
});

test('isPermanentSmtpCode：5xx 不该重试，4xx 可以', () => {
  assert.equal(isPermanentSmtpCode(535), true);
  assert.equal(isPermanentSmtpCode(550), true);
  assert.equal(isPermanentSmtpCode(421), false);
  assert.equal(isPermanentSmtpCode(450), false);
});
