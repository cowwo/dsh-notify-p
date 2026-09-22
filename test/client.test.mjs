// dsh-notify-p · 浏览器半的离线测试
//
// 浏览器半没有构建步骤，所以这里直接把 client.js 当 browser bundle 装进一个假环境里跑：
//   - 桩掉 window.__ModuleLoader__ / document，拿到 factory 与它返回的模块对象
//   - 用假 cordis ctx 驱动 apply()，断言三类依赖各自独立注册
//   - 纯函数（收件人解析 / 状态推导 / 预设匹配）走真值表
//   - 静态审计 CSS：用到的每个 --dsw-alias-* 必须是宿主主题里真实存在的 token
//
// 最后两条是有意的"复发护栏"：
//   1. 三个不存在的 token（interact-primary / interact-secondary / border-secondary）会静默
//      退回硬编码浅色值，暗色模式整页失配——已被 CSS 审计永久拦住。
//   2. 凭据的写入目标必须由调用方给定，不能从草稿里猜 smtpPasswordRef——否则 Resend 的
//      Key 会被写进 SMTP 的引用名，而页面一直显示「未配置」。源码断言拦住它。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

/** 宿主主题里真实存在的 alias token（取自 dsh-client-ui-theme 的 token 表）。 */
const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1', '--dsw-alias-bg-mask-2', '--dsw-alias-bg-mask-3', '--dsw-alias-bg-mask-drop',
  '--dsw-alias-bg-mask-photo', '--dsw-alias-bg-module-platform', '--dsw-alias-bg-multi-select',
  '--dsw-alias-bg-overlay', '--dsw-alias-bg-skeleton', '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2', '--dsw-alias-border-l1', '--dsw-alias-border-l2',
  '--dsw-alias-border-l2-darkmode-thin', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary', '--dsw-alias-brand-primary-invert', '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill', '--dsw-alias-button-elevated-fill', '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover', '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill', '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill', '--dsw-alias-button-info-hover', '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover', '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-fill-invisible', '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent', '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid', '--dsw-alias-label-caption', '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary', '--dsw-alias-label-primary-bluish', '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-primary-foreground', '--dsw-alias-label-primary-inverted', '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary', '--dsw-alias-link', '--dsw-alias-markdown-citation',
  '--dsw-alias-markdown-code-block', '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected', '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code', '--dsw-alias-markdown-placeholder', '--dsw-alias-markdown-tag',
  '--dsw-alias-scrollbar-bg-l1', '--dsw-alias-scrollbar-bg-l2', '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2', '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-error-secondary', '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary', '--dsw-alias-state-success-tertiary', '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-secondary', '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-toast-bg', '--dsw-alias-tooltip-bg',
]);

/**
 * 把浏览器 bundle 装进假环境并取回 factory。
 * @returns {{ mod: object, cssText: string, consoleWarns: string[] }} 模块对象与注入的 CSS
 */
async function loadBundle() {
  const injected = [];
  const consoleWarns = [];
  const originalWarn = console.warn;
  globalThis.window = { __ModuleLoader__: { load: (entry) => { injected.push(entry); } } };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: (element) => { injected.push(element); } },
  };
  console.warn = (...args) => { consoleWarns.push(args.map(String).join(' ')); };
  try {
    // 每次换一个 query 参数，绕开 ESM 缓存，让 fetch 计数从零开始
    await import(`${SOURCE_PATH}?t=${String(Math.random())}`);
    assert.equal(injected.length >= 1, true, 'bundle 必须调用 window.__ModuleLoader__.load');
    const entry = injected.find((item) => item && item.factory !== undefined);
    assert.ok(entry, '必须注册一个带 factory 的模块');
    const mod = entry.factory((id) => {
      if (id === 'react') return {};
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
      throw new Error(`未预期的 require：${id}`);
    });
    const style = injected.find((item) => item && item.textContent !== undefined && item.textContent !== '');
    return { mod, cssText: style?.textContent ?? '', consoleWarns };
  } finally {
    console.warn = originalWarn;
  }
}

/**
 * 最小可用的假 cordis 客户端上下文。
 * @param {{ failLocale?: boolean }} [opts] 开关
 * @returns {object} 假 ctx
 */
function fakeCtx(opts = {}) {
  const record = { injects: [], effects: [], registers: [], dicts: [], bound: [] };
  const slots = {
    inject(name, callback) { record.slotInject = name; callback(); return () => {}; },
    register(options, render) { record.registers.push({ options, render }); return () => {}; },
  };
  const locale = {
    register(ns, dicts) { record.dicts.push({ ns, dicts }); return () => {}; },
    bind(ns) { record.bound.push(ns); return (key) => key; },
    subscribe() { return () => {}; },
    getSnapshot() { return { id: 'zh', revision: 1 }; },
  };
  const ctx = {
    inject(services, callback) {
      record.injects.push(services);
      if (opts.failLocale === true && services.includes('locale')) throw new Error('locale 服务不可用');
      if (opts.failConnection === true && services.includes('connection')) throw new Error('connection 服务不可用');
      if (services.includes('locale')) callback({ locale });
      else if (services.includes('slots')) callback({ slots });
      else if (services.includes('connection')) callback({ connection: { rpc: { call: () => Promise.resolve({ ok: true, value: {} }) } } });
      else callback({ remote: { settings: {}, credentials: {} } });
    },
    effect(fn, label) { record.effects.push(label); return fn(); },
  };
  return { ctx, record };
}

test('浏览器半：factory 返回 inject 与 apply，且只硬依赖 slots', async () => {
  const { mod } = await loadBundle();
  assert.deepEqual(mod.inject, ['slots'], '页面注册只该依赖 slots（硬约束 1）');
  assert.equal(typeof mod.apply, 'function');
});

test('浏览器半：apply 分四次注册依赖，页面注册不依赖 locale / remote / connection', async () => {
  const { mod } = await loadBundle();
  const { ctx, record } = fakeCtx();
  mod.apply(ctx);
  assert.deepEqual(record.injects, [
    ['remote', 'remote.settings', 'remote.credentials'],
    ['connection'],
    ['locale'],
    ['slots'],
  ], '每类依赖必须各自独立 inject');
  assert.equal(record.registers.length, 1);
  const { options } = record.registers[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'mail-notify');
  assert.equal(options.order, 60);
  assert.equal(typeof options.label, 'function', 'label 传函数，宿主才能在切语言时重新解析');
});

test('浏览器半：connection 不可用时页面照常注册，只是测试邮件不可用', async () => {
  const { mod } = await loadBundle();
  const { ctx, record } = fakeCtx({ failConnection: true });
  mod.apply(ctx);
  assert.equal(record.registers.length, 1, 'connection 挂了不能连带把页面带走');
});

test('浏览器半：locale 服务不可用时，设置页依旧注册', async () => {
  const { mod } = await loadBundle();
  const { ctx, record } = fakeCtx({ failLocale: true });
  mod.apply(ctx);
  assert.equal(record.registers.length, 1, 'locale 挂了不能连带把页面带走');
  assert.equal(record.dicts.length, 0);
});

test('浏览器半：注册 zh 与 en 两套字典，键集合必须完全一致', async () => {
  const { mod } = await loadBundle();
  const { ZH, EN } = mod.__internals;
  assert.deepEqual(Object.keys(ZH).sort(), Object.keys(EN).sort(), 'zh / en 文案键必须一一对应');
  for (const [key, value] of Object.entries(ZH)) {
    assert.equal(typeof value, 'string', `${key} 必须是字符串`);
    assert.notEqual(value.trim(), '', `${key} 不能是空文案`);
  }
});

test('浏览器半：文案不做中英同屏', async () => {
  const { mod } = await loadBundle();
  const { ZH, EN } = mod.__internals;
  // 旧形态是 `中文 / English` 拼在一行；这里拦住"汉字段 + 斜杠 + 两个以上拉丁词"的写法。
  // 要求右侧是多词英文句子，才不会误伤 `$DSH_HOME/dsh-notify-p/state.json` 这类路径，
  // 以及 `（QQ / 163 / Gmail）` 这类并列专有名词。
  const bilingual = /\p{Script=Han}[^/]{0,60}\/\s*[A-Za-z]+(?:\s+[A-Za-z]+)+/u;
  for (const [key, value] of Object.entries(ZH)) {
    assert.equal(bilingual.test(value), false, `zh.${key} 疑似中英同屏：${value}`);
  }
  for (const [key, value] of Object.entries(EN)) {
    assert.equal(/[\u4e00-\u9fff]/.test(value), false, `en.${key} 里混进了中文：${value}`);
  }
});

test('CSS 审计：用到的每个 --dsw-alias-* 都必须是宿主主题里真实存在的 token', async () => {
  const { cssText } = await loadBundle();
  const used = [...new Set([...cssText.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((m) => m[0]))];
  assert.equal(used.length > 0, true, 'CSS 必须用到主题 token');
  const unknown = used.filter((token) => !THEME_TOKENS.has(token));
  assert.deepEqual(unknown, [], `用了主题里不存在的 token（暗色模式会失配）：${unknown.join(', ')}`);
});

test('CSS 审计：三个已证伪的 token 必须不再出现', async () => {
  const { cssText } = await loadBundle();
  for (const bogus of ['--dsw-alias-interact-primary', '--dsw-alias-interact-secondary', '--dsw-alias-border-secondary']) {
    assert.equal(cssText.includes(bogus), false, `${bogus} 在主题里不存在，会静默退回硬编码浅色值`);
  }
});

test('CSS 审计：全页零硬编码颜色，暗色完全交给主题 token', async () => {
  const { cssText } = await loadBundle();
  const hex = [...cssText.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
  assert.deepEqual(hex, [], `CSS 里不该出现硬编码颜色：${hex.join(', ')}`);
  for (const fn of ['rgb(', 'rgba(', 'hsl(']) {
    assert.equal(cssText.includes(fn), false, `不该出现硬编码颜色函数：${fn}`);
  }
});

test('CSS 审计：不许在 :root 上套 var() 别名', async () => {
  const { cssText } = await loadBundle();
  // 真踩过，而且是整页"做废"的根因：宿主把 --dsw-alias-* 定义在 **body** 上，
  // 而自定义属性里的 var() 是在**声明它的那个元素**上求值的。于是
  //   :root{--dshmn-surface:var(--dsw-alias-bg-layer-1)}
  // 在 html 上求值 → 找不到 → 整条链变成空值 → 结论卡背景 transparent（等于没有高亮块）、
  // 发丝线回退到 currentColor、输入框没有描边。规则里直接引用 token 才走继承链。
  const aliases = [...cssText.matchAll(/:root\s*\{[^}]*--[a-z-]+\s*:\s*var\(/g)].map((m) => m[0]);
  assert.deepEqual(aliases, [], ':root 上的 var() 别名会静默失效；直接在规则里引用 --dsw-alias-*');
});

test('CSS 审计：判决条必须落在宿主真实的 module 面上', async () => {
  const { cssText } = await loadBundle();
  // 浅色主题下 bg-layer-1 / bg-layer-2 / bg-layer-3 **全是纯白**，跟页面底色一模一样。
  // 所以"高亮块"只能用 bg-module-platform（#f5f6f7 / #353638）。这条拦住"又用白色当高亮"。
  const rule = /\.dshmn-verdict\{[^}]*\}/.exec(cssText)?.[0] ?? '';
  assert.notEqual(rule, '', '必须有 .dshmn-verdict 规则');
  assert.match(rule, /background:\s*var\(--dsw-alias-bg-module-platform\)/,
    '全页唯一的高亮块必须有真实底色（背景层 token 在浅色下都是白的）');
});

test('源码护栏：凭据写入目标必须由调用方给定，不能猜 smtpPasswordRef', () => {
  assert.equal(
    SOURCE.includes('commitCredential(ref)'),
    true,
    '凭据提交必须显式传引用名',
  );
  assert.equal(
    /draftRef\.current\.smtpPasswordRef\s*\?\?/.test(SOURCE),
    false,
    '不许从草稿里 fallback 出 smtpPasswordRef 当作写入目标（这正是 Resend Key 写错位置的成因）',
  );
});

test('源码护栏：每个开关的可访问名都来自文案，而不是字段 key', () => {
  assert.equal(/\blabel:\s*key\b/.test(SOURCE), false, 'aria-label 不能直接用字段 key');
  assert.equal(SOURCE.includes("label: t('"), true, '开关的可访问名必须走文案');
});

test('纯函数：parseRecipients 与 Host 侧规则一致（去空、去重、分拣非法项）', async () => {
  const { parseRecipients } = (await loadBundle()).mod.__internals;
  assert.deepEqual(parseRecipients('a@b.com'), { valid: ['a@b.com'], invalid: [] });
  assert.deepEqual(parseRecipients('a@b.com\nc@d.com'), { valid: ['a@b.com', 'c@d.com'], invalid: [] });
  assert.deepEqual(parseRecipients('a@b.com, c@d.com; e@f.com'), { valid: ['a@b.com', 'c@d.com', 'e@f.com'], invalid: [] });
  assert.deepEqual(parseRecipients(' A@B.com \n a@b.com '), { valid: ['A@B.com'], invalid: [] }, '去重不分大小写');
  // 逗号是合法的分隔符，所以"逗号打成点"的笔误会裂成两段；这是与 Host 侧一致的既定行为，
  // 页面上会逐条列出，而不是笼统说一句"格式不对"。
  assert.deepEqual(parseRecipients('cowwo@outlook,com'), { valid: [], invalid: ['cowwo@outlook', 'com'] });
  assert.deepEqual(parseRecipients('nope\nyes@ok.com'), { valid: ['yes@ok.com'], invalid: ['nope'] });
  assert.deepEqual(parseRecipients(''), { valid: [], invalid: [] });
  assert.deepEqual(parseRecipients(undefined), { valid: [], invalid: [] });
  assert.deepEqual(parseRecipients('   \n , ; '), { valid: [], invalid: [] });
});

test('纯函数：deriveStatus 真值表覆盖每个状态分支', async () => {
  const { deriveStatus } = (await loadBundle()).mod.__internals;
  const base = { enabled: true, transport: 'smtp', recipientCount: 1, host: 'smtp.qq.com', user: 'me@qq.com', credentialConfigured: true };
  assert.equal(deriveStatus({ ...base, enabled: false }), 'disabled');
  assert.equal(deriveStatus({ ...base, recipientCount: 0 }), 'needRecipients');
  assert.equal(deriveStatus({ ...base, transport: 'log' }), 'simulated');
  assert.equal(deriveStatus({ ...base, host: '' }), 'needHost');
  assert.equal(deriveStatus({ ...base, user: '' }), 'needUser', 'SMTP 缺用户名同样是没配完');
  assert.equal(deriveStatus({ ...base, credentialConfigured: false }), 'needCredential');
  assert.equal(deriveStatus({ ...base, lastDelivery: { ok: false, error: '535' } }), 'lastFailed');
  assert.equal(deriveStatus({ ...base, lastDelivery: { ok: true } }), 'ready');
  assert.equal(deriveStatus(base), 'ready');
  assert.equal(deriveStatus({ ...base, transport: 'resend' }), 'ready', 'resend 不要求 SMTP 主机与用户名');
  assert.equal(deriveStatus({ ...base, transport: 'resend', host: '', user: '' }), 'ready');
  assert.equal(deriveStatus(undefined), 'disabled');
  // 判定顺序：先关、再收件人、再通道
  assert.equal(deriveStatus({ ...base, enabled: false, recipientCount: 0, transport: 'log' }), 'disabled');
  assert.equal(deriveStatus({ ...base, recipientCount: 0, transport: 'log' }), 'needRecipients');
});

test('纯函数：预设匹配与按邮箱猜预设', async () => {
  const { matchPreset, presetForAddress, PRESETS } = (await loadBundle()).mod.__internals;
  assert.equal(matchPreset('smtp.qq.com')?.id, 'qq');
  assert.equal(matchPreset('SMTP.QQ.COM')?.id, 'qq', '匹配忽略大小写');
  assert.equal(matchPreset('  smtp.gmail.com '), PRESETS.find((p) => p.id === 'gmail'));
  assert.equal(matchPreset('smtp.example.com'), null);
  assert.equal(matchPreset(''), null);
  assert.equal(presetForAddress('me@outlook.com')?.id, 'outlook');
  assert.equal(presetForAddress('ME@QQ.COM')?.id, 'qq');
  assert.equal(presetForAddress('me@example.com'), null);
  assert.equal(presetForAddress('no-at-sign'), null);
});

test('纯函数：fmt 插值保留未知占位符', async () => {
  const { fmt } = (await loadBundle()).mod.__internals;
  assert.equal(fmt('共 {n} 个', { n: 3 }), '共 3 个');
  assert.equal(fmt('缺 {a} 和 {b}', { a: 'x' }), '缺 x 和 {b}');
  assert.equal(fmt('没有占位符'), '没有占位符');
});

test('纯函数：dotState 对不适用给 idle，而不是假警报', async () => {
  const { dotState } = (await loadBundle()).mod.__internals;
  assert.equal(dotState(true), 'done');
  assert.equal(dotState(false), 'warning');
  assert.equal(dotState(false, true), 'idle');
  assert.equal(dotState(true, true), 'idle');
});

test('纯函数：relativeTime 给投递结果一句人话', async () => {
  const { relativeTime } = (await loadBundle()).mod.__internals;
  const now = 1_776_000_000_000;
  assert.equal(relativeTime(now - 3_000, now), '刚刚');
  assert.equal(relativeTime(now - 30_000, now), '30 秒前');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(relativeTime(now - 3 * 3_600_000, now), '3 小时前');
  assert.equal(relativeTime(now - 2 * 86_400_000, now), '2 天前');
  assert.equal(relativeTime(undefined, now), '', '拿不到时间戳就不编');
  assert.equal(relativeTime(Number.NaN, now), '');
});

test('源码护栏：发送测试邮件必须常驻，不能只在"已就绪"时才给按钮', () => {
  // 曾经的形态：只有 statusKey 是 ready / lastFailed 时才渲染测试按钮，
  // 于是填了一半的人在页面上根本找不到"怎么验证"——而这恰恰是测试按钮最该出现的时候。
  assert.match(SOURCE, /const testButton = \(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\) => \{/, '必须有一个不挑状态的测试按钮构造函数');
  assert.equal(/statusKey === 'ready'[\s\S]{0,200}?act\.test/.test(SOURCE), false,
    '测试按钮不允许被 statusKey 门控');
  assert.equal((SOURCE.match(/testButton\(/g) ?? []).length >= 2, true,
    '状态条之外还要有一个常驻入口（凭据行 / 最近一次投递）');
  assert.equal(SOURCE.includes("t('act.testHint')"), true, '常驻按钮要说清点了会发生什么');
});

test('源码护栏：凭据读失败要显形，不能静默停在「未配置」', () => {
  assert.equal(SOURCE.includes('setCredError'), true, '凭据状态读取失败必须有可见反馈');
  assert.equal(SOURCE.includes("t('save.credCheckFailed'"), true);
});

test('文案：代码里用到的键必须真的在字典里', async () => {
  const { mod } = await loadBundle();
  const { ZH, EN } = mod.__internals;
  // 死键审计只查了一个方向（字典里的键有没有人用），查不出反方向：
  // 代码里 t('recipients.placeholder') 而字典里没有这个键时，t() 会**把 key 原样返回**，
  // 于是页面上直接显示 "recipients.placeholder" 这串英文 —— 静态审计看不出来，只有渲染才暴露。
  const used = [...SOURCE.matchAll(/\bt\(\s*'([a-zA-Z][\w.]*)'/g)].map((m) => m[1]);
  assert.equal(used.length > 60, true, '至少该扫到几十个字面量键，否则是正则被改坏了');
  const missing = [...new Set(used)].filter((key) => !(key in ZH) || !(key in EN));
  assert.deepEqual(missing, [], `代码用了但字典里没有的键（页面上会显示原始 key）：${missing.join(', ')}`);
});

test('文案：字典里不允许留没人用的死键', async () => {
  const { mod } = await loadBundle();
  const { ZH } = mod.__internals;
  // 这几个键是按状态名动态拼出来的，静态扫描看不到，显式放行
  const dynamic = new Set([
    'status.disabled', 'status.needRecipients', 'status.needHost',
    'status.needUser', 'status.simulated', 'status.ready',
  ]);
  // 去掉两份字典本身之后，再看还有哪些键在代码里找不到
  const withoutDicts = SOURCE
    .replace(/const ZH = \{[\s\S]*?\n {4}\};/, '')
    .replace(/const EN = \{[\s\S]*?\n {4}\};/, '');
  // 模板串拼出来的键（t(`transport.${key}`)）静态扫描同样看不到，要把固定前缀收集起来。
  // 真踩过：transport.smtp / transport.resend / *.note 被当成死键删掉，页面直接显示原始 key。
  const prefixes = [...withoutDicts.matchAll(/t\(`([^`$]*)\$\{/g)].map((m) => m[1]);
  const unused = Object.keys(ZH).filter(
    (key) => !dynamic.has(key) && !prefixes.some((p) => p !== '' && key.startsWith(p)) && !withoutDicts.includes(`'${key}'`),
  );
  assert.deepEqual(unused, [], `字典里有没人用的死文案：${unused.join(', ')}`);
});

test('纯函数：账号域名与服务商对不上要能被看出来', async () => {
  const { accountMismatch, matchPreset, PRESETS } = (await loadBundle()).mod.__internals;
  const qq = matchPreset('smtp.qq.com');
  const outlook = matchPreset('smtp.office365.com');

  // 对不上：QQ 服务器 + outlook 账号（认证必然 535）
  assert.equal(accountMismatch(qq, 'cowwo@outlook.com'), true);
  // 对得上
  assert.equal(accountMismatch(qq, 'me@qq.com'), false);
  assert.equal(accountMismatch(qq, 'me@foxmail.com'), false, '同服务商的其他域名也算对得上');
  assert.equal(accountMismatch(outlook, 'me@hotmail.com'), false);
  // 大小写/空白
  assert.equal(accountMismatch(qq, ' ME@QQ.COM '), false);
  assert.equal(accountMismatch(qq, 'me@OUTLOOK.com'), true);
  // 没填 / 不成邮箱 / 没有预设：不吭声，别乱猜（自建中继是合法的）
  assert.equal(accountMismatch(qq, ''), false);
  assert.equal(accountMismatch(qq, 'not-an-email'), false);
  assert.equal(accountMismatch(null, 'me@qq.com'), false);
  // 预设表自洽：每个都带 domains
  for (const preset of PRESETS) {
    assert.equal(Array.isArray(preset.domains) && preset.domains.length > 0, true, `${preset.id} 缺 domains`);
  }
});

test('纯函数：预设推断用户名只在域名匹配时给值', async () => {
  const { userForPreset, matchPreset } = (await loadBundle()).mod.__internals;
  const qq = matchPreset('smtp.qq.com');
  assert.equal(userForPreset(qq, ['me@qq.com', 'other@outlook.com']), 'me@qq.com');
  assert.equal(userForPreset(qq, ['cowwo@outlook.com']), '', '收件人不是 QQ 邮箱就不能拿它当发件账号');
  assert.equal(userForPreset(qq, []), '');
  assert.equal(userForPreset(null, ['me@qq.com']), '');
});
