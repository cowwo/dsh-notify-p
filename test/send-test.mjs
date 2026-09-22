// dsh-notify-p · 命令行测试发送（真的发一封，不经过 DSH 运行进程）
//
// 为什么要有这个：设置页上的「发送测试邮件」依赖 Host Remote，而 typert 清单只在
// DSH **启动时**被扫描——刚装完/刚更新完必须先重启才点得到。这个脚本读同一份
// settings.yaml 与同一个凭据库，因此可以立刻验证"我这套 SMTP 到底通不通"。
//
// 用法：
//   node test/send-test.mjs                     # 用 $DSH_HOME/settings.yaml 里的配置真发一封
//   node test/send-test.mjs --to me@qq.com      # 临时换收件人
//   node test/send-test.mjs --dry-run           # 只打印会发什么、发给谁，不连网络
//   node test/send-test.mjs --transport smtp --smtp-host smtp.qq.com --smtp-user me@qq.com
//   node test/send-test.mjs --transport smtp,log    # 多通道：逗号分隔，勾到的都会发
//   node test/send-test.mjs --help
//
// 凭据解析顺序与插件运行时一致：环境变量 > $DSH_HOME/.credentials.yaml 的 refs。
// 它**不写投递账本**：正在运行的 DSH 进程持有内存账本，两边同时写只会互相覆盖。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { NAMESPACE, resolveConfig, smtpAccountHint, resolveTransports, TRANSPORTS } from '../lib/config.js';
import { checkSenderConfig } from '../lib/send/index.js';
import { sendTestMail } from '../lib/test-send.js';

const USAGE = `dsh-notify-p · 命令行测试发送

用法：node test/send-test.mjs [选项]

  --to <邮箱[,邮箱]>      收件人（覆盖配置里的 recipients）
  --transport <${TRANSPORTS.join('|')}>
                          可多选，逗号分隔（如 smtp,log）；勾到的都会发
  --smtp-host <主机>      --smtp-port <端口>   --smtp-secure <auto|tls|starttls|plain>
  --smtp-user <用户名>    --from <发件人地址>
  --sender-name <显示名>
  --dry-run               只打印将要发送的内容与目标，不连网络
  --json                  以 JSON 打印结果（便于脚本消费）
  --help

配置来源：$DSH_HOME/settings.yaml 的 ${NAMESPACE} 段（缺失则用 schema 默认值）。
凭据来源：环境变量，其次 $DSH_HOME/.credentials.yaml 的 refs。
`;

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数列表
 * @returns {{flags: object, unknown: string[]}} 解析结果
 */
export function parseArgs(argv) {
  const flags = { dryRun: false, json: false, help: false };
  const unknown = [];
  const take = (index) => (index + 1 < argv.length ? argv[index + 1] : undefined);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help': case '-h': flags.help = true; break;
      case '--dry-run': flags.dryRun = true; break;
      case '--json': flags.json = true; break;
      case '--to': flags.recipients = take(i); i += 1; break;
      case '--transport': flags.transport = take(i); i += 1; break;
      case '--smtp-host': flags.smtpHost = take(i); i += 1; break;
      case '--smtp-port': flags.smtpPort = Number(take(i)); i += 1; break;
      case '--smtp-secure': flags.smtpSecure = take(i); i += 1; break;
      case '--smtp-user': flags.smtpUser = take(i); i += 1; break;
      case '--from': flags.fromAddress = take(i); i += 1; break;
      case '--sender-name': flags.senderName = take(i); i += 1; break;
      default: unknown.push(arg); break;
    }
  }
  return { flags, unknown };
}

/** DSH home（与 lib/state.js 的规则一致）。 */
export function dshHome() {
  return typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

/**
 * 从 settings.yaml 里取本插件的段。
 * @param {string} [home] DSH home
 * @returns {object} 该段内容（读不到就是空对象）
 */
export function readSettingsSection(home = dshHome()) {
  try {
    const doc = parseYaml(readFileSync(join(home, 'settings.yaml'), 'utf8'));
    const section = doc?.[NAMESPACE];
    return section && typeof section === 'object' ? section : {};
  } catch {
    return {};
  }
}

/**
 * 读凭据库的 refs 段。
 * @param {string} [home] DSH home
 * @returns {Record<string, string>} 引用名到值
 */
export function readCredentialRefs(home = dshHome()) {
  try {
    const doc = parseYaml(readFileSync(join(home, '.credentials.yaml'), 'utf8'));
    const refs = doc?.refs;
    if (!refs || typeof refs !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(refs)) {
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 与插件运行时一致的凭据解析：环境变量优先，其次凭据库。
 * @param {string} ref 引用名
 * @param {Record<string, string>} refs 凭据库内容
 * @returns {string|undefined} 凭据值
 */
export function resolveCredentialFrom(ref, refs) {
  const key = typeof ref === 'string' ? ref.trim() : '';
  if (key === '') return undefined;
  const env = process.env[key];
  if (typeof env === 'string' && env !== '') return env;
  return refs[key];
}

/** 主流程。 */
async function main() {
  const { flags, unknown } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (unknown.length > 0) {
    process.stderr.write(`未知参数 / unknown flags: ${unknown.join(', ')}\n\n${USAGE}`);
    return 2;
  }

  const home = dshHome();
  const section = readSettingsSection(home);
  const overrides = {};
  for (const key of ['recipients', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'fromAddress', 'senderName']) {
    if (flags[key] !== undefined) overrides[key] = flags[key];
  }
  // 通道是新形态的数组；`--transport a,b` 只是给命令行省事的写法。
  if (flags.transport !== undefined) {
    overrides.transports = String(flags.transport).split(',').map((item) => item.trim()).filter((item) => item !== '');
  }
  const config = resolveConfig({ ...section, ...overrides });
  const channels = resolveTransports(config);

  const refs = readCredentialRefs(home);
  const credentialValues = [];
  if (channels.includes('resend')) credentialValues.push([config.resendApiKeyRef, resolveCredentialFrom(config.resendApiKeyRef, refs)]);
  if (channels.includes('smtp')) credentialValues.push([config.smtpPasswordRef, resolveCredentialFrom(config.smtpPasswordRef, refs)]);

  const logger = {
    info: (message) => { if (!flags.json) process.stdout.write(`${message}\n`); },
    warn: (message) => { if (!flags.json) process.stderr.write(`[warn] ${message}\n`); },
    debug: () => {},
  };

  if (!flags.json) {
    const recipientCount = config.recipients.trim() === '' ? 0 : 1;
    const issues = channels.flatMap((channel) => checkSenderConfig(config, recipientCount, channel));
    process.stdout.write('将要发送 / about to send:\n');
    process.stdout.write(`  通道 transports: ${channels.join(' + ')}\n`);
    if (channels.includes('smtp')) {
      process.stdout.write(`  主机 host      : ${config.smtpHost || '(空)'}:${config.smtpPort} (${config.smtpSecure})\n`);
      process.stdout.write(`  用户名 user    : ${config.smtpUser || '(空)'}\n`);
    }
    if (channels.includes('resend')) process.stdout.write(`  API 基址       : ${config.resendApiBase}\n`);
    process.stdout.write(`  收件人 to      : ${config.recipients.split(/[\n,;]+/).filter((x) => x.trim() !== '').join(', ') || '(空)'}\n`);
    for (const [ref, value] of credentialValues) {
      process.stdout.write(`  凭据 ${ref} : ${value === undefined ? '未找到（环境变量或凭据库都没有）' : `已找到（${value.length} 字符，不回显）`}\n`);
    }
    if (channels.length === 1 && channels[0] === 'log') process.stdout.write('  ⚠️ 通道是 log：不会真的发出邮件，只写日志\n');
    const accountHint = smtpAccountHint(config);
    if (accountHint !== '') process.stdout.write(`  ⚠️ ${accountHint}\n`);
    if (issues.length > 0) process.stdout.write(`  ⚠️ 配置问题：${issues.join('；')}\n`);
    process.stdout.write('\n');
  }

  if (flags.dryRun) {
    if (!flags.json) process.stdout.write('--dry-run：不连网络，结束。\n');
    else process.stdout.write(`${JSON.stringify({ dryRun: true, transports: channels, recipients: config.recipients }, null, 2)}\n`);
    return 0;
  }

  const result = await sendTestMail({
    config,
    logger,
    resolveCredential: (ref) => Promise.resolve(resolveCredentialFrom(ref, refs)),
    webUrl: process.env.DSH_WEB_URL,
  });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(`\n✅ 成功 / ok：${result.transport} → ${result.recipients.join(', ')}（${result.ms} 毫秒）\n`);
    process.stdout.write(`   主题：${result.subject}\n`);
    if (result.transport === 'log') process.stdout.write('   （log 通道只记账本与日志，邮箱里不会有邮件）\n');
  } else {
    process.stdout.write(`\n❌ 失败 / failed（${result.ms} 毫秒）\n   ${result.error}\n`);
  }
  return result.ok ? 0 : 1;
}

// 只在直接执行时跑 main，被 import 时（单测）不跑
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`意外错误 / unexpected: ${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
}
