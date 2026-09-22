// dsh-notify-p · 浏览器半（手写客户端包，无构建步骤）
//
// 形态：**左侧「设置」导航里独立一页**（settings.section，order 60 = 排在 icon 管理之后）。
//
// 这一页只回答两个问题：
//   1. 配好了吗   → 分组状态点（已配置 / 未配置 / 不适用）
//   2. 能发出去吗 → 顶部状态条 + 发送测试邮件 + 最近一次投递结果
// 其余一切让路：不额外套卡片、不加编号、不做中英同屏。
//
// 编辑模型：**没有保存/放弃按钮，改完即时生效**。按字段类型区别对待：
//   - 开关 / 下拉 / 分段：立刻写
//   - 数字 / 文本：防抖（停手再写）+ 失焦兜底
//   - 密码：只在失焦或回车时写，且**每个凭据引用名各写各的**
//
// 六条硬约束（前三条踩过，后三条是本轮修掉的）：
//   1. 注册页面只依赖 `slots`。远程命名空间 / locale 各开一个非阻塞的 ctx.inject 去填；
//      全部塞进同一个 inject 列表时，只要有一个服务当时不可用，回调就永远不触发——
//      页面会**静默消失**且没有任何报错。
//   2. Remote 方法返回 `{ ok, value }` 信封，不是裸值。
//   3. 全程兜异常：浏览器半出问题只该让这一页不可用，绝不能把设置面板带崩。
//   4. 凭据的写入目标必须由「哪一行」决定，不能从草稿里猜 `smtpPasswordRef`——
//      否则 Resend 的 Key 会被写进 SMTP 的引用名里，而页面一直显示「未配置」。
//   5. 只用宿主主题里真实存在的 token。`--dsw-alias-interact-*` / `--dsw-alias-border-secondary`
//      都不存在，写了会静默退回硬编码浅色值，暗色模式下整页失配。
//   6. 破坏性操作必须二次确认，且不与常规按钮同形。
window.__ModuleLoader__.load({
  id: 'dsh-notify-p',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    /** 宿主 UI 原语。取不到时降级为等价的最小实现，页面不该因为原语缺失而白屏。 */
    const P = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives') ?? {};
      } catch (error) {
        console.warn('[dsh-notify-p] 原语不可用，降级为内置实现 / primitives unavailable:', error);
        return {};
      }
    })();

    /** 只等必需服务：页面注册本身只需要 slots（硬约束 1）。 */
    const inject = ['slots'];

    const NS = 'dsh-notify-p';

    /** Host Remote 的命名空间（与 lib/typert.host.js 清单一致）。 */
    const REMOTE_NS = 'mailNotify';

    /** 文本 / 数字字段的防抖时长（毫秒）。 */
    const TEXT_DEBOUNCE_MS = 600;
    const NUMBER_DEBOUNCE_MS = 500;

    /** 默认凭据引用名 / 帮助弹窗的主题（与 Host 侧 lib/config.js 保持一致）。 */
    const DEFAULT_REFS = {
      'cred.smtp': 'DSH_MAIL_NOTIFY_SMTP_PASSWORD',
      'cred.resend': 'RESEND_API_KEY',
    };
    const HELP_KIND = { 'cred.smtp': 'smtp', 'cred.resend': 'resend' };

    // ---------------------------------------------------------------------------
    // 文案：zh 是内置兜底，en 走 locale 字典；界面永远只显示一种语言（不同屏并列）。
    // ---------------------------------------------------------------------------
    const ZH = {
      'group.status': '投递状态',
      'evidence.label': '最近一次发送',
      'evidence.never': '还没有试过',
      'evidence.ok': '成功，用时 {ms} 毫秒，{ago}',
      'evidence.okLogged': '已记入账本，{ago}',
      'evidence.fail': '失败',
      'cred.saved': '已保存',
      'cred.notSaved': '还没保存',
      'cred.replace': '更换',
      'cred.clear': '清除',
      'cred.placeholder': '粘贴授权码',
      'err.auth': '服务端拒绝了这组账号密码',
      'err.authHint': '多半是授权码不对或过期了：QQ 邮箱要的是「授权码」而不是登录密码，重新生成一个再填。',
      'err.rejected': '发件人被拒',
      'err.rejectedHint': '收件服务器不接受这个发件人。换个发件地址（一般在「发件人与链接」里）再试。',
      'err.network': '连不上服务器',
      'err.networkHint': '检查主机名与端口；本机防火墙或公司网络也可能挡住 465 / 587。',
      'err.other': '发送失败',
      'err.otherCode': '发送失败（{code}）',
      'err.otherHint': '原始报错在下面，把它连同主机名一起看。',
      nav: '邮件通知',
      lead: '会话干完活、出错或卡住时，给你发一封邮件。',

      'save.auto': '改动即时生效',
      'save.saving': '正在保存…',
      'save.savedAgo': '已保存，{n} 秒前',
      'save.error': '保存失败：{error}',
      'save.reload': '重新读取',
      'save.checkingCred': '正在确认授权码是否已写入…',
      'save.credCheckFailed': '凭据状态读取失败：{error}',

      'status.disabled': '已关闭，不会发任何通知',
      'status.needRecipients': '还差一个收件人',
      'status.needHost': '还差 SMTP 服务器地址',
      'status.needUser': '还差 SMTP 用户名',
      'status.needCredential': '还差{cred}',
      'status.simulated': '现在不会真的发信',
      'status.ready': '可以发信了',
      'status.lastFailed': '上次发信失败',
      'status.notServed': '这一页读不到本插件的配置',

      // 判决下面那句人话。只说用户的事，不说实现的事。
      'status.why.disabled': '打开下面任意一种情况，才会开始通知你。',
      'status.why.needRecipients': '没有收件邮箱，邮件没有地方可去。',
      'status.why.needHost': '通道选了 SMTP，但还没填服务器地址。',
      'status.why.needUser': '多数邮箱要求用户名和授权码成对出现。',
      'status.why.needCredential': '没填它，服务端会拒收这封信。',
      'status.why.simulated': '通道是「只记录」，所以不会真的发出去。想真收到信，就换成 SMTP 或 Resend。',
      'status.why.ready': '配置齐了。发一封测试邮件，确认服务端真的收下。',
      'status.why.lastFailed': '配置看着没问题，但上一次没发出去。',

      'act.enable': '启用',
      'act.chooseTransport': '选真实通道',
      'act.goFill': '去填写',
      'act.test': '发送测试邮件',
      'act.testing': '正在发送…',
      'act.retest': '重新测试',
      'act.needsRestart': '需要重启 DSH 后才能测试',
      'act.testHint': '按现在的配置真发一封到收件人，不用等某个会话干完。',

      'group.recipients': '收件人',
      'group.transport': '怎么发',
      'group.outcomes': '什么时候发给我',
      'group.optional': '可选设置',
      'group.sender': '发件人与链接',
      'group.advanced': '高级',


      'recipients.label': '收件邮箱',
      'recipients.placeholder': 'you@qq.com',
      'recipients.hint': '一行一个，也接受逗号或分号分隔。',
      'recipients.ok': '{n} 个有效',
      'recipients.none': '还没填',
      'recipients.invalid': '格式不对，不会被发送：{list}',

      'time.justNow': '刚刚',
      'time.secondsAgo': '{n} 秒前',
      'time.minutesAgo': '{n} 分钟前',
      'time.hoursAgo': '{n} 小时前',
      'time.daysAgo': '{n} 天前',

      'transportState.log': '不发送真邮件',
      'transportState.done': '已配好',
      'transportState.todo': '还没配好',

      'transport.label': '发送通道',
      'transport.log': '只记录',
      'transport.smtp': 'SMTP',
      'transport.resend': 'Resend',
      'transport.log.note': '先跑通用的选项：不连服务器，邮件只写进投递账本。',
      'transport.smtp.note': '用自己的邮箱发（QQ / 163 / Gmail / Outlook / iCloud…），只需一个授权码。',
      'transport.resend.note': '用 Resend 的 HTTP API 发，需要有自己验证过的域名。',

      'preset.label': '邮箱服务商',
      'preset.other': '其他',
      'preset.detected': '已按「{name}」填好',

      'smtp.host': 'SMTP 主机',
      'smtp.port': '端口',
      'smtp.secure': '加密',
      'smtp.user': '用户名',
      'smtp.accountMismatch': '{host} 是{name}的服务器，但账号是 {user}：对不上，认证会失败。把账号换成 {suffix} 结尾的邮箱，或把服务商改成账号所属的那一家。',

      'cred.smtp': 'SMTP 授权码',
      'cred.smtpHint': '不是登录密码。只写进凭据库，永不回显；离开输入框时保存。',
      'cred.smtpHelp': '怎么拿授权码？',
      'cred.smtpHelpTitle': '怎么拿 SMTP 授权码',
      'cred.smtpHelpBody': '授权码不是登录密码，是邮箱服务商单独发的口令（QQ 是 16 位）。\n\nQQ 邮箱：设置 → 账户 → 开启「POP3/SMTP 服务」→ 生成授权码。\n163 / 126：设置 → POP3/SMTP/IMAP → 开启服务 → 新增授权码。\nGmail：账号 → 安全性 → 两步验证 → 应用专用密码。\niCloud：Apple ID → 登录与安全 → App 专用密码。\nOutlook：账户 → 安全性 → 高级安全选项 → 应用密码。',
      'cred.resendHelp': '去哪拿 Key？',
      'cred.resendHelpTitle': '怎么拿 Resend API Key',
      'cred.resendHelpBody': '登录 resend.com → API Keys → Create API Key，复制以 re_ 开头的字符串。\n\n注意：域名未在 Resend 验证时，只能发给你注册 Resend 用的那个邮箱地址。',
      'cred.helpClose': '知道了',
      'cred.resend': 'Resend API Key',
      'cred.resendHint': '只写进凭据库，永不回显；离开输入框时保存。',
      'cred.clear': '清除',

      'outcomes.completed': '任务完成',
      'outcomes.completedHint': '会话正常干完一件活。',
      'outcomes.error': '任务出错',
      'outcomes.errorHint': '会话报错终止。',
      'outcomes.blocked': '卡住，需要你介入',
      'outcomes.blockedHint': 'agent 需要你补充信息才能继续。',
      'outcomes.approval': '等你审批',
      'outcomes.approvalHint': '立即发送，不参与合并窗口。',
      'outcomes.more': '还有 3 种情况（默认关）',
      'outcomes.countOn': '{n} 项开启',
      'outcomes.countOff': '全部关闭，不会通知你',
      'outcomes.aborted': '你主动停止',
      'outcomes.abortedHint': '只包含你自己按停止的那次。',
      'outcomes.interrupted': '系统中断',
      'outcomes.interruptedHint': 'DSH 重启 / 热更新 / 被父级取消。',
      'outcomes.maxTokens': '达到长度上限',
      'outcomes.maxTokensHint': '回复被长度上限截断。',
      'outcomes.minDuration': '完成时长下限',
      'outcomes.minDurationHint': '短于这个时长的完成不发信；只对「任务完成」生效，出错、卡住、审批不受此限。',
      'outcomes.subagents': '也通知子代理会话',
      'outcomes.subagentsHint': '一个 workflow 能扇出几十个子会话，默认不打扰。',

      'sender.name': '发件人显示名',
      'sender.nameHint': '收件人看到的发件人名字。',
      'sender.address': '发件人地址',
      'sender.addressHint': '留空则用上面的 SMTP 用户名。',

      'link.enabled': '邮件里带直达会话链接',
      'link.enabledHint': '需要另装深链插件才能被识别。',
      'link.base': '链接对外地址',
      'link.baseHint': '留空则读 DSH_WEB_URL；手机要能点开就填局域网地址或域名。',

      'adv.settle': '合并窗口',
      'adv.settleHint': '毫秒。期间同一会话又开新轮，就合并成一封。',
      'adv.rate': '发送速率上限',
      'adv.rateHint': '封/分钟，多会话并停时保护邮箱服务商。',
      'adv.pwRef': 'SMTP 凭据引用名',
      'adv.pwRefHint': '凭据库里的键名，改这里不会动已存的值。',
      'adv.keyRef': 'Resend 凭据引用名',
      'adv.statePath': '投递账本路径',
      'adv.statePathHint': '留空 = $DSH_HOME/dsh-notify-p/state.json。排错时 cat 它。',

      'unit.ms': '毫秒',
      'unit.perMin': '封/分钟',

      'danger.reset': '恢复全部默认',
      'danger.title': '恢复全部默认？',
      'danger.body': '这会清掉本插件在 settings.yaml 里的全部覆盖（收件人、通道、事件开关、节奏参数都会回到默认）。',
      'danger.keep': '凭据库里已存的授权码与 API Key 不受影响。',
      'danger.ok': '恢复默认',
      'danger.cancel': '取消',
    };

    const EN = {
      'group.status': 'Delivery status',
      'evidence.label': 'Last send',
      'evidence.never': 'Not tried yet',
      'evidence.ok': 'Sent in {ms} ms, {ago}',
      'evidence.okLogged': 'Written to the ledger, {ago}',
      'evidence.fail': 'Failed',
      'cred.saved': 'Saved',
      'cred.notSaved': 'Not saved yet',
      'cred.replace': 'Replace',
      'cred.clear': 'Clear',
      'cred.placeholder': 'Paste the authorization code / API key',
      'err.auth': 'The server rejected these credentials',
      'err.authHint': 'Usually a wrong or expired authorization code: QQ Mail needs an app code, not your login password. Generate a new one and paste it here.',
      'err.rejected': 'Sender rejected',
      'err.rejectedHint': 'The receiving server will not accept this sender. Change the From address under "Sender and links" and retry.',
      'err.network': 'Cannot reach the server',
      'err.networkHint': 'Check the host and port; a local firewall or corporate network may block 465 / 587.',
      'err.other': 'Send failed',
      'err.otherCode': 'Send failed ({code})',
      'err.otherHint': 'The raw error is below — read it together with the host name.',
      nav: 'Mail notification',
      lead: 'Get one email when a session finishes, fails, or gets stuck.',

      'save.auto': 'Changes apply immediately',
      'save.saving': 'Saving…',
      'save.savedAgo': 'Saved, {n}s ago',
      'save.error': 'Save failed: {error}',
      'save.reload': 'Reload',
      'save.checkingCred': 'Checking whether the code was written…',
      'save.credCheckFailed': 'Could not read the credential state: {error}',

      'status.disabled': 'Off — no notifications will be sent',
      'status.needRecipients': 'One recipient missing',
      'status.needHost': 'SMTP host missing',
      'status.needUser': 'SMTP user name missing',
      'status.needCredential': '{cred} missing',
      'status.simulated': 'Nothing is really sent',
      'status.ready': 'Ready to send',
      'status.lastFailed': 'The last send failed',
      'status.notServed': 'This page cannot read the plugin settings',

      'status.why.disabled': 'Turn on any case below and notifications start.',
      'status.why.needRecipients': 'Without a recipient address there is nowhere for the mail to go.',
      'status.why.needHost': 'The transport is SMTP, but no server address is set.',
      'status.why.needUser': 'Most providers want the user name and the authorization code together.',
      'status.why.needCredential': 'Without it the server will refuse the message.',
      'status.why.simulated': 'The transport is “record only”, so nothing actually goes out. Switch to SMTP or Resend to receive real mail.',
      'status.why.ready': 'Configuration is complete. Send a test email to confirm the server accepts it.',
      'status.why.lastFailed': 'The configuration looks fine, but the last attempt did not go out.',

      'act.enable': 'Turn on',
      'act.chooseTransport': 'Pick a real transport',
      'act.goFill': 'Fill it in',
      'act.test': 'Send a test email',
      'act.testing': 'Sending…',
      'act.retest': 'Test again',
      'act.needsRestart': 'Restart DSH to test',
      'act.testHint': 'Really sends one email to the recipients right now, without waiting for a session to finish.',

      'group.recipients': 'Recipients',
      'group.transport': 'How to send',
      'group.outcomes': 'When to notify me',
      'group.optional': 'Optional',
      'group.sender': 'Sender and links',
      'group.advanced': 'Advanced',


      'recipients.label': 'Recipient addresses',
      'recipients.placeholder': 'you@qq.com, one per line',
      'recipients.hint': 'One per line; commas and semicolons also work.',
      'recipients.ok': '{n} valid',
      'recipients.none': 'None yet',
      'recipients.invalid': 'Bad format, will not be sent: {list}',

      'time.justNow': 'just now',
      'time.secondsAgo': '{n}s ago',
      'time.minutesAgo': '{n} min ago',
      'time.hoursAgo': '{n} h ago',
      'time.daysAgo': '{n} d ago',

      'transportState.log': 'Nothing is sent',
      'transportState.done': 'Configured',
      'transportState.todo': 'Not configured yet',

      'transport.label': 'Transport',
      'transport.log': 'Record only',
      'transport.smtp': 'SMTP',
      'transport.resend': 'Resend',
      'transport.log.note': 'The dry-run option: no server connection, mail is only written to the ledger.',
      'transport.smtp.note': 'Send from your own mailbox (QQ / 163 / Gmail / Outlook / iCloud…). Only an authorization code is needed.',
      'transport.resend.note': 'Send through Resend’s HTTP API; needs a domain you have verified.',

      'preset.label': 'Mail provider',
      'preset.other': 'Other',
      'preset.detected': 'Filled in for “{name}”',

      'smtp.host': 'SMTP host',
      'smtp.port': 'Port',
      'smtp.secure': 'Security',
      'smtp.user': 'User name',
      'smtp.accountMismatch': '{host} is {name}’s server but the account is {user} — they do not match, so authentication will fail. Use a {suffix} address, or switch the provider to the account’s own.',

      'cred.smtp': 'SMTP authorization code',
      'cred.smtpHint': 'Not your login password. Written to the credential store only, never echoed; saved when you leave the field.',
      'cred.smtpHelp': 'How do I get one?',
      'cred.smtpHelpTitle': 'Getting an SMTP authorization code',
      'cred.smtpHelpBody': 'An authorization code is not your login password — the mail provider issues it separately.\n\nQQ Mail: Settings → Account → enable “POP3/SMTP service” → generate the code.\n163 / 126: Settings → POP3/SMTP/IMAP → enable the service → add an authorization code.\nGmail: Account → Security → 2-Step Verification → App passwords.\niCloud: Apple ID → Sign-In and Security → App-Specific Passwords.\nOutlook: Account → Security → Advanced security options → App password.',
      'cred.resendHelp': 'Where do I get a key?',
      'cred.resendHelpTitle': 'Getting a Resend API key',
      'cred.resendHelpBody': 'Sign in at resend.com → API Keys → Create API Key, then copy the string starting with re_.\n\nNote: without a verified domain, Resend can only mail the address you signed up with.',
      'cred.helpClose': 'Got it',
      'cred.resend': 'Resend API key',
      'cred.resendHint': 'Written to the credential store only, never echoed; saved when you leave the field.',
      'cred.clear': 'Clear',

      'outcomes.completed': 'Task completed',
      'outcomes.completedHint': 'A session finished its work normally.',
      'outcomes.error': 'Task failed',
      'outcomes.errorHint': 'A session ended with an error.',
      'outcomes.blocked': 'Stuck — needs you',
      'outcomes.blockedHint': 'The agent needs more from you to continue.',
      'outcomes.approval': 'Waiting for your approval',
      'outcomes.approvalHint': 'Sent immediately, outside the coalesce window.',
      'outcomes.more': '3 more cases (off by default)',
      'outcomes.countOn': '{n} on',
      'outcomes.countOff': 'All off — you will not be notified',
      'outcomes.aborted': 'You stopped it',
      'outcomes.abortedHint': 'Only when you pressed stop yourself.',
      'outcomes.interrupted': 'Interrupted by the system',
      'outcomes.interruptedHint': 'Harness restart / hot reload / cancelled by a parent.',
      'outcomes.maxTokens': 'Token limit reached',
      'outcomes.maxTokensHint': 'The reply was cut off by the length limit.',
      'outcomes.minDuration': 'Minimum duration',
      'outcomes.minDurationHint': 'Completions shorter than this are not sent; applies to “Task completed” only — failures, blocks and approvals always get through.',
      'outcomes.subagents': 'Also notify subagent sessions',
      'outcomes.subagentsHint': 'One workflow can fan out dozens of sub-sessions; off by default.',

      'sender.name': 'Sender display name',
      'sender.nameHint': 'The name your recipients see.',
      'sender.address': 'From address',
      'sender.addressHint': 'Leave empty to reuse the SMTP user name above.',

      'link.enabled': 'Include a link to the session',
      'link.enabledHint': 'Needs a deep-link plugin installed to be recognized.',
      'link.base': 'Public base URL',
      'link.baseHint': 'Empty reads DSH_WEB_URL. To open links on your phone, put a LAN address or domain here.',

      'adv.settle': 'Coalesce window',
      'adv.settleHint': 'Milliseconds. A new turn in the same session during this window is folded into one email.',
      'adv.rate': 'Send rate limit',
      'adv.rateHint': 'Emails per minute; protects your mail provider when many sessions stop at once.',
      'adv.pwRef': 'SMTP credential reference',
      'adv.pwRefHint': 'The key name in the credential store. Renaming does not touch the stored value.',
      'adv.keyRef': 'Resend credential reference',
      'adv.statePath': 'Delivery ledger path',
      'adv.statePathHint': 'Empty = $DSH_HOME/dsh-notify-p/state.json. cat it when debugging.',

      'unit.ms': 'ms',
      'unit.perMin': 'per min',

      'danger.reset': 'Reset everything to defaults',
      'danger.title': 'Reset everything to defaults?',
      'danger.body': 'This clears every override this plugin stored in settings.yaml — recipients, transport, event switches and pacing all return to defaults.',
      'danger.keep': 'Stored authorization codes and API keys are not affected.',
      'danger.ok': 'Reset',
      'danger.cancel': 'Cancel',
    };

    /**
     * 插值：把 `{name}` 换成 params[name]。缺值时保留原样，便于发现漏传。
     * @param {string} text 模板
     * @param {object} [params] 变量
     * @returns {string} 结果
     */
    function fmt(text, params) {
      if (params === undefined || params === null) return text;
      return text.replace(/\{(\w+)\}/g, (all, key) => (key in params ? String(params[key]) : all));
    }

    /** 远程持有者：apply 里填，页面与 callRemote 都读它。 */
    const remotesRef = { current: null };

    /** i18n 持有者：locale 服务迟到时先回退到中文，页面照常可用。 */
    const i18n = {
      locale: null,
      /** @param {string} key 文案键 @param {object} [params] 变量 @returns {string} 当前语言文案 */
      t(key, params) {
        const dict = this.locale === null ? ZH : (this.locale.getSnapshot?.().id === 'en' ? EN : ZH);
        return fmt(dict[key] ?? ZH[key] ?? key, params);
      },
    };

    // ---------------------------------------------------------------------------
    // 纯函数（无 React 依赖，便于单测）
    // ---------------------------------------------------------------------------

    /** 常见邮箱的 SMTP 预设，与 Host 侧 lib/config.js 的 SMTP_PRESETS 对齐。 */
    const PRESETS = [
      { id: 'qq', name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: 'tls', suffix: '@qq.com', domains: ['qq.com', 'foxmail.com', 'vip.qq.com'] },
      { id: '163', name: '163 邮箱', host: 'smtp.163.com', port: 465, secure: 'tls', suffix: '@163.com', domains: ['163.com', '188.com', 'yeah.net'] },
      { id: '126', name: '126 邮箱', host: 'smtp.126.com', port: 465, secure: 'tls', suffix: '@126.com', domains: ['126.com'] },
      { id: 'gmail', name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: 'tls', suffix: '@gmail.com', domains: ['gmail.com', 'googlemail.com'] },
      { id: 'outlook', name: 'Outlook', host: 'smtp.office365.com', port: 587, secure: 'starttls', suffix: '@outlook.com', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'] },
      { id: 'icloud', name: 'iCloud', host: 'smtp.mail.me.com', port: 587, secure: 'starttls', suffix: '@icloud.com', domains: ['icloud.com', 'me.com', 'mac.com'] },
    ];

    /**
     * 解析收件人：一行一个（兼容逗号/分号），去空、去重、丢弃明显不含 @ 的项。
     * 规则必须与 Host 侧 lib/config.js 的 parseRecipients 保持一致。
     * @param {unknown} raw 用户填写的原始文本
     * @returns {{ valid: string[], invalid: string[] }}
     */
    function parseRecipients(raw) {
      const valid = [];
      const invalid = [];
      const seen = new Set();
      if (typeof raw !== 'string' || raw.trim() === '') return { valid, invalid };
      for (const chunk of raw.split(/[\n,;]+/)) {
        const addr = chunk.trim();
        if (addr === '') continue;
        const key = addr.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) invalid.push(addr);
        else valid.push(addr);
      }
      return { valid, invalid };
    }

    /**
     * 把投递失败的原因翻译成「该动哪里」。
     *
     * 页面只负责分类与建议，**不改写原文**：原始报错始终留在旁边（改不了才是真麻烦）。
     * 规则来自真实踩过的两类错误：认证类（535/534/530）与发件人被拒（550）。
     * @param {unknown} raw 原始报错
     * @returns {{kind: string, label: string, hint: string}} 分类结果
     */
    function classifySendError(raw) {
      const text = String(raw ?? '');
      const code = /(?:^|\D)([45]\d{2})(?:\D|$)/.exec(text)?.[1] ?? '';
      if (/535|534|530/.test(text) || /auth/i.test(text)) {
        return { kind: 'auth', label: i18n.t('err.auth'), hint: i18n.t('err.authHint') };
      }
      if (/^5\d{2}/.test(text) || /From.*(?:missing|invalid)|header/i.test(text)) {
        return { kind: 'from', label: i18n.t('err.rejected'), hint: i18n.t('err.rejectedHint') };
      }
      if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|timeout|socket/i.test(text)) {
        return { kind: 'network', label: i18n.t('err.network'), hint: i18n.t('err.networkHint') };
      }
      return {
        kind: 'other',
        label: code === '' ? i18n.t('err.other') : i18n.t('err.otherCode', { code }),
        hint: i18n.t('err.otherHint'),
      };
    }

    /**
     * 「多久以前」的人话。只给投递结果用，所以粒度到分钟就够。
     * @param {unknown} at 时间戳（毫秒）
     * @param {number} now 当前时间戳
     * @returns {string} 如「刚刚」「3 分钟前」
     */
    function relativeTime(at, now) {
      const stamp = typeof at === 'number' && Number.isFinite(at) ? at : null;
      if (stamp === null) return '';
      const seconds = Math.max(0, Math.round((now - stamp) / 1000));
      if (seconds < 10) return i18n.t('time.justNow');
      if (seconds < 60) return i18n.t('time.secondsAgo', { n: seconds });
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return i18n.t('time.minutesAgo', { n: minutes });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return i18n.t('time.hoursAgo', { n: hours });
      return i18n.t('time.daysAgo', { n: Math.round(hours / 24) });
    }

    /**
     * 按主机名匹配预设。
     * @param {unknown} host SMTP 主机
     * @returns {object|null} 命中的预设
     */
    function matchPreset(host) {
      const value = String(host ?? '').trim().toLowerCase();
      if (value === '') return null;
      return PRESETS.find((preset) => preset.host === value) ?? null;
    }

    /**
     * 由邮箱地址猜预设（用于刚填完收件人就想一键配好的情形）。
     * @param {unknown} address 邮箱地址
     * @returns {object|null} 命中的预设
     */
    function presetForAddress(address) {
      const value = String(address ?? '').trim().toLowerCase();
      const at = value.lastIndexOf('@');
      if (at === -1) return null;
      const domain = value.slice(at + 1);
      return PRESETS.find((preset) => preset.suffix === `@${domain}`) ?? null;
    }

    /**
     * 账号域名是否不属于这个服务商。
     *
     * 用 QQ 的服务器配 outlook 的账号，认证必然 535；这个错误在点发送前就看得出来。
     * @param {object|null} preset 命中的预设
     * @param {unknown} user SMTP 用户名
     * @returns {boolean} true 表示对不上
     */
    function accountMismatch(preset, user) {
      if (preset === null || !Array.isArray(preset.domains)) return false;
      const value = String(user ?? '').trim().toLowerCase();
      const at = value.lastIndexOf('@');
      if (at === -1) return false;
      return !preset.domains.includes(value.slice(at + 1));
    }

    /**
     * 由收件人推断 SMTP 用户名：只有域名与服务商一致时才填。
     *
     * 预设里那个 `@qq.com` 后缀是"填入他该补什么"的提示，不能当成用户名写进配置——
     * 写进去就是个缺了名字的半成品，用户还得回来改。
     * @param {object} preset 命中的预设
     * @param {string[]} validRecipients 已通过校验的收件人
     * @returns {string} 可直接使用的用户名；推不出来时返回空串
     */
    function userForPreset(preset, validRecipients) {
      if (!preset) return '';
      const hit = (validRecipients ?? []).find((address) => String(address).toLowerCase().endsWith(preset.suffix));
      return hit === undefined ? '' : hit;
    }

    /** 状态条的取值顺序：先看能不能发，再看有没有真的发出去过。 */
    const STATUS_TONE = {
      disabled: 'idle',
      needRecipients: 'warning',
      needHost: 'warning',
      needUser: 'warning',
      needCredential: 'warning',
      simulated: 'warning',
      lastFailed: 'error',
      ready: 'done',
    };

    /**
     * 推导状态条要显示哪个结论。纯函数，输入全部来自草稿与凭据状态。
     * SMTP 的必填项是「主机 + 用户名 + 凭据」，缺哪个就报哪个——只报主机会让用户
     * 填完主机才发现还是发不出去。
     * @param {object} input 判定输入
     * @returns {string} 状态键
     */
    function deriveStatus(input) {
      const { enabled, transport, recipientCount, host, user, credentialConfigured, lastDelivery } = input ?? {};
      if (enabled !== true) return 'disabled';
      if (!(recipientCount > 0)) return 'needRecipients';
      if (transport === 'log' || transport === undefined || transport === null) return 'simulated';
      if (transport === 'smtp') {
        if (String(host ?? '').trim() === '') return 'needHost';
        if (String(user ?? '').trim() === '') return 'needUser';
      }
      if (credentialConfigured !== true) return 'needCredential';
      if (lastDelivery && lastDelivery.ok === false) return 'lastFailed';
      return 'ready';
    }

    /**
     * 某一组的状态点。optional 组只区分「已自定义 / 走默认」。
     * @param {boolean} done 是否已配置好
     * @param {boolean} [notApplicable] 是否不适用
     * @returns {'done'|'warning'|'idle'} 状态点状态
     */
    function dotState(done, notApplicable) {
      if (notApplicable === true) return 'idle';
      return done === true ? 'done' : 'warning';
    }

    // ---------------------------------------------------------------------------
    // 样式
    //
    // 这一层上一版是坏的，根因写在这里，别再犯：
    //
    //   宿主把 --dsw-alias-* 定义在 **body** 上，不是 :root。而自定义属性里的 var()
    //   是在**声明它的那个元素**上求值的——所以以前那句
    //       :root{--dshmn-surface:var(--dsw-alias-bg-layer-1)}
    //   在 html 上求值时找不到 --dsw-alias-bg-layer-1，整条链变成空值。后果是：
    //   结论卡背景 transparent（浅色下页面本来就是白的 → "唯一的高亮块"根本不存在）、
    //   发丝线回退到 currentColor（用近黑文字色画分隔线）、输入框没有描边。
    //   实测证据见 ../.verify/probe-vars.mjs 与 《dsh-notify-p-设置页视觉重构.md》。
    //
    //   所以：**不要再套 var() 别名，规则里直接引用 --dsw-alias-***。token 在 body 上，
    //   面板是它的后代，直接引用按继承链正常求值，暗色自动跟着走。
    //
    // 量度（全部照抄宿主自己的设置页，别自己发明）：
    //   内容列 ≈ 564px · 段标题 14/22·500 · 行标题 14/22 · 字段标签 12/18·500
    //   说明 12/18 tertiary · 行间 .5px border-l2 · 段头下 .5px border-l3
    //   填充面 = bg-module-platform（宿主"编辑器/选中态"用的就是这个）
    //
    // 纪律：全页零硬编码颜色（单测里有审计）。**全页只有一个填充面 —— 判决条。**
    // ---------------------------------------------------------------------------

    /** 一眼看出浏览器加载的是哪一版。放在根节点的 data-build 上，检查 DOM 可见，不占视觉。 */
    const BUILD = 'ui11';

    const CSS = `
/* dsh-notify-p · 设置页样式（量度对齐宿主 settings 页；全页零硬编码颜色） */
.dshmn-page{display:flex;flex-direction:column;min-width:0;max-width:100%;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dshmn-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}

/* 页头：一句用途 + 落盘读数（读数只报事实，不报"操作成功"） */
.dshmn-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:0 0 14px;min-width:0}
.dshmn-lead{margin:0;min-width:0;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.dshmn-stamp{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshmn-stamp[data-tone=busy]{color:var(--dsw-alias-label-secondary)}
.dshmn-stamp[data-tone=error]{color:var(--dsw-alias-state-error-primary)}

/* ── 判决条：全页唯一的填充面 ────────────────────────────────────────────── */
.dshmn-verdict{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:12px;min-width:0;
  background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3)}
.dshmn-verdictHead{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.dshmn-verdictTitle{margin:0;min-width:0;color:var(--dsw-alias-label-primary);font-size:16px;line-height:24px;font-weight:500}
.dshmn-verdictWhy{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.dshmn-verdictFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:2px}
.dshmn-evidence{display:flex;flex-direction:column;gap:2px;margin-top:2px;padding-top:10px;min-width:0;
  border-top:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshmn-evidenceKey{color:var(--dsw-alias-label-tertiary)}
.dshmn-evidence[data-ok=false] .dshmn-evidenceKey{color:var(--dsw-alias-state-error-primary)}
.dshmn-evidence .dshmn-mono{color:var(--dsw-alias-label-secondary);word-break:break-all}

/* ── 分组：段头 + 发丝线。不做卡片、不编号 ──────────────────────────────── */
.dshmn-group{display:flex;flex-direction:column;margin-top:24px;min-width:0}
.dshmn-groupHead{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding-bottom:6px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.dshmn-groupTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;font-weight:500}
.dshmn-groupState{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:22px;font-variant-numeric:tabular-nums}
.dshmn-groupBody{display:flex;flex-direction:column;min-width:0}

/* ── 条目：分隔线长在条目上，这样"父行 + 缩进子行"之间只画一条线 ─────────── */
.dshmn-item{display:flex;flex-direction:column;gap:8px;padding:12px 0;min-width:0;
  border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshmn-item:last-child{padding-bottom:0;border-bottom:none}
.dshmn-itemHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;min-width:0}
.dshmn-itemText{display:flex;flex-direction:column;gap:4px;flex:1 1 auto;min-width:0}
.dshmn-itemTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dshmn-itemCtrl{flex:none;display:flex;align-items:center;gap:8px;min-height:22px}
/* 缩进子行：把"它只对上面那一项生效"画成结构，而不是再写一句说明 */
.dshmn-sub{display:flex;flex-direction:column;gap:8px;margin-left:3px;padding-left:12px;min-width:0;
  border-left:.5px solid var(--dsw-alias-border-l2)}
.dshmn-sub[data-muted=true]{opacity:.5}

/* ── 字段：标签在上、控件满宽（宿主 settings-models 的 fieldLabel 同款） ── */
.dshmn-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshmn-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:500}
.dshmn-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;max-width:44em}
.dshmn-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;word-break:break-word}
.dshmn-credState{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshmn-credState[data-ok=true]{color:var(--dsw-alias-state-success-primary)}
.dshmn-linkRow{display:flex;align-items:center;gap:12px;flex-wrap:wrap}

/* ── 输入 ──────────────────────────────────────────────────────────────── */
/* 宿主的 Input 原语是 content-box 的 inline-flex（padding 0 8px + .5px 描边）,
   所以光给 width:100% 会让它比父级宽出 18px、顶出内容列。必须一起给 border-box。 */
.dshmn-inputWrap{box-sizing:border-box;display:flex;width:100%;min-width:0}
.dshmn-inputWrap>*{box-sizing:border-box;width:100%;min-width:0}
.dshmn-textarea{box-sizing:border-box;width:100%;min-height:64px;padding:8px 10px;resize:vertical;outline:none;
  border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px}
.dshmn-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshmn-select{box-sizing:border-box;width:100%;height:36px;padding:0 10px;outline:none;
  border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:14px}
.dshmn-textarea:focus-visible,.dshmn-select:focus-visible{border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}
.dshmn-textarea[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}

/* SMTP 三个短字段排一行；窄屏折成一列——别竖着排三个满宽输入。 */
.dshmn-grid{display:grid;grid-template-columns:minmax(0,1fr) 88px 104px;gap:10px;align-items:start;min-width:0}
.dshmn-num{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dshmn-numBox{width:78px;min-width:0}
.dshmn-numBox>*,.dshmn-numBox input{box-sizing:border-box;width:100%;min-width:0}
.dshmn-unit{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}

/* ── 单选：宿主"外观"三张卡的形态 —— 未选=白底+发丝线，选中=module 面 ──── */
.dshmn-seg{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshmn-segBtn{box-sizing:border-box;height:32px;padding:0 14px;cursor:pointer;font:inherit;font-size:13px;line-height:20px;
  border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary)}
.dshmn-segBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshmn-segBtn[data-active=true]{background:var(--dsw-alias-bg-module-platform);border-color:var(--dsw-alias-border-l3);
  color:var(--dsw-alias-label-primary);font-weight:500}
.dshmn-segBtn:focus-visible,.dshmn-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

/* ── 文字按钮 ──────────────────────────────────────────────────────────── */
.dshmn-link{color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;
  padding:0;border:none;background:none;text-decoration:underline;text-underline-offset:3px;
  text-decoration-color:var(--dsw-alias-border-l4)}
.dshmn-link:hover{color:var(--dsw-alias-label-primary)}
.dshmn-link:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;text-decoration:none}

/* ── 折叠区与页脚 ──────────────────────────────────────────────────────── */
.dshmn-disclose{margin-top:0}
.dshmn-discloseBody{display:flex;flex-direction:column;gap:4px;padding-top:10px;min-width:0}
/* 展开后的内容：缩进 + 一道左竖线，跟 SMTP 子块同一套语言——
   折叠区打开后必须一眼看出"这些东西属于上面那一行"，而不是又一组平铺的设置。 */
.dshmn-stack{display:flex;flex-direction:column;gap:14px;min-width:0;margin-top:10px;
  padding-left:12px;border-left:1px solid var(--dsw-alias-border-l2)}
/* 内容自带行节奏时（Row 自己有内边距和发丝线）只保留缩进，别再叠一层间距 */
.dshmn-stack[data-rows=true]{gap:0}
.dshmn-foot{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin-top:24px;
  padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l3)}
.dshmn-helpBody{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:21px}

/* ── 窄屏：宿主 settings 页的断点就是 560px ─────────────────────────────── */
@media (max-width:560px){
  .dshmn-head{flex-direction:column;gap:4px}
  .dshmn-verdictFoot{justify-content:flex-start}
  .dshmn-grid{grid-template-columns:minmax(0,1fr)}
  .dshmn-numBox{width:auto;flex:1 1 auto}
}
`;


    if (typeof document !== 'undefined'
      && document.querySelector('style[data-plugin-css="dsh-notify-p"]') === null) {
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-notify-p';
      style.dataset.pluginCss = 'dsh-notify-p';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ---------------------------------------------------------------------------
    // 原语封装（原语缺失时降级，不白屏）
    // ---------------------------------------------------------------------------

    /** 开关。原语缺失时用原生 checkbox 顶上。 */
    function Switch(props) {
      if (typeof P.Switch === 'function') return h(P.Switch, props);
      return h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled === true,
        'aria-label': props.label,
        onChange: () => props.onChange(props.checked !== true),
      });
    }

    /**
     * 状态点。**全页只有判决条用得上**——状态色只出现在一处，别的都退成文字。
     * 原语支持 done / warning / error / idle 四档，正好对上"会发信 / 不会真发 / 发失败 / 还没配完"。
     * @param {object} props state 与额外 className
     * @returns {object} React 元素
     */
    function Dot({ state, className }) {
      if (typeof P.StateDot === 'function') return h(P.StateDot, { state, size: 8, className });
      return h('span', { className: 'dshmn-hint', 'aria-hidden': 'true' }, state === 'done' ? '●' : '○');
    }

    /** 成功勾。只在"凭据确实存进去了"这一处出现，不做成到处都有的装饰点。 */
    function CheckedMark() {
      if (typeof P.IconCheckOutline16 === 'function') return h(P.IconCheckOutline16, null);
      return h('span', { 'aria-hidden': 'true' }, '✓');
    }

    /** 按钮。 */
    function Button(props) {
      if (typeof P.Button === 'function') return h(P.Button, props);
      return h('button', { type: 'button', className: 'dshmn-link', onClick: props.onClick, disabled: props.disabled }, props.children);
    }

    /** 输入框（宿主原语自带 0.5px 发丝描边与 focus-within 主题色）。 */
    function TextInput(props) {
      const { className, ...rest } = props;
      if (typeof P.Input === 'function') {
        return h(P.Input, { ...rest, className: `dshmn-inputWrap${className === undefined ? '' : ` ${className}`}` });
      }
      return h('input', { ...rest, className: 'dshmn-textarea', style: { minHeight: 0, height: 32 } });
    }

    /**
     * 通道切换的一格。
     *
     * 用真 `<button>` + 单选语义（`role=radio`），不是宿主的 `Pill`：Pill 渲染成 `span`，
     * 没有原生键盘行为，"当前选中了哪个"也传不给读屏。形态仍然照抄宿主的"外观"选项卡。
     * @param {object} props 参数
     * @returns {object} React 元素
     */
    function Segment(props) {
      const { active, onClick, children } = props;
      return h('button', {
        type: 'button',
        className: 'dshmn-segBtn',
        'data-active': active === true ? 'true' : 'false',
        role: 'radio',
        'aria-checked': active === true,
        onClick,
      }, children);
    }

    /**
     * 折叠区。优先用宿主原语，取不到再退化为本地实现。
     * @param {object} props 折叠参数
     * @returns {object} React 元素
     */
    function Disclosure(props) {
      const { title, open, onToggle, children } = props;
      if (typeof P.DisclosureRow === 'function') {
        return h('div', { className: 'dshmn-disclose' }, h(P.DisclosureRow, {
          title,
          open: open === true,
          expandable: true,
          expandOnRowClick: true,
          onToggle,
        }, children));
      }
      const head = h('button', {
        type: 'button',
        className: 'dshmn-link',
        'aria-expanded': open === true,
        onClick: onToggle,
      }, `${open === true ? '▾' : '▸'} ${title}`);
      const body = open === true ? h('div', { className: 'dshmn-discloseBody' }, children) : null;
      return h('div', { className: 'dshmn-disclose' }, head, body);
    }

    // ---------------------------------------------------------------------------
    // 页面
    // ---------------------------------------------------------------------------

    /**
     * 一个分组：段头（名字 + 这一段的结论）+ 一条发丝线，内容靠行与行之间的分隔线组织。
     *
     * **不编号、不套卡片。** 以前是 `1 收件人 / 2 怎么发 / 3 什么时候发给我` 三张同款灰卡，
     * 编号把并列的三个设置组伪装成步骤序列（内容并不是步骤），三块同款灰又让主次消失。
     * @param {object} props 分组参数
     * @returns {object} React 元素
     */
    function Group(props) {
      const { title, state, children } = props;
      return h('section', { className: 'dshmn-group', 'aria-label': title },
        h('div', { className: 'dshmn-groupHead' },
          h('h3', { className: 'dshmn-groupTitle' }, title),
          state === undefined ? null : h('span', { className: 'dshmn-groupState' }, state)),
        h('div', { className: 'dshmn-groupBody' }, children));
    }

    /**
     * 一行：标题 + 说明在左，控件在右。
     * @param {object} props 行参数
     * @returns {object} React 元素
     */
    function Row(props) {
      const { title, hint, control, htmlFor, children } = props;
      return h('div', { className: 'dshmn-item' },
        h('div', { className: 'dshmn-itemHead' },
          h('div', { className: 'dshmn-itemText' },
            htmlFor === undefined
              ? h('div', { className: 'dshmn-itemTitle' }, title)
              : h('label', { className: 'dshmn-itemTitle', htmlFor }, title),
            hint === undefined ? null : h('div', { className: 'dshmn-hint' }, hint)),
          control === undefined ? null : h('div', { className: 'dshmn-itemCtrl' }, control)),
        children);
    }

    /**
     * 缩进子行：表达"这一项只对上面那一项生效"，而不是再补一句说明。
     * 父项关掉时整块压暗，但仍然可见——它没被删掉，只是暂时不参与。
     * @param {object} props 子行参数
     * @returns {object} React 元素
     */
    function Sub(props) {
      const { title, hint, control, muted } = props;
      return h('div', { className: 'dshmn-sub', 'data-muted': muted === true ? 'true' : 'false' },
        h('div', { className: 'dshmn-itemHead' },
          h('div', { className: 'dshmn-itemText' },
            h('div', { className: 'dshmn-itemTitle' }, title),
            hint === undefined ? null : h('div', { className: 'dshmn-hint' }, hint)),
          control === undefined ? null : h('div', { className: 'dshmn-itemCtrl' }, control)));
    }

    /** 带单位后缀的数字输入（贴在一行里，所以宽度定死；单位常驻可见）。 */
    function NumberField({ id, value, unit, onChange, onBlur, placeholder, label }) {
      return h('span', { className: 'dshmn-num' },
        h('span', { className: 'dshmn-numBox' },
          h(TextInput, {
            id,
            type: 'number',
            inputMode: 'numeric',
            value: value ?? '',
            placeholder,
            'aria-label': label,
            onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value)),
            onBlur,
          })),
        h('span', { className: 'dshmn-unit' }, unit));
    }

    /**
     * 设置页组件。
     * @param {object} props settings.section 传入的 props，外加 remotes / i18n 持有者
     * @returns {object} React 元素
     */
    function MailNotifyPage(props) {
      const { remotes } = props;
      const t = (key, params) => i18n.t(key, params);

      const [ready, setReady] = React.useState(remotes.current !== null);
      const [attempt, setAttempt] = React.useState(0);
      const [draft, setDraft] = React.useState({});
      const [save, setSave] = React.useState({ phase: 'idle', at: 0, error: '' });
      const [now, setNow] = React.useState(() => Date.now());
      const [credentialState, setCredentialState] = React.useState({});
      const [credError, setCredError] = React.useState('');
      const [credCheck, setCredCheck] = React.useState(0);
      const [pwDraft, setPwDraft] = React.useState({});
      const [pwClear, setPwClear] = React.useState({});
      const [resetting, setResetting] = React.useState(false);
      const [confirmReset, setConfirmReset] = React.useState(false);
      const [helpKind, setHelpKind] = React.useState(null);
      const [test, setTest] = React.useState({ phase: 'idle', transport: '', ms: 0, error: '' });
      const [lastDelivery, setLastDelivery] = React.useState(null);
      const [capability, setCapability] = React.useState('unknown');
      const [showMoreOutcomes, setShowMoreOutcomes] = React.useState(false);
      const [showSender, setShowSender] = React.useState(false);
      const [showAdvanced, setShowAdvanced] = React.useState(false);
      const [customHost, setCustomHost] = React.useState(false);

      const draftRef = React.useRef({});
      const baselineRef = React.useRef({});
      const viewRef = React.useRef(null);
      const timers = React.useRef({});
      const pwTimers = React.useRef({});
      // 语言切换时强制重渲染（locale 服务只在变化时通知，不驱动 React）
      const [, setLocaleRev] = React.useState(0);

      React.useEffect(() => {
        const locale = i18n.locale;
        if (locale === null || typeof locale.subscribe !== 'function') return undefined;
        return locale.subscribe(() => setLocaleRev((n) => n + 1));
      }, []);

      // 远程命名空间迟到：最多轮询 40 次（约 6 秒）
      React.useEffect(() => {
        if (ready || attempt >= 40) return undefined;
        const timer = setTimeout(() => {
          if (remotes.current !== null) setReady(true);
          setAttempt((n) => n + 1);
        }, 150);
        return () => clearTimeout(timer);
      }, [ready, attempt, remotes]);

      const load = React.useCallback(async () => {
        const bridge = remotes.current;
        if (bridge === null) return;
        try {
          const described = unwrap(await bridge.settings.describe());
          const namespaces = Array.isArray(described?.namespaces) ? described.namespaces : [];
          const found = namespaces.find((item) => item && item.ns === NS) ?? null;
          viewRef.current = found;
          const value = found && found.value && typeof found.value === 'object' ? { ...found.value } : {};
          draftRef.current = value;
          baselineRef.current = value;
          setDraft(value);
          setSave(found === null
            ? { phase: 'error', at: 0, error: t('status.notServed') }
            : { phase: 'idle', at: 0, error: '' });
        } catch (err) {
          setSave({ phase: 'error', at: 0, error: String(err?.message ?? err) });
        }
      }, [remotes]);

      const refreshCredentials = React.useCallback(async (refs) => {
        const bridge = remotes.current;
        const list = [...new Set((refs ?? []).filter((ref) => typeof ref === 'string' && ref.trim() !== ''))];
        if (bridge === null || list.length === 0) {
          setCredentialState({});
          setCredError('');
          return;
        }
        try {
          const info = unwrap(await bridge.credentials.describe(list));
          const next = {};
          for (const ref of list) next[ref] = info?.[ref]?.configured === true;
          setCredentialState(next);
          setCredError('');
          setCredCheck((n) => n + 1);
        } catch (err) {
          // 读失败要显形：静默吞掉会让页面永远停在「未配置」，而用户其实已经存好了。
          setCredError(String(err?.message ?? err));
          console.warn('[dsh-notify-p] 读取凭据状态失败 / credential describe failed:', err);
        }
      }, [remotes]);

      /** 最近一次投递结果 + Host 能力探测。 */
      const refreshDelivery = React.useCallback(async () => {
        // 顺带探一次能力：typert 清单是**服务器启动时**扫描注册的，
        // 所以"connection 在"不等于"mailNotify 端点在"。探不到就老实说不可用，
        // 而不是给一个点下去必然报错的按钮。
        if (remotes.current?.rpc === undefined) {
          setCapability('missing');
          return;
        }
        try {
          const state = unwrap(await callRemote('state'));
          setCapability('ready');
          setLastDelivery(state?.recent?.[0] ?? null);
        } catch (err) {
          setCapability('missing');
          console.warn('[dsh-notify-p] Host 未提供 mailNotify 端点（重启 DSH 后生效）/ endpoint unavailable:', err);
        }
      }, [remotes]);

      // 首次就绪后装载
      React.useEffect(() => {
        if (ready && viewRef.current === null) void load();
      }, [ready, load, attempt]);

      // `viewRef.current` 是 load() 里赋的**引用**，赋值不会触发重渲染。
      // 所以依赖数组里写 viewRef.current 是无效的：首次挂载时它还是 null，
      // load() 完成后依赖没变，这个 effect 永远不会再跑一遍 —— 结果就是
      // 凭据永远是「还没保存」、投递账本永远读不到、测试按钮永远不出现。
      // 在渲染期把它取成一个普通值参与依赖，false→true 那一次就会把下面几条读都带起来。
      const loaded = viewRef.current !== null;

      React.useEffect(() => {
        if (ready && loaded) {
          void refreshCredentials([
            viewRef.current?.value?.smtpPasswordRef,
            viewRef.current?.value?.resendApiKeyRef,
          ]);
          void refreshDelivery();
        }
      }, [ready, loaded, refreshCredentials, refreshDelivery, attempt]);

      // 「已保存 · N 秒前」需要一个会走的钟；只在保存过之后跑，离开保存态就停
      React.useEffect(() => {
        if (save.phase !== 'saved') return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [save.phase, save.at]);

      // 凭据是**另一次远程读取**，可能在「保存成功」之后才落地；读失败时也会停在未配置。
      // 所以只要还有没被确认的引用名，就自动复检几次（3 秒后放弃，转由左下角的「重新检查」兜底）。
      React.useEffect(() => {
        if (ready !== true || !loaded || credCheck >= 3) return undefined;
        const refs = [draftRef.current?.smtpPasswordRef, draftRef.current?.resendApiKeyRef];
        const missing = refs.some((ref) => typeof ref === 'string' && ref.trim() !== ''
          && credentialState[ref] !== true);
        if (!missing) return undefined;
        const timer = setTimeout(() => { void refreshCredentials(refs); }, 1200);
        return () => clearTimeout(timer);
      }, [ready, loaded, credCheck, credentialState, refreshCredentials]);

      // 回到这一页就重新读一次凭据：用户可能在别的标签页 / 别的入口存过授权码。
      React.useEffect(() => {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
        const recheck = () => {
          if (viewRef.current === null) return;
          if (typeof document.visibilityState === 'string' && document.visibilityState === 'hidden') return;
          void refreshCredentials([
            draftRef.current?.smtpPasswordRef,
            draftRef.current?.resendApiKeyRef,
          ]);
        };
        window.addEventListener('focus', recheck);
        document.addEventListener('visibilitychange', recheck);
        return () => {
          window.removeEventListener('focus', recheck);
          document.removeEventListener('visibilitychange', recheck);
        };
      }, [refreshCredentials]);

      /**
       * 把若干字段写回 Host（即时生效的核心）。
       * @param {string[]} keys 要提交的字段名
       * @returns {Promise<void>}
       */
      const commit = React.useCallback(async (keys) => {
        const bridge = remotes.current;
        const view = viewRef.current;
        if (bridge === null || view === null) return;
        const base = baselineRef.current ?? {};
        const ops = [];
        for (const key of keys) {
          const value = draftRef.current[key];
          if (value === base[key]) continue;
          if (value === '' || value === null || value === undefined) ops.push({ op: 'unset', path: [key] });
          else ops.push({ op: 'set', path: [key], value });
        }
        if (ops.length === 0) return;
        setSave({ phase: 'saving', at: 0, error: '' });
        try {
          const next = unwrap(await bridge.settings.mutate(NS, ops, view.revision));
          if (next && typeof next === 'object') {
            viewRef.current = next;
            baselineRef.current = next.value && typeof next.value === 'object' ? { ...next.value } : {};
          }
          setSave({ phase: 'saved', at: Date.now(), error: '' });
        } catch (err) {
          setSave({ phase: 'error', at: 0, error: String(err?.message ?? err) });
          // 冲突或失败都重读一次，避免本地草稿与 Host 漂移
          await load();
        }
      }, [remotes, load]);

      /**
       * 改一个字段。
       * @param {string} key 字段名
       * @param {unknown} value 新值
       * @param {{ immediate?: boolean, delay?: number }} [opts] 提交策略
       * @returns {void}
       */
      const setField = React.useCallback((key, value, opts = {}) => {
        draftRef.current = { ...draftRef.current, [key]: value };
        setDraft(draftRef.current);
        clearTimeout(timers.current[key]);
        if (opts.immediate === true) {
          void commit([key]);
          return;
        }
        timers.current[key] = setTimeout(() => void commit([key]), opts.delay ?? TEXT_DEBOUNCE_MS);
      }, [commit]);

      /** 立刻提交某字段（失焦兜底）。 */
      const flush = React.useCallback((key) => {
        clearTimeout(timers.current[key]);
        void commit([key]);
      }, [commit]);

      /**
       * 一次改多个字段并**合成一次提交**。
       *
       * 必须批量：`commit` 带的是同一个 revision，连续发多个即时写入会互相冲突，
       * 后发的会被 Host 拒绝并被随后的 load() 回滚——表面看就是"预设填了一半"。
       * @param {object} patch 字段名到新值的映射
       * @returns {void}
       */
      const setFields = React.useCallback((patch) => {
        draftRef.current = { ...draftRef.current, ...patch };
        setDraft(draftRef.current);
        for (const key of Object.keys(patch)) clearTimeout(timers.current[key]);
        void commit(Object.keys(patch));
      }, [commit]);

      /**
       * 写凭据。**目标引用名由调用方给定**（硬约束 4），绝不从草稿里猜。
       * @param {string} ref 凭据引用名
       * @returns {Promise<void>}
       */
      const commitCredential = React.useCallback(async (ref) => {
        const bridge = remotes.current;
        const view = viewRef.current;
        if (bridge === null || view === null) return;
        const name = String(ref ?? '').trim();
        if (name === '') return;
        const value = pwDraft[name] ?? '';
        const clearing = pwClear[name] === true;
        if (!clearing && value === '') return;
        setSave({ phase: 'saving', at: 0, error: '' });
        try {
          if (clearing) unwrap(await bridge.credentials.unset(name));
          else unwrap(await bridge.credentials.set(name, value));
          setPwDraft((prev) => ({ ...prev, [name]: '' }));
          setPwClear((prev) => ({ ...prev, [name]: false }));
          setSave({ phase: 'saved', at: Date.now(), error: '' });
          await refreshCredentials([name, draftRef.current?.smtpPasswordRef, draftRef.current?.resendApiKeyRef]);
        } catch (err) {
          setSave({ phase: 'error', at: 0, error: String(err?.message ?? err) });
        }
      }, [remotes, pwDraft, pwClear, refreshCredentials]);

      /** 恢复默认：清掉本命名空间在 settings.yaml 里的全部覆盖。 */
      const resetAll = React.useCallback(async () => {
        const bridge = remotes.current;
        const view = viewRef.current;
        if (bridge === null || view === null) return;
        setResetting(true);
        setSave({ phase: 'saving', at: 0, error: '' });
        try {
          const next = unwrap(await bridge.settings.replace(NS, {}, view.revision));
          if (next && typeof next === 'object') viewRef.current = next;
          await load();
          setSave({ phase: 'saved', at: Date.now(), error: '' });
        } catch (err) {
          setSave({ phase: 'error', at: 0, error: String(err?.message ?? err) });
          await load();
        } finally {
          setResetting(false);
          setConfirmReset(false);
        }
      }, [remotes, load]);

      /** 发一封测试邮件。Host 没提供该能力时不显示按钮。 */
      const sendTest = React.useCallback(async () => {
        if (capability !== 'ready') return;
        setTest({ phase: 'sending', transport: '', ms: 0, error: '' });
        try {
          const result = unwrap(await callRemote('test'));
          if (result && result.ok === false) {
            setTest({ phase: 'fail', transport: String(result.transport ?? ''), ms: 0, error: String(result.error ?? '') });
          } else {
            setTest({
              phase: 'ok',
              transport: String(result?.transport ?? ''),
              ms: Number(result?.ms ?? 0),
              error: '',
            });
          }
          setLastDelivery(result ?? null);
        } catch (err) {
          setTest({ phase: 'fail', transport: '', ms: 0, error: String(err?.message ?? err) });
        }
      }, [remotes, capability]);

      // 离开页面时把还在防抖里的改动落盘，避免"改完就走"丢改动
      React.useEffect(() => () => {
        for (const [key, timer] of Object.entries(timers.current)) {
          clearTimeout(timer);
          void commit([key]);
        }
      }, [commit]);

      // ---- 派生值 ----
      const transport = draft.transport ?? 'log';
      const recipients = parseRecipients(draft.recipients);
      const smtpPasswordRef = String(draft.smtpPasswordRef ?? '').trim();
      const resendKeyRef = String(draft.resendApiKeyRef ?? '').trim();
      const configured = (ref) => ref !== '' && credentialState[ref] === true;
      const activeRef = transport === 'resend' ? resendKeyRef : smtpPasswordRef;
      const statusKey = deriveStatus({
        enabled: draft.enabled === true,
        transport,
        recipientCount: recipients.valid.length,
        host: draft.smtpHost,
        user: draft.smtpUser,
        credentialConfigured: configured(activeRef),
        lastDelivery,
      });
      const transportLabel = transport === 'smtp' ? 'SMTP' : (transport === 'resend' ? 'Resend' : t('transport.log'));
      /** 通道这一段自己配好了没有——凭据行在下面很远，段头这一格是它唯一的上层读数。 */
      const transportReady = transport !== 'log' && configured(activeRef)
        && (transport !== 'smtp' || (String(draft.smtpHost ?? '').trim() !== '' && String(draft.smtpUser ?? '').trim() !== ''));
      const transportState = transport === 'log'
        ? t('transportState.log')
        : t(transportReady ? 'transportState.done' : 'transportState.todo');
      const STATUS_TITLE_KEY = {
        disabled: 'status.disabled',
        needRecipients: 'status.needRecipients',
        needHost: 'status.needHost',
        needUser: 'status.needUser',
        needCredential: 'status.needCredential',
        simulated: 'status.simulated',
        ready: 'status.ready',
        lastFailed: 'status.lastFailed',
      };
      /** 判决句：**全页最大的字号**，也是这一页真正要回答的那句话。 */
      const statusTitle = statusKey === 'needCredential'
        ? t('status.needCredential', { cred: transport === 'resend' ? t('cred.resend') : t('cred.smtp') })
        : t(STATUS_TITLE_KEY[statusKey] ?? 'status.ready');
      /** 判决下面那句人话：为什么是这个判决、下一步该动哪里。只说用户的事。 */
      const statusWhy = viewRef.current === null ? t('status.notServed') : t(`status.why.${statusKey}`);
      const outcomesOn = ['notifyCompleted', 'notifyError', 'notifyBlocked', 'notifyApproval',
        'notifyAbortedByUser', 'notifyInterrupted', 'notifyMaxTokens']
        .filter((key) => draft[key] === true).length;
      const preset = matchPreset(draft.smtpHost);
      const suggested = presetForAddress(recipients.valid[0]);
      const testSupported = capability === 'ready';
      const sending = test.phase === 'sending';
      /** 判决条那一档：状态→色调的映射只此一份。 */
      const tone = STATUS_TONE[statusKey] ?? 'idle';

      /**
       * 最近一次投递。没有就返回 null（此时只说"还没试过"，不摆一行空的）。
       *
       * 它同时是页面的第一条排错线索：分类（认证被拒 / 发件人被拒 / 网络）给出"该动哪里"，
       * 原始报错原样附在后面——不改写才是真的可排错。
       */
      const deliveryView = lastDelivery === null ? null : (() => {
        const error = classifySendError(lastDelivery.error);
        return {
          ok: lastDelivery.ok === true,
          ago: relativeTime(lastDelivery.at, now),
          logged: transport === 'log',
          elapsed: Number(lastDelivery.ms ?? 0),
          raw: String(lastDelivery.error ?? ''),
          error,
        };
      })();

      /** 测试按钮文案：发的时候说在发；之前失败过就说重测。 */
      const testLabel = sending
        ? t('act.testing')
        : (test.phase === 'fail' || (lastDelivery !== null && lastDelivery.ok === false) ? t('act.retest') : t('act.test'));

      /**
       * 「发送测试邮件」——本页唯一的主行动。
       *
       * 刻意**不挑状态**：配置只填了一半时，"怎么验证"恰恰最需要出现。
       * 它的价值就是用结果告诉你还缺什么：缺授权码、535 认证失败、550 被拒，
       * 都会在同一次点击里变成一句能读的原因。
       * @param {object} [options] variant / size
       * @returns {object|null} React 元素
       */
      const testButton = (options) => {
        if (capability === 'unknown') return null;
        if (!testSupported) return h('span', { className: 'dshmn-hint' }, t('act.needsRestart'));
        // 凭据行里用文字链接：手刚离开输入框，验证就在原地，不用滚回页顶；
        // 但它不抢判决条的主按钮，所以只做链接。
        if (options?.variant === 'link') {
          return h('button', {
            type: 'button',
            className: 'dshmn-link',
            disabled: sending,
            title: t('act.testHint'),
            onClick: () => void sendTest(),
          }, testLabel);
        }
        return h(Button, {
          variant: options?.variant ?? 'outline',
          size: options?.size ?? 'sm',
          disabled: sending,
          // 悬停说明点了会发生什么：这是**真的**往外发一封信，不是预览
          title: t('act.testHint'),
          onClick: () => void sendTest(),
        }, testLabel);
      };

      /**
       * 判决条的动作 = **下一步该做的那一件事**（主按钮）+ 可选的一次验证。
       *
       * 旧版在「只记录」通道下既不给测试按钮、又顶着一句"还没测过"——一个没有出口的提示。
       * 现在只记录也给测试（它本来就会跑完整条链路，只是把邮件写进账本），
       * 主按钮仍然是"换成真通道"，因为那才是用户的目标。
       */
      const configAction = (() => {
        if (statusKey === 'disabled') {
          return h(Button, {
            variant: 'primary',
            size: 'sm',
            onClick: () => setField('enabled', true, { immediate: true }),
          }, t('act.enable'));
        }
        if (statusKey === 'simulated') {
          return h(Button, {
            variant: 'primary',
            size: 'sm',
            onClick: () => setFields(suggested === null
              ? { transport: 'smtp' }
              : {
                transport: 'smtp',
                smtpHost: suggested.host,
                smtpPort: suggested.port,
                smtpSecure: suggested.secure,
              }),
          }, t('act.chooseTransport'));
        }
        if (statusKey === 'ready' || statusKey === 'lastFailed') return testButton({ variant: 'primary' });
        return h(Button, {
          variant: 'primary',
          size: 'sm',
          onClick: () => focusMissing(),
        }, t('act.goFill'));
      })();
      /** 只记录 / 还没配完时，测试仍然给，但降为次级：它是验证，不是下一步。 */
      const secondaryTest = (statusKey === 'ready' || statusKey === 'lastFailed') ? null : testButton();

      /** 把用户送到缺的那一格，而不是让他自己在一屏里找。 */
      const focusMissing = () => {
        const target = statusKey === 'needRecipients' ? 'dshmn-recipients'
          : (statusKey === 'needHost' ? 'dshmn-smtp-host'
            : (statusKey === 'needUser' ? 'dshmn-smtp-user'
              : (transport === 'resend' ? 'dshmn-cred-resend' : 'dshmn-cred-smtp')));
        const element = typeof document === 'undefined' ? null : document.getElementById(target);
        if (element === null || element === undefined) return;
        element.scrollIntoView({ block: 'center' });
        element.focus();
      };

      /**
       * 判决条底部那条"读数"。
       *
       * 它是这一页唯一能回答"真发得出去吗"的东西，所以放在判决条里、用一条发丝线跟判决分开。
       * 失败时分类 + 原文都给：只给"发送失败"四个字等于没给线索。
       * @returns {object|null} React 元素
       */
      const evidence = () => {
        if (deliveryView === null) {
          return h('div', { className: 'dshmn-evidence' },
            h('span', { className: 'dshmn-evidenceKey' }, t('evidence.label')),
            h('span', null, t('evidence.never')));
        }
        const view = deliveryView;
        const detail = view.ok
          ? [h('span', { key: 'ok' }, view.logged
            ? t('evidence.okLogged', { ago: view.ago })
            : t('evidence.ok', { ms: view.elapsed, ago: view.ago }))]
          : [
            h('span', { key: 'reason' }, `${t('evidence.fail')}：${view.error.label}（${view.ago}）`),
            h('span', { key: 'hint', className: 'dshmn-hint' }, view.error.hint),
            h('span', { key: 'raw', className: 'dshmn-mono' }, view.raw),
          ];
        return h('div', { className: 'dshmn-evidence', 'data-ok': view.ok ? 'true' : 'false' },
          h('span', { className: 'dshmn-evidenceKey' }, t('evidence.label')),
          ...detail);
      };
      /**
       * 凭据行。保存前给输入框（这里才是要动手的地方）；保存后**不再摆一个空输入框**——
       * 那样只会让人怀疑"是不是没存上"。存好之后是：✓ 已保存 + 测试 + 更换 + 清除。
       * @param {string} fieldId 输入框 id
       * @param {string} labelKey 名称文案键
       * @param {string} ref 凭据引用名（写入目标由调用方给定，硬约束 4）
       * @param {string} hintKey 说明文案键
       * @param {string} helpKey 帮助按钮文案键
       * @returns {object} React 元素
       */
      const credentialField = (fieldId, labelKey, ref, hintKey, helpKey) => {
        const confirmed = configured(ref);
        const clear = pwClear[ref] === true;
        const editing = confirmed !== true || clear;
        const helpButton = h('button', {
          type: 'button',
          className: 'dshmn-link',
          onClick: () => setHelpKind(HELP_KIND[labelKey]),
        }, t(helpKey));
        return h('div', { className: 'dshmn-item' },
          h('div', { className: 'dshmn-itemHead' },
            h('label', { className: 'dshmn-label', htmlFor: fieldId }, t(labelKey)),
            h('span', { className: 'dshmn-credState', 'data-ok': confirmed ? 'true' : 'false' },
              confirmed ? h('span', { 'aria-hidden': 'true' }, h(CheckedMark, null)) : null,
              confirmed ? t('cred.saved') : t('cred.notSaved'))),
          editing
            ? h(TextInput, {
              id: fieldId,
              type: 'password',
              value: pwDraft[ref] ?? '',
              placeholder: t('cred.placeholder'),
              onChange: (event) => {
                const value = event.target.value;
                setPwDraft((prev) => ({ ...prev, [ref]: value }));
                setPwClear((prev) => ({ ...prev, [ref]: false }));
              },
              onBlur: () => void commitCredential(ref),
              onKeyDown: (event) => { if (event.key === 'Enter') void commitCredential(ref); },
            })
            : h('div', null,
              h(TextInput, {
                id: fieldId,
                type: 'password',
                value: '',
                readOnly: true,
                'aria-label': `${t(labelKey)}：${t('cred.saved')}`,
                placeholder: t('cred.saved'),
                onFocus: () => setPwClear((prev) => ({ ...prev, [ref]: true })),
              })),
          h('div', { className: 'dshmn-hint' }, t(hintKey)),
          save.phase === 'saving' ? h('div', { className: 'dshmn-hint' }, t('save.checkingCred')) : null,
          credError === ''
            ? null
            : h('div', { className: 'dshmn-error' },
              h('button', {
                type: 'button',
                className: 'dshmn-link',
                onClick: () => void refreshCredentials([ref]),
              }, `${t('save.credCheckFailed', { error: credError })}，${t('save.reload')}`)),
          h('div', { className: 'dshmn-linkRow' },
            confirmed
              ? h('button', {
                type: 'button',
                className: 'dshmn-link',
                onClick: () => setPwClear((prev) => ({ ...prev, [ref]: true })),
              }, t('cred.replace'))
              : null,
            confirmed
              ? h('button', {
                type: 'button',
                className: 'dshmn-link',
                onClick: () => {
                  setPwDraft((prev) => ({ ...prev, [ref]: '' }));
                  setPwClear((prev) => ({ ...prev, [ref]: true }));
                  void commitCredential(ref);
                },
              }, t('cred.clear'))
              : null,
            helpButton,
            testButton({ variant: 'link' })));
      };

      /** 分组头右侧那一格：只说这一段的结论，不摆装饰。 */
      const recipientsState = recipients.valid.length > 0
        ? t('recipients.ok', { n: recipients.valid.length })
        : t('recipients.none');

      return h('div', { className: 'dshmn-page', 'data-build': BUILD },

        // ---- 页头：这一页干什么 + 落盘读数（读数常驻，不自灭）----
        h('div', { className: 'dshmn-head' },
          h('p', { className: 'dshmn-lead' }, t('lead')),
          h('div', {
            className: 'dshmn-stamp',
            'data-tone': save.phase === 'error' ? 'error' : (save.phase === 'saving' ? 'busy' : 'idle'),
            'aria-live': 'polite',
          },
          save.phase === 'error'
            ? h(React.Fragment, null,
              t('save.error', { error: save.error }),
              h('button', { type: 'button', className: 'dshmn-link', onClick: () => void load() }, t('save.reload')))
            : (save.phase === 'saving'
              ? t('save.saving')
              : (save.phase === 'saved' && save.at > 0
                ? t('save.savedAgo', { n: Math.max(0, Math.round((now - save.at) / 1000)) })
                : t('save.auto'))))),

        // ---- 判决条：全页唯一的填充面 ----
        h('section', {
          className: 'dshmn-verdict',
          'data-tone': tone,
          'aria-live': 'polite',
          'aria-label': t('group.status'),
        },
        h('div', { className: 'dshmn-verdictHead' },
          h(Dot, { state: tone === 'done' ? 'done' : (tone === 'error' ? 'error' : (tone === 'warning' ? 'warning' : 'idle')) }),
          h('h2', { className: 'dshmn-verdictTitle' }, statusTitle)),
        h('p', { className: 'dshmn-verdictWhy' }, statusWhy),
        evidence(),
        h('div', { className: 'dshmn-verdictFoot' }, secondaryTest, configAction)),

        // ---- 收件人 ----
        h(Group, { title: t('group.recipients'), state: recipientsState },
        h('div', { className: 'dshmn-item' },
        h('div', { className: 'dshmn-field' },
          h('label', { className: 'dshmn-label', htmlFor: 'dshmn-recipients' }, t('recipients.label')),
          h('textarea', {
            id: 'dshmn-recipients',
            className: 'dshmn-textarea',
            value: draft.recipients ?? '',
            placeholder: t('recipients.placeholder'),
            'aria-invalid': recipients.invalid.length > 0 ? 'true' : 'false',
            onChange: (event) => setField('recipients', event.target.value),
            onBlur: () => flush('recipients'),
          }),
          h('div', { className: 'dshmn-hint' }, t('recipients.hint')),
          recipients.invalid.length > 0
            ? h('div', { className: 'dshmn-error', role: 'alert' }, t('recipients.invalid', { list: recipients.invalid.join('、') }))
            : null))),

        // ---- 怎么发 ----
        h(Group, { title: t('group.transport'), state: transportState },
        h('div', { className: 'dshmn-item' },
        h('div', { className: 'dshmn-field' },
          h('div', { className: 'dshmn-seg', role: 'radiogroup', 'aria-label': t('transport.label') },
            ...['log', 'smtp', 'resend'].map((key) => h(Segment, {
              key,
              active: transport === key,
              onClick: () => setField('transport', key, { immediate: true }),
            }, t(`transport.${key}`)))),
          h('div', { className: 'dshmn-hint' }, t(`transport.${transport}.note`)))),

        // 选了真实通道才出现的字段：整段缩进成一块，出现/消失都有明确的边界
        transport === 'log'
          ? null
          : h('div', { className: 'dshmn-item' },
            h('div', { className: 'dshmn-sub' },

        transport === 'smtp'
          ? h('div', { className: 'dshmn-field' },
            h('div', { className: 'dshmn-label' }, t('preset.label')),
            h('div', { className: 'dshmn-seg', role: 'radiogroup', 'aria-label': t('preset.label') },
              ...PRESETS.map((item) => h(Segment, {
                key: item.id,
                active: preset !== null && preset.id === item.id,
                onClick: () => setFields({
                  transport: 'smtp',
                  smtpHost: item.host,
                  smtpPort: item.port,
                  smtpSecure: item.secure,
                  ...(draft.smtpUser === '' && userForPreset(item, recipients.valid) !== ''
                    ? { smtpUser: userForPreset(item, recipients.valid) }
                    : {}),
                }),
              }, item.name)),
              h(Segment, {
                active: preset === null,
                onClick: () => setShowAdvanced(true),
              }, t('preset.other'))),
            preset === null ? null : h('div', { className: 'dshmn-hint' }, t('preset.detected', { name: preset.name })))
          : null,

        transport === 'smtp'
          ? h('div', { className: 'dshmn-grid' },
            h('div', { className: 'dshmn-field' },
              h('label', { className: 'dshmn-label', htmlFor: 'dshmn-smtp-host' }, t('smtp.host')),
              h(TextInput, {
                id: 'dshmn-smtp-host',
                type: 'text',
                value: draft.smtpHost ?? '',
                placeholder: 'smtp.example.com',
                onChange: (event) => setField('smtpHost', event.target.value),
                onBlur: () => flush('smtpHost'),
              })),
            h('div', { className: 'dshmn-field' },
              h('label', { className: 'dshmn-label', htmlFor: 'dshmn-smtp-port' }, t('smtp.port')),
              h(TextInput, {
                id: 'dshmn-smtp-port',
                type: 'text',
                inputMode: 'numeric',
                value: draft.smtpPort ?? '',
                placeholder: '465',
                'aria-label': t('smtp.port'),
                onChange: (event) => setField('smtpPort', event.target.value === '' ? '' : Number(event.target.value), { delay: NUMBER_DEBOUNCE_MS }),
                onBlur: () => flush('smtpPort'),
              })),
            h('div', { className: 'dshmn-field' },
              h('label', { className: 'dshmn-label', htmlFor: 'dshmn-smtp-secure' }, t('smtp.secure')),
              h('select', {
                id: 'dshmn-smtp-secure',
                className: 'dshmn-select',
                value: draft.smtpSecure ?? 'auto',
                onChange: (event) => setField('smtpSecure', event.target.value, { immediate: true }),
              }, ...[['auto', 'auto'], ['tls', 'tls'], ['starttls', 'starttls'], ['plain', 'plain']]
                .map(([value, text]) => h('option', { key: value, value }, text)))))
          : null,

        transport === 'smtp'
          ? h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-smtp-user' }, t('smtp.user')),
            h(TextInput, {
              id: 'dshmn-smtp-user',
              type: 'text',
              value: draft.smtpUser ?? '',
              placeholder: `you${preset?.suffix ?? '@example.com'}`,
              onChange: (event) => setField('smtpUser', event.target.value),
              onBlur: () => flush('smtpUser'),
            }),
            accountMismatch(preset, draft.smtpUser)
              ? h('div', { className: 'dshmn-error', role: 'alert' }, t('smtp.accountMismatch', {
                host: String(draft.smtpHost ?? ''),
                name: preset?.name ?? '',
                user: String(draft.smtpUser ?? ''),
                suffix: preset?.suffix ?? '',
              }))
              : null)
          : null,

        transport === 'smtp'
          ? credentialField('dshmn-cred-smtp', 'cred.smtp', smtpPasswordRef, 'cred.smtpHint', 'cred.smtpHelp')
          : null,

        transport === 'resend'
          ? credentialField('dshmn-cred-resend', 'cred.resend', resendKeyRef, 'cred.resendHint', 'cred.resendHelp')
          : null))),

        // ---- 什么时候发给我 ----
        h(Group, {
          title: t('group.outcomes'),
          state: outcomesOn > 0 ? t('outcomes.countOn', { n: outcomesOn }) : t('outcomes.countOff'),
        },
        // 时长下限是"任务完成"的子项（只对它生效），所以缩进成子行——因果关系看得见，
        // 而不是隔着十行再补一句"只对完成生效"。
        h('div', { className: 'dshmn-item' },
          h('div', { className: 'dshmn-itemHead' },
            h('div', { className: 'dshmn-itemText' },
              h('div', { className: 'dshmn-itemTitle' }, t('outcomes.completed')),
              h('div', { className: 'dshmn-hint' }, t('outcomes.completedHint'))),
            h('div', { className: 'dshmn-itemCtrl' },
              h(Switch, {
                checked: draft.notifyCompleted === true,
                label: t('outcomes.completed'),
                onChange: (next) => setField('notifyCompleted', next, { immediate: true }),
              }))),
          h('div', { className: 'dshmn-sub', 'data-muted': draft.notifyCompleted === true ? 'false' : 'true' },
            h('div', { className: 'dshmn-itemHead' },
              h('div', { className: 'dshmn-itemText' },
                h('label', { className: 'dshmn-itemTitle', htmlFor: 'dshmn-minduration' }, t('outcomes.minDuration')),
                h('div', { className: 'dshmn-hint' }, t('outcomes.minDurationHint'))),
              h('div', { className: 'dshmn-itemCtrl' },
                h(NumberField, {
                  id: 'dshmn-minduration',
                  value: draft.minDurationMs,
                  placeholder: '2000',
                  unit: t('unit.ms'),
                  label: t('outcomes.minDuration'),
                  onChange: (value) => setField('minDurationMs', value, { delay: NUMBER_DEBOUNCE_MS }),
                  onBlur: () => flush('minDurationMs'),
                }))))),
        h(Row, {
          title: t('outcomes.error'),
          hint: t('outcomes.errorHint'),
          control: h(Switch, {
            checked: draft.notifyError === true,
            label: t('outcomes.error'),
            onChange: (next) => setField('notifyError', next, { immediate: true }),
          }),
        }),
        h(Row, {
          title: t('outcomes.blocked'),
          hint: t('outcomes.blockedHint'),
          control: h(Switch, {
            checked: draft.notifyBlocked === true,
            label: t('outcomes.blocked'),
            onChange: (next) => setField('notifyBlocked', next, { immediate: true }),
          }),
        }),
        h(Row, {
          title: t('outcomes.approval'),
          hint: t('outcomes.approvalHint'),
          control: h(Switch, {
            checked: draft.notifyApproval === true,
            label: t('outcomes.approval'),
            onChange: (next) => setField('notifyApproval', next, { immediate: true }),
          }),
        }),
        h(Row, {
          title: t('outcomes.subagents'),
          hint: t('outcomes.subagentsHint'),
          control: h(Switch, {
            checked: draft.includeSubagents === true,
            label: t('outcomes.subagents'),
            onChange: (next) => setField('includeSubagents', next, { immediate: true }),
          }),
        }),
        h('div', { className: 'dshmn-item' },
          h(Disclosure, {
            title: t('outcomes.more'),
            open: showMoreOutcomes,
            onToggle: () => setShowMoreOutcomes((value) => !value),
          },
          h('div', { className: 'dshmn-stack', 'data-rows': 'true' },
            h(Row, {
              title: t('outcomes.aborted'),
              hint: t('outcomes.abortedHint'),
              control: h(Switch, {
                checked: draft.notifyAbortedByUser === true,
                label: t('outcomes.aborted'),
                onChange: (next) => setField('notifyAbortedByUser', next, { immediate: true }),
              }),
            }),
            h(Row, {
              title: t('outcomes.interrupted'),
              hint: t('outcomes.interruptedHint'),
              control: h(Switch, {
                checked: draft.notifyInterrupted === true,
                label: t('outcomes.interrupted'),
                onChange: (next) => setField('notifyInterrupted', next, { immediate: true }),
              }),
            }),
            h(Row, {
              title: t('outcomes.maxTokens'),
              hint: t('outcomes.maxTokensHint'),
              control: h(Switch, {
                checked: draft.notifyMaxTokens === true,
                label: t('outcomes.maxTokens'),
                onChange: (next) => setField('notifyMaxTokens', next, { immediate: true }),
              }),
            })))),

        // ---- 可选设置（发件人、链接、排错）----
        h('section', { className: 'dshmn-group', 'aria-label': t('group.optional') },
          h('div', { className: 'dshmn-groupHead' },
            h('h3', { className: 'dshmn-groupTitle' }, t('group.optional'))),
          h('div', { className: 'dshmn-groupBody' },
        h('div', { className: 'dshmn-item' },
        h(Disclosure, {
          title: t('group.sender'),
          open: showSender,
          onToggle: () => setShowSender((value) => !value),
        },
        h('div', { className: 'dshmn-stack' },
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-sender-name' }, t('sender.name')),
            h(TextInput, {
              id: 'dshmn-sender-name',
              type: 'text',
              value: draft.senderName ?? '',
              onChange: (event) => setField('senderName', event.target.value),
              onBlur: () => flush('senderName'),
            }),
            h('div', { className: 'dshmn-hint' }, t('sender.nameHint'))),
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-from' }, t('sender.address')),
            h(TextInput, {
              id: 'dshmn-from',
              type: 'text',
              value: draft.fromAddress ?? '',
              onChange: (event) => setField('fromAddress', event.target.value),
              onBlur: () => flush('fromAddress'),
            }),
            h('div', { className: 'dshmn-hint' }, t('sender.addressHint'))),
          h(Row, {
            title: t('link.enabled'),
            hint: t('link.enabledHint'),
            control: h(Switch, {
              checked: draft.linkEnabled === true,
              label: t('link.enabled'),
              onChange: (next) => setField('linkEnabled', next, { immediate: true }),
            }),
          }),
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-base' }, t('link.base')),
            h(TextInput, {
              id: 'dshmn-base',
              type: 'text',
              value: draft.publicBaseUrl ?? '',
              placeholder: 'http://127.0.0.1:3081',
              onChange: (event) => setField('publicBaseUrl', event.target.value),
              onBlur: () => flush('publicBaseUrl'),
            }),
            h('div', { className: 'dshmn-hint' }, t('link.baseHint')))))),

        // ---- 可选：高级（排错用）----
        h('div', { className: 'dshmn-item' },
        h(Disclosure, {
          title: t('group.advanced'),
          open: showAdvanced,
          onToggle: () => setShowAdvanced((value) => !value),
        },
        h('div', { className: 'dshmn-stack' },
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-settle' }, t('adv.settle')),
            h(NumberField, {
              id: 'dshmn-settle',
              value: draft.settleMs,
              placeholder: '1500',
              unit: t('unit.ms'),
              label: t('adv.settle'),
              onChange: (value) => setField('settleMs', value, { delay: NUMBER_DEBOUNCE_MS }),
              onBlur: () => flush('settleMs'),
            }),
            h('div', { className: 'dshmn-hint' }, t('adv.settleHint'))),
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-rate' }, t('adv.rate')),
            h(NumberField, {
              id: 'dshmn-rate',
              value: draft.ratePerMinute,
              placeholder: '10',
              unit: t('unit.perMin'),
              label: t('adv.rate'),
              onChange: (value) => setField('ratePerMinute', value, { delay: NUMBER_DEBOUNCE_MS }),
              onBlur: () => flush('ratePerMinute'),
            }),
            h('div', { className: 'dshmn-hint' }, t('adv.rateHint'))),
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-pwref' }, t('adv.pwRef')),
            h(TextInput, {
              id: 'dshmn-pwref',
              type: 'text',
              value: draft.smtpPasswordRef ?? '',
              onChange: (event) => setField('smtpPasswordRef', event.target.value),
              onBlur: () => {
                flush('smtpPasswordRef');
                void refreshCredentials([draftRef.current.smtpPasswordRef, draftRef.current.resendApiKeyRef]);
              },
            }),
            h('div', { className: 'dshmn-hint' }, t('adv.pwRefHint'))),
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-keyref' }, t('adv.keyRef')),
            h(TextInput, {
              id: 'dshmn-keyref',
              type: 'text',
              value: draft.resendApiKeyRef ?? '',
              onChange: (event) => setField('resendApiKeyRef', event.target.value),
              onBlur: () => {
                flush('resendApiKeyRef');
                void refreshCredentials([draftRef.current.resendApiKeyRef, draftRef.current.smtpPasswordRef]);
              },
            }),
            h('div', { className: 'dshmn-hint' }, t('adv.pwRefHint'))),
          h('div', { className: 'dshmn-field' },
            h('label', { className: 'dshmn-label', htmlFor: 'dshmn-statepath' }, t('adv.statePath')),
            h(TextInput, {
              id: 'dshmn-statepath',
              type: 'text',
              value: draft.statePath ?? '',
              onChange: (event) => setField('statePath', event.target.value),
              onBlur: () => flush('statePath'),
            }),
            h('div', { className: 'dshmn-hint' }, t('adv.statePathHint')))))),
          )),

        // ---- 页脚：清空覆盖是破坏性操作，所以压到最下面、只用文字链接 ----
        h('div', { className: 'dshmn-foot' },
          h('button', {
            type: 'button',
            className: 'dshmn-link',
            disabled: resetting,
            onClick: () => setConfirmReset(true),
          }, t('danger.reset'))),

        typeof P.Modal === 'function'
          ? h(P.Modal, {
            open: confirmReset,
            onClose: () => setConfirmReset(false),
            title: t('danger.title'),
            closeLabel: t('danger.cancel'),
            footer: h(React.Fragment, null,
              h(Button, { variant: 'outline', size: 'sm', onClick: () => setConfirmReset(false) }, t('danger.cancel')),
              h(Button, { variant: 'primary', size: 'sm', disabled: resetting, onClick: () => void resetAll() }, t('danger.ok'))),
          },
          h('div', { className: 'dshmn-hint' }, t('danger.body')),
          h('div', { className: 'dshmn-hint' }, t('danger.keep')))
          : null,

        // ---- 凭据帮助（疑问句必须是能点的）----
        (typeof P.Modal === 'function' && helpKind !== null
          ? h(P.Modal, {
            open: true,
            onClose: () => setHelpKind(null),
            title: t(helpKind === 'resend' ? 'cred.resendHelpTitle' : 'cred.smtpHelpTitle'),
            closeLabel: t('cred.helpClose'),
            footer: h(Button, { variant: 'outline', size: 'sm', onClick: () => setHelpKind(null) }, t('cred.helpClose')),
          }, h('div', { className: 'dshmn-helpBody' }, t(helpKind === 'resend' ? 'cred.resendHelpBody' : 'cred.smtpHelpBody')))
          : null)));
    }

    /**
     * 解 Remote 的 `{ ok, value }` 信封（硬约束 2）。
     * @param {unknown} response Remote 返回值
     * @returns {unknown} value 部分
     */
    function unwrap(response) {
      if (response && typeof response === 'object' && response.ok === true) return response.value;
      const error = response && typeof response === 'object' ? response.error : undefined;
      const message = typeof error === 'string'
        ? error
        : (error && typeof error === 'object' && typeof error.message === 'string' ? error.message : JSON.stringify(error ?? response));
      throw new Error(message);
    }

    /**
     * 调一个 Host Remote 方法。
     *
     * 走 connection 的通用 RPC 而不是挂 remote 命名空间：本插件的 client 半是手写包，
     * 没有生成出来的 remote 声明，而 `/api` + `<namespace>/<method>` 是同一套网关，
     * 参数与清单里声明的 parameters 必须完全一致（这里两个方法都是零参数）。
     * @param {'test'|'state'} method 方法名
     * @returns {Promise<unknown>} Remote 的 `{ ok, value }` 信封
     */
    function callRemote(method) {
      const rpc = remotesRef.current?.rpc;
      if (typeof rpc?.call !== 'function') {
        return Promise.reject(new Error('Host 未提供 mailNotify 能力 / host remote unavailable'));
      }
      return rpc.call('/api', `${REMOTE_NS}/${method}`, { args: {} });
    }

    return {
      inject,
      /**
       * 客户端入口。
       * @param {object} ctx 客户端上下文
       * @returns {void}
       */
      apply(ctx) {
        // 四个依赖各开一个独立的 inject（硬约束 1）：
        // 任何一个当时不可用，都只损失它自己那部分能力，页面依旧注册、依旧可用。
        const remotes = remotesRef;

        try {
          ctx.inject(['remote', 'remote.settings', 'remote.credentials'], (scoped) => {
            remotes.current = {
              ...(remotes.current ?? {}),
              settings: scoped.remote.settings,
              credentials: scoped.remote.credentials,
            };
          });
        } catch (error) {
          console.warn('[dsh-notify-p] 远程命名空间注入失败 / remote injection failed:', error);
        }

        // Host 动作走 connection 的通用 RPC：`/api` + `<namespace>/<method>`。
        // 参数必须与清单声明的 parameters 完全一致——test/state 都是零参数，所以是空对象。
        try {
          ctx.inject(['connection'], (scoped) => {
            const rpc = scoped.connection?.rpc;
            if (typeof rpc?.call !== 'function') return;
            remotes.current = { ...(remotes.current ?? {}), rpc };
            console.info('[dsh-notify-p] Host RPC 已连接 / host rpc connected');
          });
        } catch (error) {
          console.warn('[dsh-notify-p] connection 注入失败，测试邮件不可用 / connection injection failed:', error);
        }

        try {
          ctx.inject(['locale'], (scoped) => {
            ctx.effect(() => scoped.locale.register(NS, { zh: ZH, en: EN }), 'dsh-notify-p: dictionaries');
            i18n.locale = scoped.locale;
            console.info('[dsh-notify-p] 文案字典已注册 / locale dictionaries registered');
          });
        } catch (error) {
          console.warn('[dsh-notify-p] locale 注入失败，回退中文 / locale injection failed:', error);
        }

        try {
          ctx.inject(['slots'], (scoped) => {
            scoped.slots.inject('settings.section', () => scoped.slots.register({
              name: 'settings.section',
              id: 'mail-notify',
              // icon 管理用 50，排在它后面
              order: 60,
              // 传函数而不是字符串：host 会在 locale revision 变化时重新解析它
              label: () => i18n.t('nav'),
            }, (props) => React.createElement(MailNotifyPage, { ...props, remotes })));
            console.info('[dsh-notify-p] 设置页已注册 / settings page registered (settings.section order=60)');
          });
        } catch (error) {
          console.warn('[dsh-notify-p] 设置页注册失败 / failed to register settings page:', error);
        }
      },
      /** 给离线单测用的接线口（浏览器运行时不会读它）。 */
      __internals: { parseRecipients, deriveStatus, matchPreset, presetForAddress, dotState, accountMismatch, userForPreset, relativeTime, PRESETS, ZH, EN, CSS, fmt, i18n },
    };
  },
});
