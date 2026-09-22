// dsh-notify-p · MIME 构造（纯函数，只依赖 node:crypto 生成 Message-ID）
//
// 中文主题走 RFC 2047 B-encode，正文 base64，multipart/alternative 带文本 + HTML 两版。

import { randomUUID } from 'node:crypto';

/**
 * 按宽度折行（base64 正文按 76 字符折）。
 * @param {string} text 待折行文本
 * @param {number} [width] 每行宽度
 * @returns {string} 折行后的文本（不含结尾换行）
 */
export function wrap(text, width = 76) {
  const out = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out.join('\r\n');
}

/**
 * RFC 2047 编码一个头字段值：纯 ASCII 原样，含非 ASCII 时按 B-encode 折成多个 encoded-word。
 * @param {string} value 头字段值
 * @returns {string}
 */
export function encodeHeaderValue(value) {
  const text = String(value ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  // encoded-word 单段有 75 字符上限（含 =?UTF-8?B?...?=），这里保守按 48 字节切
  const chunks = [];
  for (let i = 0; i < encoded.length; i += 48) chunks.push(`=?UTF-8?B?${encoded.slice(i, i + 48)}?=`);
  return chunks.join('\r\n ');
}

/**
 * RFC 2822 日期。
 * @param {Date} [date] 日期对象
 * @returns {string}
 */
export function formatRfc2822Date(date = new Date()) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${DAYS[date.getDay()]}, ${p(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} `
    + `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
}

/**
 * 从 "名字 <地址>" 或裸地址里摘出地址部分。
 * @param {string} value 输入
 * @returns {string}
 */
export function extractAddress(value) {
  const text = String(value ?? '').trim();
  const m = /<([^>]+)>/.exec(text);
  return (m ? m[1] : text).trim();
}

/**
 * 从 "名字 <地址>" 里摘出显示名；裸地址返回空串。
 * @param {string} value 输入
 * @returns {string}
 */
export function extractDisplayName(value) {
  const text = String(value ?? '').trim();
  const m = /^(.*?)<[^>]+>\s*$/.exec(text);
  if (m === null) return '';
  return m[1].trim().replace(/^"(.*)"$/, '$1').trim();
}

/**
 * 拼一个 RFC 5322 地址头字段值：**只编码显示名**，地址保持裸 ASCII。
 *
 * 为什么不能整串丢给 encodeHeaderValue：RFC 2047 的 encoded-word 不允许出现在
 * addr-spec 里，成对尖括号也必须字面可读。整串 B-encode 之后 QQ 邮箱会直接以
 * `550 The "From" header is missing or invalid` 拒信（RFC5322/RFC2047/RFC822）。
 * @param {string} value "名字 <地址>" 或裸地址
 * @returns {string} `=?UTF-8?B?…?= <addr>` 或裸地址
 */
export function formatAddressHeader(value) {
  const address = extractAddress(value);
  const name = extractDisplayName(value);
  if (name === '' || address === '') return name === '' ? address : encodeHeaderValue(name);
  return `${encodeHeaderValue(name)} <${address}>`;
}

/**
 * 构造完整 MIME 邮件（含头）。
 * @param {object} mail 邮件内容
 * @param {string} mail.from 发件人（"名字 <地址>" 或裸地址；只有显示名会被 RFC 2047 编码）
 * @param {string|string[]} mail.to 收件人
 * @param {string} [mail.replyTo] 回复地址
 * @param {string} mail.subject 主题（可含非 ASCII）
 * @param {string} mail.text 纯文本正文
 * @param {string} [mail.html] HTML 正文
 * @param {Date} [mail.date] 发送时间
 * @param {string} [mail.messageId] 自定义 Message-ID
 * @returns {string} 完整邮件报文（CRLF 行尾，不含结尾 .）
 */
export function buildMimeMessage(mail) {
  const to = Array.isArray(mail.to) ? mail.to : [mail.to];
  const boundary = `dsh-notify-p-${randomUUID()}`;
  const headers = [
    `From: ${formatAddressHeader(mail.from)}`,
    `To: ${to.map((addr) => formatAddressHeader(addr)).join(', ')}`,
  ];
  if (mail.replyTo) headers.push(`Reply-To: ${encodeHeaderValue(mail.replyTo)}`);
  headers.push(
    `Subject: ${encodeHeaderValue(mail.subject)}`,
    `Date: ${formatRfc2822Date(mail.date ?? new Date())}`,
    `Message-ID: <${mail.messageId ?? `${randomUUID()}@dsh-notify-p`}>`,
    'MIME-Version: 1.0',
  );

  if (typeof mail.html !== 'string' || mail.html === '') {
    headers.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
    return `${headers.join('\r\n')}\r\n\r\n${wrap(Buffer.from(mail.text, 'utf8').toString('base64'))}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (contentType, body) => [
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrap(Buffer.from(body, 'utf8').toString('base64')),
  ].join('\r\n');
  const body = [
    'This is a multi-part message in MIME format.',
    part('text/plain', mail.text),
    part('text/html', mail.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}
