import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeHeaderValue, formatRfc2822Date, extractAddress, extractDisplayName, formatAddressHeader, buildMimeMessage, wrap } from '../lib/mime.js';

test('encodeHeaderValue：ASCII 原样，非 ASCII 走 RFC 2047 B-encode', () => {
  assert.equal(encodeHeaderValue('Hello world'), 'Hello world');
  const encoded = encodeHeaderValue('任务完成 · 修复登录页');
  assert.match(encoded, /^=\?UTF-8\?B\?/);
  const payload = /\?B\?([A-Za-z0-9+/=]+)\?=/.exec(encoded)[1];
  assert.equal(Buffer.from(payload, 'base64').toString('utf8'), '任务完成 · 修复登录页');
});

test('encodeHeaderValue：超长中文折成多个 encoded-word', () => {
  const encoded = encodeHeaderValue('中'.repeat(80));
  assert.ok(encoded.split('\r\n ').length > 1);
  const joined = encoded.replace(/\r\n /g, '');
  const parts = [...joined.matchAll(/\?B\?([A-Za-z0-9+/=]+)\?=/g)].map((m) => m[1]);
  assert.equal(Buffer.from(parts.join(''), 'base64').toString('utf8'), '中'.repeat(80));
});

test('extractAddress：从 "名字 <地址>" 里摘地址', () => {
  assert.equal(extractAddress('DSH <a@b.com>'), 'a@b.com');
  assert.equal(extractAddress('a@b.com'), 'a@b.com');
});

test('extractDisplayName：裸地址没有显示名', () => {
  assert.equal(extractDisplayName('DSH <a@b.com>'), 'DSH');
  assert.equal(extractDisplayName('a@b.com'), '');
});

test('formatAddressHeader：只编码显示名，地址必须保持裸 ASCII', () => {
  const header = formatAddressHeader('DSH 通知 <3901137470@qq.com>');
  // 地址必须字面可读：encoded-word 不允许出现在 addr-spec 里，整串 B-encode 会被
  // QQ 邮箱以 550 The "From" header is missing or invalid 直接拒收（真机踩过）。
  assert.match(header, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <3901137470@qq\.com>$/);
  assert.equal(formatAddressHeader('a@b.com'), 'a@b.com');
  assert.equal(formatAddressHeader('Plain <a@b.com>'), 'Plain <a@b.com>');
});

test('wrap：按宽度折行', () => {
  assert.equal(wrap('abcdef', 2), 'ab\r\ncd\r\nef');
});

test('formatRfc2822Date：形状正确', () => {
  const text = formatRfc2822Date(new Date(1776000000000));
  assert.match(text, /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/);
});

test('buildMimeMessage：多部分邮件含两个 base64 部件', () => {
  const raw = buildMimeMessage({
    from: 'DSH 通知 <noreply@example.com>',
    to: ['a@example.com', 'b@example.com'],
    subject: '[DSH] 任务完成 · 修复登录页',
    text: '纯文本正文',
    html: '<p>HTML 正文</p>',
    date: new Date(1776000000000),
    messageId: 'fixed@dsh-notify-p',
  });
  // 显示名编码、地址裸着；折叠可能把 encoded-word 与地址拆到两行，所以先解折行再断言。
  const unfolded = raw.replace(/\r\n /g, '');
  assert.match(unfolded, /^From: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <noreply@example\.com>$/m);
  assert.doesNotMatch(raw, /=\?UTF-8\?B\?[^?\r\n]*<[^>]*>/, '地址绝不能被包进 encoded-word');
  assert.match(raw, /^To: a@example\.com, b@example\.com$/m);
  assert.match(raw, /^Message-ID: <fixed@dsh-notify-p>$/m);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="dsh-notify-p-/);
  const parts = raw.split(/--dsh-notify-p-[0-9a-f-]+/);
  const decode = (chunk) => Buffer.from(chunk.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(decode(parts[1]), '纯文本正文');
  assert.equal(decode(parts[2]), '<p>HTML 正文</p>');
  assert.match(raw, /--dsh-notify-p-[0-9a-f-]+--/);
});

test('buildMimeMessage：没有 HTML 时退化单部分', () => {
  const raw = buildMimeMessage({ from: 'a@b.com', to: 'c@d.com', subject: 'hi', text: 'body', messageId: 'x@y' });
  assert.match(raw, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(raw, /multipart/);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8'), 'body');
});
