// dsh-notify-p · 干跑脚本（不连邮箱，把整条渲染链路跑给你看）
//
// 用法：node test/dryrun.mjs
// 它用真实的 policy + render + send/log 走一遍：事件载荷 → 判定 → 渲染 → "投递"。

import { defaultConfig, resolveTransports } from '../lib/config.js';
import { classifyTurnEnd, isOutcomeEnabled, shouldSkipSession } from '../lib/policy.js';
import { renderMail } from '../lib/render.js';
import { createLogSender } from '../lib/send/log.js';
import { resolveFrom } from '../lib/send/index.js';

const logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`[warn] ${message}`),
  debug: () => {},
};

const config = {
  ...defaultConfig(),
  recipients: 'you@example.com',
  senderName: 'DSH 通知 / DSH Notification',
  fromAddress: 'me@example.com',
  publicBaseUrl: 'http://127.0.0.1:3081',
};

const session = {
  id: 'session-a25bd099-cae9-4732-8179-f8eabd33541b',
  header: { cwd: '/root/test/12000011_响应式网页适配', createdAt: Date.now() - 600000 },
};

const cases = [
  {
    label: '任务完成',
    event: { type: 'turn/end', time: Date.now(), data: { turn: 3, reason: { kind: 'completed' } } },
    sessionTitle: '修复登录页样式',
    durationMs: 252000,
  },
  {
    label: '任务出错（agent/error 提供更原始的报错文本）',
    event: { type: 'turn/end', time: Date.now(), data: { turn: 4, reason: { kind: 'error', error: { message: '扁平化文本', code: 'E_FLAT' } } } },
    sessionTitle: '跑全量测试',
    durationMs: 41000,
    detail: 'connect ECONNREFUSED 127.0.0.1:5432 [E_CONNREFUSED]',
  },
  {
    label: '等你审批（P0-4：只发工具名 + 原因，不发命令正文）',
    event: { type: 'approval/asked', time: Date.now(), data: { id: 'ap-1', toolName: 'Bash', callId: 'call-9', reason: '需要执行删除操作' } },
    sessionTitle: '清理构建产物',
    durationMs: 0,
    approval: true,
  },
  {
    label: '重启/热更导致的 aborted（默认不发，验证 P0-1）',
    event: { type: 'turn/end', time: Date.now(), data: { turn: 5, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } },
    sessionTitle: '写一半的任务',
    durationMs: 12000,
  },
  {
    label: '子代理会话（默认跳过，验证 P0-2）',
    event: { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } },
    sessionTitle: '子代理干活',
    durationMs: 90000,
    subagent: true,
  },
];

const sender = createLogSender({ logger, previewLimit: 900 });
const channels = resolveTransports(config);
const from = resolveFrom(config, channels[0]);

for (const item of cases) {
  const targetSession = item.subagent
    ? { ...session, id: 'session-child-0001', header: { ...session.header, origin: 'subagent' } }
    : session;

  const skip = shouldSkipSession(targetSession, config);
  const classified = item.event.type === 'approval/asked'
    ? { outcome: 'approval' }
    : classifyTurnEnd(item.event.data);

  console.log(`\n${'='.repeat(78)}\n### ${item.label}`);

  if (skip) {
    console.log('→ 判定：跳过（子代理会话，includeSubagents=false）');
    continue;
  }
  if (classified === null) {
    console.log('→ 判定：跳过（不认识的 reason）');
    continue;
  }
  if (!isOutcomeEnabled(classified.outcome, config)) {
    console.log(`→ 判定：跳过（结局 ${classified.outcome} 的开关是关的）`);
    continue;
  }

  const mail = renderMail({
    outcome: classified.outcome,
    sessionId: targetSession.id,
    sessionTitle: item.sessionTitle,
    cwd: targetSession.header.cwd,
    turn: item.event.data?.turn,
    endedAt: item.event.time,
    durationMs: item.durationMs,
    errorText: item.detail ?? classified.detail ?? '',
    approval: item.approval ? { toolName: item.event.data.toolName, reason: item.event.data.reason } : undefined,
    config,
    baseUrl: config.publicBaseUrl,
  });

  console.log(`→ 判定：发送（${classified.outcome}）`);
  await sender.send({ from, to: ['you@example.com'], subject: mail.subject, text: mail.text, html: mail.html });
}

console.log(`\n${'='.repeat(78)}\n干跑结束。真实发信请在「怎么发」里勾上 smtp / resend 并配好凭据（当前通道：${channels.join(' + ')}）。`);
