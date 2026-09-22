// dsh-notify-p · 命令行测试发送的离线测试
//
// 只测不碰网络的部分：参数解析、配置读取、凭据解析顺序，以及"配置不完整就地报错"
// 这条不连网络的路径。真的发信路径由 test/plugin.test.mjs 里的 Remote 用例覆盖
// （log 通道），以及 test/smtp.test.mjs 的假 SMTP 服务器覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseArgs, readSettingsSection, readCredentialRefs, resolveCredentialFrom, dshHome } from './send-test.mjs';
import { sendTestMail, toDeliveryView } from '../lib/test-send.js';
import { defaultConfig, resolveTransports, channelIssues } from '../lib/config.js';
import { sendAll, summarizeResults } from '../lib/send/index.js';

/** 造一个临时 DSH home。 */
function tempHome(settings, credentials) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-notify-p-cli-'));
  if (settings !== undefined) writeFileSync(join(home, 'settings.yaml'), settings, 'utf8');
  if (credentials !== undefined) writeFileSync(join(home, '.credentials.yaml'), credentials, 'utf8');
  return home;
}

test('CLI：参数解析认得所有开关，未知参数被单独收集', () => {
  const { flags, unknown } = parseArgs([
    '--to', 'me@qq.com', '--transport', 'smtp', '--smtp-host', 'smtp.qq.com',
    '--smtp-port', '465', '--smtp-secure', 'tls', '--smtp-user', 'me@qq.com',
    '--from', 'me@qq.com', '--sender-name', 'DSH', '--dry-run', '--json', '--nope',
  ]);
  assert.equal(flags.recipients, 'me@qq.com');
  assert.equal(flags.transport, 'smtp');
  assert.equal(flags.smtpHost, 'smtp.qq.com');
  assert.equal(flags.smtpPort, 465);
  assert.equal(flags.smtpSecure, 'tls');
  assert.equal(flags.smtpUser, 'me@qq.com');
  assert.equal(flags.fromAddress, 'me@qq.com');
  assert.equal(flags.senderName, 'DSH');
  assert.equal(flags.dryRun, true);
  assert.equal(flags.json, true);
  assert.deepEqual(unknown, ['--nope']);
});

test('CLI：--help 单独识别，不吞其它参数', () => {
  const { flags, unknown } = parseArgs(['--help']);
  assert.equal(flags.help, true);
  assert.deepEqual(unknown, []);
});

test('CLI：读 settings.yaml 的插件段；文件缺失/损坏都退化成空对象', () => {
  const good = tempHome('other-plugin:\n  a: 1\ndsh-notify-p:\n  transport: smtp\n  recipients: me@qq.com\n');
  assert.deepEqual(readSettingsSection(good), { transport: 'smtp', recipients: 'me@qq.com' });

  const missing = mkdtempSync(join(tmpdir(), 'dsh-notify-p-cli-'));
  assert.deepEqual(readSettingsSection(missing), {}, '没有 settings.yaml 时不该抛');

  const broken = tempHome('dsh-notify-p: [unclosed\n');
  assert.deepEqual(readSettingsSection(broken), {}, 'YAML 坏了也要退化成空对象');
});

test('CLI：读凭据库的 refs；records 段不算凭据', () => {
  const home = tempHome(undefined, [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload: { version: 1, secret: abc }',
    'refs:',
    '  DSH_MAIL_NOTIFY_SMTP_PASSWORD: "the-code"',
    '  RESEND_API_KEY: re_xxx',
    '',
  ].join('\n'));
  const refs = readCredentialRefs(home);
  assert.deepEqual(refs, { DSH_MAIL_NOTIFY_SMTP_PASSWORD: 'the-code', RESEND_API_KEY: 're_xxx' });
  assert.deepEqual(readCredentialRefs(mkdtempSync(join(tmpdir(), 'dsh-notify-p-cli-'))), {});
});

test('CLI：凭据解析顺序是环境变量优先、其次凭据库', () => {
  const refs = { DSH_MAIL_NOTIFY_SMTP_PASSWORD: 'from-file' };
  process.env.DSH_MAIL_NOTIFY_SMTP_PASSWORD = 'from-env';
  try {
    assert.equal(resolveCredentialFrom('DSH_MAIL_NOTIFY_SMTP_PASSWORD', refs), 'from-env');
  } finally {
    delete process.env.DSH_MAIL_NOTIFY_SMTP_PASSWORD;
  }
  assert.equal(resolveCredentialFrom('DSH_MAIL_NOTIFY_SMTP_PASSWORD', refs), 'from-file');
  assert.equal(resolveCredentialFrom('MISSING_REF', refs), undefined);
  assert.equal(resolveCredentialFrom('', refs), undefined);
  assert.equal(resolveCredentialFrom(undefined, refs), undefined);
});

test('CLI：dshHome 跟随 DSH_HOME 环境变量', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/some-home';
  try {
    assert.equal(dshHome(), '/tmp/some-home');
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test('sendTestMail：配置不完整就地返回，不连网络也不抛', async () => {
  const result = await sendTestMail({ config: { ...defaultConfig(), transport: 'smtp', recipients: '' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /收件人/);
  assert.equal(result.transport, 'smtp');
  assert.deepEqual(result.recipients, []);
});

test('sendTestMail：SMTP 缺用户名时也说清缺什么（不是等 535）', async () => {
  const result = await sendTestMail({
    config: { ...defaultConfig(), transport: 'smtp', recipients: 'me@qq.com', smtpHost: 'smtp.qq.com', smtpUser: '' },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /用户名/);
});

test('sendTestMail：log 通道真的走完整条渲染链路', async () => {
  const lines = [];
  const result = await sendTestMail({
    config: { ...defaultConfig(), transport: 'log', recipients: 'me@qq.com' },
    logger: { info: (m) => lines.push(m), warn: () => {}, debug: () => {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.transport, 'log');
  assert.deepEqual(result.recipients, ['me@qq.com']);
  assert.match(result.subject, /\[DSH\]/);
  assert.equal(Number.isFinite(result.ms), true);
  assert.match(lines.join('\n'), /测试邮件已投递/);
});

test('toDeliveryView：字段齐全且类型稳定（typert 严格 schema 依赖这一点）', () => {
  assert.deepEqual(
    toDeliveryView({
      at: 5,
      ok: true,
      transport: 'log+smtp',
      recipients: ['a@b.com'],
      subject: 's',
      ms: 3,
      error: '',
      channels: [{ transport: 'log', ok: true, ms: 1, error: '' }],
    }),
    {
      at: 5,
      ok: true,
      transport: 'log+smtp',
      recipients: ['a@b.com'],
      subject: 's',
      ms: 3,
      error: '',
      channels: [{ transport: 'log', ok: true, ms: 1, error: '' }],
    },
  );
  // 脏输入也要补齐字段，而不是漏字段
  const dirty = toDeliveryView({ ok: 'yes', recipients: ['a', 2, null], at: 'now' });
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.recipients, ['a']);
  assert.equal(typeof dirty.at, 'number');
  assert.equal(typeof dirty.ms, 'number');
  assert.equal(dirty.error, '');
  assert.equal(dirty.subject, '');
  assert.equal(dirty.transport, '');
  assert.deepEqual(dirty.channels, [], '老账本条目没有 channels：必须补成空数组，页面只处理一种形状');
  // channels 里的脏条目也要逐字段补齐（typert 是 strict schema，缺字段会在浏览器侧炸）
  const messy = toDeliveryView({ channels: [null, { ok: 'yes' }, { transport: 'smtp', ok: true, ms: 2, error: '' }] });
  assert.deepEqual(messy.channels, [
    { transport: '', ok: false, ms: 0, error: '' },
    { transport: 'smtp', ok: true, ms: 2, error: '' },
  ]);
  assert.deepEqual(toDeliveryView(undefined), {
    at: toDeliveryView(undefined).at, ok: false, transport: '', recipients: [], subject: '', ms: 0, error: '', channels: [],
  });
});

// ---------------------------------------------------------------------------
// 多通道（「怎么发」改成列表之后的核心行为）
// ---------------------------------------------------------------------------

test('resolveTransports：老配置的单个 transport 会被当成一个通道（迁移不能丢配置）', () => {
  // settings 的 describe() 返回的是 schema 解析后的完整值：没写过 transports 的老配置读出来是 []
  assert.deepEqual(resolveTransports({ transport: 'smtp', transports: [] }), ['smtp']);
  assert.deepEqual(resolveTransports({ transport: 'resend', transports: [] }), ['resend']);
  assert.deepEqual(resolveTransports({ transports: [] }), ['log'], '全空回落到 schema 默认通道');
  assert.deepEqual(resolveTransports(undefined), ['log']);
});

test('resolveTransports：非空数组作数、去重、按规范顺序排列（与点击顺序无关）', () => {
  assert.deepEqual(resolveTransports({ transport: 'smtp', transports: ['resend'] }), ['resend'], '数组非空时旧字段不参与');
  assert.deepEqual(resolveTransports({ transports: ['smtp', 'log'] }), ['log', 'smtp']);
  assert.deepEqual(resolveTransports({ transports: ['smtp', 'log', 'smtp'] }), ['log', 'smtp']);
  assert.deepEqual(resolveTransports({ transports: ['resend', 'smtp', 'log'] }), ['log', 'smtp', 'resend']);
  assert.deepEqual(resolveTransports({ transports: ['nope'] }), ['log'], '不认识的通道忽略，别把配置卡死');
});

test('channelIssues：只查这个通道自己的必填项（与通道无关的问题不重复报）', () => {
  assert.deepEqual(channelIssues({ smtpHost: 'smtp.qq.com', smtpUser: 'me@qq.com' }, 'smtp'), []);
  assert.match(channelIssues({ smtpHost: '', smtpUser: 'me@qq.com' }, 'smtp')[0], /主机/);
  assert.match(channelIssues({ smtpHost: 'smtp.qq.com', smtpUser: '' }, 'smtp')[0], /用户名/);
  assert.deepEqual(channelIssues({ smtpHost: '', smtpUser: '' }, 'log'), [], 'log 不需要任何配置');
  assert.match(channelIssues({ fromAddress: '' }, 'resend')[0], /发件人/);
});

test('sendAll：一个通道失败不影响其它通道（多选不能互相拖下水）', async () => {
  const lines = [];
  const config = { ...defaultConfig(), recipients: 'me@qq.com' };
  const results = await sendAll(['log', 'smtp'], config, { to: ['me@qq.com'], subject: 's', text: 't' }, {
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: () => {} },
  });
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { transport: 'log', ok: true, ms: results[0].ms, error: '', retryable: false });
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /主机/);

  const summary = summarizeResults(results);
  assert.equal(summary.ok, false);
  assert.equal(summary.transport, 'log+smtp');
  assert.match(summary.error, /smtp: /, '汇总要说清是哪个通道失败');
  assert.equal(summary.retryable, false, 'CONFIG 类失败不重试');
});

test('summarizeResults：只要有一个通道成功就绝不重试（否则成功的通道会收到重复邮件）', () => {
  const network = { transport: 'smtp', ok: false, ms: 1, error: 'ECONNRESET', retryable: true };
  assert.equal(summarizeResults([{ transport: 'log', ok: true, ms: 1, error: '', retryable: false }, network]).retryable, false);
  assert.equal(summarizeResults([network, { transport: 'resend', ok: false, ms: 1, error: 'ETIMEDOUT', retryable: true }]).retryable, true,
    '全军覆没且是网络类错误才允许退避重试（与单通道时代一致）');
  assert.equal(summarizeResults([network, { transport: 'resend', ok: false, ms: 1, error: '535', retryable: false }]).retryable, true,
    '只要还有一条可重试的网络错误就重试');
  assert.equal(summarizeResults([]).ok, false, '一个通道都没有 = 没发出去，不能算成功');
});

test('sendTestMail：勾了几个通道就测几个，逐通道结果都带回来', async () => {
  const lines = [];
  const result = await sendTestMail({
    config: { ...defaultConfig(), transports: ['log', 'smtp'], recipients: 'me@qq.com' },
    logger: { info: (m) => lines.push(m), warn: (m) => lines.push(m), debug: () => {} },
  });
  assert.equal(result.ok, false, 'SMTP 没配好：整体不算成功');
  assert.deepEqual(result.channels.map((item) => [item.transport, item.ok]), [['log', true], ['smtp', false]]);
  assert.equal(result.transport, 'log+smtp');
  assert.equal(result.subject.length > 0, true, '失败也要带主题：页面的读数靠它');
});
