import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMail, formatDuration, workspaceName, displayTitle, formatTime } from '../lib/render.js';
import { defaultConfig } from '../lib/config.js';

const base = {
  outcome: 'completed',
  sessionId: 'session-a25bd099-cae9-4732-8179-f8eabd33541b',
  sessionTitle: '修复登录页样式',
  cwd: '/root/test/12000011_响应式网页适配',
  turn: 3,
  endedAt: 1776000000000,
  durationMs: 252000,
  config: defaultConfig(),
  baseUrl: 'http://127.0.0.1:3081',
};

test('renderMail：主题中英并列 + 标题', () => {
  const mail = renderMail(base);
  assert.match(mail.subject, /^\[DSH\] 任务完成 \/ completed · 修复登录页样式$/);
});

test('renderMail：正文写清"是哪个会话"，并附可点击直达链接', () => {
  const mail = renderMail(base);
  assert.match(mail.text, /会话标题 \/ Session：修复登录页样式/);
  assert.match(mail.text, /工作区　 \/ Workspace：12000011_响应式网页适配/);
  assert.match(mail.text, /会话 ID　\/ Session ID：session-a25bd099/);
  assert.match(mail.text, /直达会话 \/ Open session：http:\/\/127\.0\.0\.1:3081\/\?session=session-a25bd099/);
  assert.match(mail.html, /href="http:\/\/127\.0\.0\.1:3081\/\?session=session-a25bd099-cae9-4732-8179-f8eabd33541b"/);
  assert.equal(mail.link, 'http://127.0.0.1:3081/?session=session-a25bd099-cae9-4732-8179-f8eabd33541b');
});

test('renderMail：关掉链接开关就不出现链接（也不出现按钮）', () => {
  const mail = renderMail({ ...base, config: { ...defaultConfig(), linkEnabled: false } });
  assert.equal(mail.link, '');
  assert.doesNotMatch(mail.text, /直达会话/);
  assert.doesNotMatch(mail.html, /打开该会话/);
});

test('renderMail：拿不到标题时降级成会话 ID 前 8 位（要剥掉 session- 前缀）', () => {
  const mail = renderMail({ ...base, sessionTitle: '' });
  assert.match(mail.subject, /· a25bd099/);
  const none = renderMail({ ...base, sessionTitle: '', sessionId: '' });
  assert.match(none.title, /unknown session/);
});

test('renderMail：失败带原因，审批带工具名/原因且不含命令正文（P0-4）', () => {
  const failed = renderMail({ ...base, outcome: 'error', errorText: 'llm timeout [E_TIMEOUT]' });
  assert.match(failed.text, /任务出错/);
  assert.match(failed.text, /失败原因 \/ Failure：\n {2}llm timeout \[E_TIMEOUT\]/);

  const approval = renderMail({
    ...base,
    outcome: 'approval',
    approval: { toolName: 'Bash', reason: '需要执行删除操作' },
  });
  assert.match(approval.text, /等待你审批/);
  assert.match(approval.text, /工具 \/ Tool：Bash/);
  assert.doesNotMatch(approval.text, /命令 \/ Command/);
});

test('HTML 转义：会话标题里的尖括号不会破坏正文', () => {
  const mail = renderMail({ ...base, sessionTitle: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(mail.html, /<img src=x/);
  assert.match(mail.html, /&lt;img/);
});

test('formatDuration：中英并列', () => {
  assert.equal(formatDuration(252000), '4 分 12 秒 / 4m 12s');
  assert.equal(formatDuration(45000), '45 秒 / 45s');
  assert.equal(formatDuration(3725000), '1 小时 2 分 5 秒 / 1h 2m 5s');
  assert.equal(formatDuration(-1), '');
});

test('workspaceName：跨平台取 basename', () => {
  assert.equal(workspaceName('/root/test/12000012_dsh通知'), '12000012_dsh通知');
  assert.equal(workspaceName('/root/test/abc/'), 'abc');
  assert.equal(workspaceName('C:\\Users\\me\\proj'), 'proj');
  assert.equal(workspaceName(''), '');
});

test('displayTitle：空标题降级', () => {
  assert.equal(displayTitle('x', 'session-1234567890'), 'x');
  assert.equal(displayTitle('', 'session-1234567890'), '12345678');
  assert.equal(displayTitle('', 'short'), 'short');
  assert.equal(displayTitle('', ''), '(未知会话 / unknown session)');
});

test('formatTime：本地时间可格式化（形状断言，避免时区耦合）', () => {
  assert.match(formatTime(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatTime(Number.NaN), '');
});
