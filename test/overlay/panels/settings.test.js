'use strict';
import { test, beforeEach, vi } from 'vitest';
import assert from 'node:assert';

let settings;

function setupGlobals() {
  const store = {};
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, style: {}, appendChild() {} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} },
  };
  globalThis.window = {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  return store;
}

beforeEach(async () => {
  vi.resetModules();
  setupGlobals();
  settings = await import('../../../src/overlay/panels/settings.js');
});

test('getSettingsData 返回默认值', () => {
  const d = settings.getSettingsData();
  assert.strictEqual(d.retryEnabled, true);
  assert.strictEqual(d.retryDelayMin, 4);
  assert.strictEqual(d.retryDelayMax, 10);
  assert.strictEqual(d.retryCount, 10);
  assert.strictEqual(d.retry429Delay, 120);
  assert.strictEqual(d.retry429Count, 40);
  assert.strictEqual(d.xhrIdleTimeout, 300);
  assert.strictEqual(d.watchdogCount, 3);
  assert.strictEqual(d.sendDelayMin, 10);
  assert.strictEqual(d.sendDelayMax, 20);
});

test('getSettingsData 从 localStorage 读取', () => {
  localStorage.setItem('cuckoo-retry-enabled', '0');
  localStorage.setItem('cuckoo-retry-delay-min', '5000');
  localStorage.setItem('cuckoo-retry-count', '3');
  const d = settings.getSettingsData();
  assert.strictEqual(d.retryEnabled, false);
  assert.strictEqual(d.retryDelayMin, 5);
  assert.strictEqual(d.retryCount, 3);
});

test('applySettingsData 校验：普通失败最小间隔非法被拒绝', async () => {
  const base = settings.getSettingsData();
  const r = await settings.applySettingsData({ ...base, retryDelayMin: -1 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /最小间隔/);
});

test('applySettingsData 校验：最大间隔小于最小被拒绝', async () => {
  const base = settings.getSettingsData();
  const r = await settings.applySettingsData({ ...base, retryDelayMin: 10, retryDelayMax: 5 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /最大间隔/);
});

test('applySettingsData 校验：重试次数非整数被拒绝', async () => {
  const base = settings.getSettingsData();
  const r = await settings.applySettingsData({ ...base, retryCount: 'abc' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /整数/);
});

test('applySettingsData 校验：AI 拦截正则非法被拒绝', async () => {
  const base = settings.getSettingsData();
  const r = await settings.applySettingsData({ ...base, aiInterceptPatterns: '[unclosed' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /正则非法/);
});

test('applySettingsData 校验：附件间隔最大超 60 秒被拒绝', async () => {
  const base = settings.getSettingsData();
  const r = await settings.applySettingsData({ ...base, attachDelayMin: 1, attachDelayMax: 61 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /60 秒/);
});

test('resetSettingsData 清空 localStorage 键并回到默认', async () => {
  localStorage.setItem('cuckoo-retry-enabled', '0');
  localStorage.setItem('cuckoo-retry-delay-min', '5000');
  const d = await settings.resetSettingsData();
  assert.strictEqual(localStorage.getItem('cuckoo-retry-enabled'), null);
  assert.strictEqual(localStorage.getItem('cuckoo-retry-delay-min'), null);
  assert.strictEqual(d.retryEnabled, true);
  assert.strictEqual(d.retryDelayMin, 4);
});

// ===== [定制-flash] 持续执行开关（本轮提醒 / 空闲自动唤醒） =====

test('getSettingsData：持续执行开关默认值与读取', () => {
  const d = settings.getSettingsData();
  assert.strictEqual(d.autoReminderEnabled, true);
  assert.strictEqual(d.autoWakeEnabled, true);
  assert.strictEqual(d.autoWakeDelay, 90);

  localStorage.setItem('cuckoo-round-reminder-enabled', '0');
  localStorage.setItem('cuckoo-auto-wake-enabled', '0');
  localStorage.setItem('cuckoo-auto-wake-delay', '30');
  const d2 = settings.getSettingsData();
  assert.strictEqual(d2.autoReminderEnabled, false);
  assert.strictEqual(d2.autoWakeEnabled, false);
  assert.strictEqual(d2.autoWakeDelay, 30);
});

test('applySettingsData：持续执行开关写回 localStorage', async () => {
  // 去掉"存在主进程"的池字段（测试环境无 IPC 桥，写共享设置会失败，与本用例无关）
  const payload = { ...settings.getSettingsData() };
  for (const k of [
    'jsResultPhrases', 'jsResultItemTemplates', 'continuePrompt',
    'readHeaderFull', 'readHeaderPartial',
    'readFooterFull', 'readFooterPartial', 'readFooterCapped',
    'globFooterFull', 'globFooterTruncated',
    'writeFooterCreate', 'writeFooterUpdate',
  ]) delete payload[k];
  const r = await settings.applySettingsData({ ...payload, autoReminderEnabled: false, autoWakeEnabled: true, autoWakeDelay: 45 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(localStorage.getItem('cuckoo-round-reminder-enabled'), '0');
  assert.strictEqual(localStorage.getItem('cuckoo-auto-wake-enabled'), '1');
  assert.strictEqual(localStorage.getItem('cuckoo-auto-wake-delay'), '45');
});

test('applySettingsData 校验：唤醒延迟非法被拒绝', async () => {
  const base = settings.getSettingsData();
  const r = await settings.applySettingsData({ ...base, autoWakeDelay: 0 });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /唤醒延迟/);
});
