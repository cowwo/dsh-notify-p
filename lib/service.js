// dsh-notify-p · Host 半的 Remote 服务
//
// 设置页上的「发送测试邮件」和「最近一次投递」需要一个 Host 动作与一个 Host 读取，
// 这是本插件唯一对浏览器暴露的 API 面。它刻意很窄：只有 test 和 state 两个方法，
// 都不接受参数——设置页要改的东西一律走 settings 命名空间，不走这里。
//
// 装配方式：宿主在 start() 里 ctx.plugin(MailNotifyRemoteService, runtime)，
// runtime 由装配逻辑提供（见 lib/index.js），所以本文件不碰任何插件状态。
//
// 注意：方法名必须与 lib/typert.host.js 清单里声明的 method 一字不差，
// 否则浏览器调用会打到不存在的方法上（test/client.test.mjs 有护栏）。
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

/**
 * mailNotify 命名空间：给设置页用的 Host 能力。
 */
export class MailNotifyRemoteService extends TypertRemoteService {
  /**
   * @param {object} ctx cordis 上下文
   * @param {object} runtime 装配逻辑给的运行态接口 { test, state }
   */
  constructor(ctx, runtime) {
    super(ctx, 'mailNotify');
    this.runtime = runtime ?? {};
  }

  /**
   * 立刻按当前配置发一封测试邮件（不等合并窗口、不占限流额度）。
   * 投递失败不抛异常：把失败当成结果返回，页面才能把原因显示出来。
   * @returns {Promise<object>} 投递结果
   */
  async test() {
    const runtime = this.runtime ?? {};
    if (typeof runtime.test !== 'function') {
      throw new Error('mailNotify/test: runtime is not wired');
    }
    return runtime.test();
  }

  /**
   * 投递账本快照（计数 + 最近若干条）。
   * @returns {object} 账本快照
   */
  async state() {
    const runtime = this.runtime ?? {};
    if (typeof runtime.state !== 'function') {
      throw new Error('mailNotify/state: runtime is not wired');
    }
    return runtime.state();
  }
}

export default MailNotifyRemoteService;
