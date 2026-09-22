import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, parseRecipients, resolveBaseUrl, sessionLink, smtpAccountHint, SMTP_PRESETS, resolveTransports, TRANSPORTS } from '../lib/config.js';

test('parseRecipients：一行一个，兼容逗号分号，去重去空、挑出非法项', () => {
  const { valid, invalid } = parseRecipients('a@x.com\nb@y.com, c@z.com; a@x.com\n\nnot-an-email\n');
  assert.deepEqual(valid, ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(invalid, ['not-an-email']);
  assert.deepEqual(parseRecipients(''), { valid: [], invalid: [] });
  assert.deepEqual(parseRecipients(undefined), { valid: [], invalid: [] });
});

test('resolveBaseUrl：用户配置优先，其次 DSH_WEB_URL，去掉结尾斜杠', () => {
  assert.equal(resolveBaseUrl({ publicBaseUrl: 'https://dsh.example.com/' }, 'http://127.0.0.1:3081'), 'https://dsh.example.com');
  assert.equal(resolveBaseUrl({ publicBaseUrl: '  ' }, 'http://127.0.0.1:3081'), 'http://127.0.0.1:3081');
  assert.equal(resolveBaseUrl({}, ''), '');
});

test('sessionLink：只拼链接，不做任何接收端处理', () => {
  assert.equal(
    sessionLink('http://127.0.0.1:3081', 'session-a25bd099'),
    'http://127.0.0.1:3081/?session=session-a25bd099',
  );
  assert.equal(sessionLink('', 'session-x'), '');
  assert.equal(sessionLink('http://h', ''), '');
});

test('默认配置：首跑是 log 通道 + 不打断的节奏默认值（装上就能验证链路）', () => {
  const config = defaultConfig();
  assert.equal(config.transport, 'log');
  assert.deepEqual(config.transports, [], 'transports 的默认值是空数组：空 = 没设置过，由 resolveTransports 回落到 transport');
  assert.deepEqual(resolveTransports(config), ['log']);
  assert.deepEqual(TRANSPORTS, ['log', 'smtp', 'resend'], '规范顺序是展示与发送的唯一依据');
  assert.equal(config.enabled, true);
  assert.equal(config.includeSubagents, false);
  assert.equal(config.linkEnabled, true);
  assert.equal(config.settleMs, 1500);
  assert.equal(config.minDurationMs, 2000);
  assert.equal(config.ratePerMinute, 10);
  assert.equal(config.smtpPasswordRef, 'DSH_MAIL_NOTIFY_SMTP_PASSWORD');
  assert.equal(config.resendApiKeyRef, 'RESEND_API_KEY');
  assert.equal(config.smtpPort, 465);
  assert.equal(config.smtpSecure, 'auto');
});

test('配置解析：组合层入口能覆盖 schema 默认值', () => {
  const config = defaultConfig();
  assert.equal(typeof config.recipients, 'string');
  assert.equal(config.recipients, '');
});

// ---------------------------------------------------------------------------
// 账号 / 服务商对不上：这是"点发送才报 535"的典型，应该在发信前就能看见
// ---------------------------------------------------------------------------

test('smtpAccountHint：QQ 服务器配 outlook 账号要报警', () => {
  const hint = smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.qq.com', smtpUser: 'cowwo@outlook.com' });
  assert.match(hint, /smtp\.qq\.com/);
  assert.match(hint, /cowwo@outlook\.com/);
  assert.match(hint, /QQ/);
});

test('smtpAccountHint：同服务商自己的多个域名不算错', () => {
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.qq.com', smtpUser: 'me@qq.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.qq.com', smtpUser: 'me@foxmail.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.office365.com', smtpUser: 'me@hotmail.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.mail.me.com', smtpUser: 'me@me.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.gmail.com', smtpUser: 'me@googlemail.com' }), '');
});

test('smtpAccountHint：大小写与前后的空白不影响判断', () => {
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: ' SMTP.QQ.COM ', smtpUser: ' ME@QQ.COM ' }), '');
  assert.notEqual(smtpAccountHint({ transport: 'smtp', smtpHost: 'SMTP.QQ.COM', smtpUser: 'me@OUTLOOK.com' }), '');
});

test('smtpAccountHint：不认识的主机 / 缺字段 / 非 SMTP 通道一律不吭声', () => {
  // 自建中继、企业内部服务器都是合法的，插件不该乱猜
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.example.com', smtpUser: 'me@example.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: '', smtpUser: 'me@qq.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.qq.com', smtpUser: '' }), '');
  assert.equal(smtpAccountHint({ transport: 'smtp', smtpHost: 'smtp.qq.com', smtpUser: 'not-an-email' }), '');
  assert.equal(smtpAccountHint({ transport: 'log', smtpHost: 'smtp.qq.com', smtpUser: 'me@outlook.com' }), '');
  assert.equal(smtpAccountHint({ transport: 'resend', smtpHost: 'smtp.qq.com', smtpUser: 'me@outlook.com' }), '');
  assert.equal(smtpAccountHint(undefined), '');
});

test('smtpAccountHint：多通道下只要勾了 SMTP 就照常提示（别因为列表里有 log 就闭嘴）', () => {
  const hint = smtpAccountHint({ transports: ['log', 'smtp'], smtpHost: 'smtp.qq.com', smtpUser: 'me@outlook.com' });
  assert.match(hint, /QQ/);
  assert.equal(smtpAccountHint({ transports: ['log', 'resend'], smtpHost: 'smtp.qq.com', smtpUser: 'me@outlook.com' }), '',
    '没勾 SMTP 就不提示：这条提示只对 SMTP 通道有意义');
});

test('预设表：每个预设都要有 name 与 domains，且 domains 与 user 后缀自洽', () => {
  for (const [id, preset] of Object.entries(SMTP_PRESETS)) {
    assert.equal(typeof preset.name, 'string', `${id} 缺 name`);
    assert.equal(Array.isArray(preset.domains) && preset.domains.length > 0, true, `${id} 缺 domains`);
    assert.equal(preset.domains.includes(preset.user.slice(1)), true, `${id} 的 domains 应包含自己的 user 后缀`);
  }
});
