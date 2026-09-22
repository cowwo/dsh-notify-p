// dsh-notify-p · typert Host 清单（手写，非生成）
//
// 为什么手写：本插件没有 TypeScript 构建步骤，而 dsh-typert-loader 只要求包导出
// `./typert` 且其模块带一个 TYPERT 清单对象。清单里的 schema 必须是 zod v4 实例。
//
// 只声明两个方法，都不带参数：
//   mailNotify/test   立刻发一封测试邮件（失败作为结果返回，不抛异常）
//   mailNotify/state  投递账本快照
//
// 结果一律是"扁平 + 全部可选字段都有默认"的形状，方便严格校验：
// 失败时 ok=false 且 error 非空，而不是换成另一种结构。
import { z } from 'zod';

/** 一个通道这一次的成败（多通道扇出后，账本里要看得出是哪个通道）。 */
const channelSchema = z.object({
  transport: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  error: z.string(),
});

/** 一次投递的结果（测试邮件与真实投递共用同一形状）。 */
const deliverySchema = z.object({
  at: z.number(),
  ok: z.boolean(),
  transport: z.string(),
  recipients: z.array(z.string()),
  subject: z.string(),
  ms: z.number(),
  error: z.string(),
  channels: z.array(channelSchema),
});

/** 账本快照。 */
const stateSchema = z.object({
  counts: z.object({ sent: z.number(), failed: z.number() }),
  recent: z.array(deliverySchema),
});

export const TYPERT = {
  package: 'dsh-notify-p',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-notify-p#mailNotify/test',
      service: 'mailNotify',
      namespace: 'mailNotify',
      method: 'test',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-notify-p#mailNotify/test:result',
        schema: deliverySchema,
      },
      sourceLocation: { file: 'lib/service.js', line: 1, column: 1 },
    },
    {
      id: 'dsh-notify-p#mailNotify/state',
      service: 'mailNotify',
      namespace: 'mailNotify',
      method: 'state',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: 'dsh-notify-p#mailNotify/state:result',
        schema: stateSchema,
      },
      sourceLocation: { file: 'lib/service.js', line: 1, column: 1 },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
};

export default TYPERT;
