import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLedger, readLedger, resolveStatePath } from '../lib/state.js';

test('resolveStatePath：配置优先，其次 $DSH_HOME，最后 ~/.dsh', () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = '/tmp/fake-dsh-home';
  assert.equal(resolveStatePath('/custom/state.json'), '/custom/state.json');
  assert.equal(resolveStatePath(''), '/tmp/fake-dsh-home/dsh-notify-p/state.json');
  assert.equal(resolveStatePath('  '), '/tmp/fake-dsh-home/dsh-notify-p/state.json');
  delete process.env.DSH_HOME;
  assert.match(resolveStatePath(''), /\.dsh\/dsh-notify-p\/state\.json$/);
  if (previous !== undefined) process.env.DSH_HOME = previous;
});

test('账本：构造即落盘（文件不存在不能被误读成"插件没加载"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'state.json');
  const ledger = createLedger({ path });

  const initial = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(initial.version, 1);
  assert.deepEqual(initial.counts, { sent: 0, failed: 0 });
  assert.deepEqual(initial.recent, []);
});

test('账本：成功的投递计 sent，失败计 failed，且都可以从文件读回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const path = join(dir, 'state.json');
  const ledger = createLedger({ path });

  ledger.record({ at: 1, ok: true, outcome: 'completed', sessionId: 's1', subject: '主题', recipients: ['a@b.com'], transport: 'log' });
  ledger.record({ at: 2, ok: false, outcome: 'error', sessionId: 's2', error: '535 auth', errorCode: 'AUTH' });

  const disk = readLedger(path);
  assert.deepEqual(disk.counts, { sent: 1, failed: 1 });
  assert.equal(disk.recent.length, 2);
  assert.equal(disk.recent[0].subject, '主题');
  assert.equal(disk.recent[1].error, '535 auth');
  assert.equal(ledger.snapshot().counts.sent, 1);
});

test('账本：写不进去也不能抛（插件不能因为账本挂掉）', () => {
  // 把一个普通文件当目录用 → mkdirSync 立刻失败，且不会碰到沙箱边界
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const blocker = join(dir, 'blocker');
  writeFileSync(blocker, 'not a directory');
  const ledger = createLedger({ path: join(blocker, 'state.json') });
  assert.doesNotThrow(() => ledger.record({ at: 1, ok: true, outcome: 'completed', sessionId: 's1' }));
});

test('账本：环形缓冲有上限，不会无限增长', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const ledger = createLedger({ path: join(dir, 'state.json') });
  for (let i = 0; i < 80; i += 1) ledger.record({ at: i, ok: true, outcome: 'completed', sessionId: `s${i}` });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.recent.length, 50);
  assert.equal(snapshot.recent[0].sessionId, 's30');
  assert.equal(snapshot.counts.sent, 80);
});
