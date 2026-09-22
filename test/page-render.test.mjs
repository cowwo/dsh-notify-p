// dsh-notify-p · 设置页离线渲染冒烟
//
// 浏览器半的其它用例都是"源码审计 + 纯函数真值表"，跑不到 JSX 的渲染路径。
// 这里用一个能跑状态、副作用与 ref 的 React 桩，把真正的 MailNotifyPage 渲染出来，
// 断言**新加的那几件东西真的出现在 DOM 树里**：
//   1. 发送测试邮件是常驻入口（凭据行一处、最近一次投递一处），不再被"已就绪"门控；
//   2. 授权码未配置时状态条给的是「去填写」，按钮仍可用——点了能立刻拿到真实原因；
//   3. 最近一次投递的结果（含失败原因）留在页面上，而不是只活在状态条里。
//
// 副作用是刻意跑的：凭据那一条链路会"写完之后再读一次"，桩里把它计次，
// 顺便验证自动复检真的会发生（页面不会停在「未配置」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url));

/** 设置命名空间里的一份"已经配好一半"的真实值：通道 SMTP、收件人有了、授权码还没存。 */
const SETTINGS_VALUE = {
  enabled: true,
  transport: 'smtp',
  recipients: 'me@qq.com',
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  smtpSecure: 'tls',
  smtpUser: 'me@qq.com',
  smtpPasswordRef: 'DSH_MAIL_NOTIFY_SMTP_PASSWORD',
  notifyCompleted: true,
};

/** 最近一次投递：真机上踩过的 QQ 550（From 头被整串 B-encode）。 */
const LAST_DELIVERY = {
  at: Date.now() - 5000,
  ok: false,
  transport: 'smtp',
  recipients: ['me@qq.com'],
  subject: '测试邮件 / Test email',
  ms: 900,
  error: '550 The "From" header is missing or invalid',
};

/**
 * 装 bundle 并渲染设置页。
 * @param {object} [options] 覆盖预热状态（默认是配到一半、上次失败的形态）
 * @param {object} [options.settings] 设置命名空间里的值
 * @param {boolean} [options.credentialsConfigured] 凭据是否已写入凭据库
 * @param {object|null} [options.lastDelivery] 最近一次投递
 * @returns {Promise<{json: string, credentialCalls: number}>} 渲染结果（JSON 化的元素树 + 凭据查询次数）
 */
async function renderPage(options = {}) {
  const settingsValue = options.settings ?? SETTINGS_VALUE;
  // 预热值会在 mount 之后被 refreshCredentials 重算一遍，所以真正的开关是 describe 的返回值。
  const credentialsConfigured = options.credentialsConfigured === true;
  const credentialState = options.credentialState ?? { DSH_MAIL_NOTIFY_SMTP_PASSWORD: credentialsConfigured };
  const lastDelivery = options.lastDelivery === undefined ? LAST_DELIVERY : options.lastDelivery;
  let entry;
  globalThis.window = {
    __ModuleLoader__: { load: (value) => { entry = value; } },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  };
  await import(`${pathToFileURL(SOURCE_PATH).href}?render=${String(Math.random())}`);

  const store = { values: [], refs: [], cleanups: new Map() };
  let cursor = 0;
  let effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'Fragment',
    useState(init) {
      const i = cursor += 1;
      if (store.values[i] === undefined) store.values[i] = typeof init === 'function' ? init() : init;
      return [store.values[i], (next) => {
        store.values[i] = typeof next === 'function' ? next(store.values[i]) : next;
      }];
    },
    useRef(init) {
      const i = cursor += 1;
      if (store.refs[i] === undefined) store.refs[i] = { current: init };
      return store.refs[i];
    },
    useCallback(fn) { cursor += 1; return fn; },
    useEffect(fn) { const i = cursor += 1; effects.push([i, fn]); },
  };

  const mod = entry.factory((id) => {
    if (id === 'react') return React;
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`未预期的 require：${id}`);
  });

  let page = null;
  const slots = {
    inject: (name, callback) => callback(),
    register: (options, render) => { page = render; },
  };
  let credentialCalls = 0;
  const settingsRemote = {
    describe: async () => ({
      ok: true,
      value: { namespaces: [{ ns: 'dsh-notify-p', revision: 1, value: settingsValue }] },
    }),
    mutate: async () => ({ ok: true, value: { ns: 'dsh-notify-p', revision: 2, value: settingsValue } }),
    replace: async () => ({ ok: true, value: { ns: 'dsh-notify-p', revision: 3, value: settingsValue } }),
  };
  const credentialsRemote = {
    describe: async (refs) => {
      credentialCalls += 1;
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: credentialsConfigured }])) };
    },
    set: async () => ({ ok: true, value: null }),
    unset: async () => ({ ok: true, value: null }),
  };

  mod.apply({
    inject: (services, callback) => {
      if (services.includes('slots')) return callback({ slots });
      if (services.includes('locale')) {
        return callback({ locale: { register: () => {}, subscribe: () => () => {}, getSnapshot: () => ({ id: 'zh', revision: 1 }) } });
      }
      if (services.includes('connection')) {
        return callback({
          connection: {
            rpc: {
              call: async () => ({
                ok: true,
                value: { counts: { sent: 0, failed: 1 }, recent: lastDelivery === null ? [] : [lastDelivery] },
              }),
            },
          },
        });
      }
      return callback({ remote: { settings: settingsRemote, credentials: credentialsRemote } });
    },
    effect: (fn) => fn(),
  });

  // 预热：等价于 load() 跑完、凭据查询有结果、能力探测通过（这三步在真机上是异步的）。
  store.values[0] = true;                                    // ready
  store.values[2] = { ...settingsValue };                    // draft
  store.values[5] = { ...credentialState };                  // credentialState
  store.values[7] = lastDelivery;                            // lastDelivery
  store.values[12] = 'ready';                                // capability
  store.refs[11] = { current: { ...settingsValue } };        // draftRef
  store.refs[12] = { current: { ...settingsValue } };        // baselineRef
  store.refs[13] = { current: { ns: 'dsh-notify-p', revision: 1, value: settingsValue } }; // viewRef

  let root = null;
  for (let round = 0; round < 4; round += 1) {
    cursor = 0;
    effects = [];
    root = page({}).type(page({}).props);
    for (const [index, fn] of effects) {
      const cleanup = store.cleanups.get(index);
      if (typeof cleanup === 'function') cleanup();
      const next = fn();
      store.cleanups.set(index, typeof next === 'function' ? next : undefined);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }

  return { json: JSON.stringify(root ?? null), credentialCalls };
}

test('渲染冒烟：授权码未配置时，发送测试邮件仍是常驻入口（不挑状态）', async () => {
  const { json } = await renderPage();
  // 判决条在这个形态下给的是「去填写」，但测试入口不该跟着消失：
  // 一处在判决条（次级），一处在凭据行（文字链接，手刚离开输入框就在原地）。
  assert.equal(json.includes('还差'), true, '缺授权码时判决句要说清缺什么');
  assert.equal(json.includes('按现在的配置真发一封'), true, '测试入口要带一句"点了会发生什么"');
  const buttonCount = (json.match(/发送测试邮件|重新测试/g) ?? []).length;
  assert.equal(buttonCount >= 2, true, `测试入口至少要有两处（判决条 + 凭据行），实际 ${String(buttonCount)}`);
});

test('渲染冒烟：最近一次投递的失败原因留在页面上', async () => {
  const { json } = await renderPage();
  assert.equal(json.includes('最近一次发送'), true, '判决条里要有一条"最近一次发送"的读数');
  assert.equal(json.includes('失败'), true, '判决句要说清上一次没发出去');
  // 原始报错与分类都要留在页面上，而且只出现一次（标题里不再重复一遍原文）
  assert.equal(json.includes('550 The'), true, '原始报错不能只活在状态条里');
  assert.equal(json.includes('发件人被拒'), true, '要给出分类，不能只甩原始报错');
  assert.equal((json.match(/550 The/g) ?? []).length, 1, '原始报错不该在标题与正文里各写一遍');
});

test('渲染冒烟：授权码行给出「已保存 / 还没保存」与明文提示', async () => {
  const { json } = await renderPage();
  assert.equal(json.includes('SMTP 授权码'), true);
  assert.equal(json.includes('还没保存'), true);
  assert.equal(json.includes('不是登录密码'), true, '授权码不等同登录密码这件事要在原地说明');
});

test('渲染冒烟：凭据状态会被自动复检，页面不会停在「未配置」', async () => {
  const { credentialCalls } = await renderPage();
  assert.equal(credentialCalls >= 2, true, `应至少复检一次（首读 + 复检），实际 ${String(credentialCalls)}`);
});

// 「已就绪」这个形态在真机上要一份真的授权码才到得了，所以在这里把分支钉住：
// 判决句、下一步、读数、主按钮都必须跟着状态换，而不是换一条就被落下。
test('渲染冒烟：配齐之后判决条给「可以发信了」+ 主按钮 + 从没发过的读数', async () => {
  const { json } = await renderPage({
    credentialsConfigured: true,
    lastDelivery: null,
  });
  assert.equal(json.includes('可以发信了'), true, '配齐了就要直说可以发信');
  assert.equal(json.includes('配置齐了'), true, '判决句要给出下一步：先发一封测试邮件');
  assert.equal(json.includes('最近一次发送'), true, '从没发过也要占住读数那一行，避免结果出现时布局跳动');
  assert.equal(json.includes('还没有试过'), true);
  assert.equal(json.includes('发送测试邮件'), true, '已就绪时判决条要直接给出测试入口');
});

// 反面：上一次失败时，判决句、分类、原始报错三样都必须在，且原始报错只出现一次。
test('渲染冒烟：已就绪但上次失败，判决条说「上次发信失败」而不是「可以发信了」', async () => {
  const { json } = await renderPage({
    credentialsConfigured: true,
  });
  assert.equal(json.includes('上次发信失败'), true, '配置齐了但上次失败，判决要让位给失败');
  assert.equal(json.includes('可以发信了'), false, '不能一边报失败一边说可以发信');
  assert.equal(json.includes('重新测试'), true, '失败之后主按钮要变成「重新测试」');
});
