/**
 * 覆盖层按钮事件绑定（编排层）
 * P4.5 拆分：窗口面板 → panels/window-manager、MCP 面板 → panels/mcp-manager、
 * 设置弹窗 → panels/settings、悬浮球拖动 → fab.js。
 */
import { state } from './state.js';
import { hideOverlay, showOverlay, renderHistory, commandHistory, showToast, hideFirstTimeDialog } from './panel.js';
import { handleInitProject, renderSessions } from './session-list.js';
import { sendToChat } from './chat-input.js';
// [定制-flash] 框架驱动时间窗：判断"页面上的点击/按键是否来自框架自身"（叶子模块）
import { isFrameworkDriving } from '../infra/framework-driving.js';
import { runCompaction, checkPendingCompact, checkPendingInit, checkPendingSwitch } from '../session/compaction.js';
import { renderWindowList, openWindowManager, closeWindowManager, handleGenerateDoc } from './panels/window-manager.js';
import { loadMcpConfigToJson, renderMcpList, openMcpManager, closeMcpManager, handleMcpSave } from './panels/mcp-manager.js';

import { makeFabDraggable } from './fab.js';

import { buildContinueMessage } from '../infra/continue-prompt-pool.js';
import { getProviderByUrl } from '../providers/registry.js';
import { createTpsMeter, formatTps } from './tps.js';

// 回调注入（P4.2-A：overlay 不依赖 bridge）
let hooks: {
  onInterceptedResponse?: (cb: (text: string, meta: any) => void) => void;
  onTaskIdle?: (cb: () => void) => void;
  onStream?: (cb: (ev: any) => void) => void;
} = {};
// 服务端权威 token 统计（由 bridge 经回调推送，不共享状态）
let serverTokenUsage: any = null;

// ========== 输出速度（TPS）估算 ==========
// 服务端不给单轮输出 token，只能用流式正文长度估算（见 tps.ts）
const tpsMeter = createTpsMeter();
// 避免高频 IPC：同一展示值不重复推送
let lastPushedTps = '';

/**
 * 把当前 TPS 推送给壳页面状态栏。
 * 生成中实时更新；**生成结束后保留本轮最终速度**（不清零），
 * 直到下一轮生成开始才被新值覆盖。无任何数据时推空串（壳页面显示 "--"）。
 */
function pushTps(): void {
  const text = tpsMeter.value > 0 ? formatTps(tpsMeter.value) : '';
  if (text === lastPushedTps) return;
  lastPushedTps = text;
  try {
    (window as any).electronAPI.updateTps(text).catch(() => {});
  } catch (_) {}
}

// ========== 对话 token 按会话缓存 ==========
const TOKEN_CACHE_KEY = 'cuckoo-token-cache';
// 按天累计（保留所有历史，供后续统计）
const TOKEN_DAILY_KEY = 'cuckoo-token-daily';
// 每日统计口径版本：
//  v1 = 累加完整 acc 但无限膨胀（错误）
//  v2 = 累加 delta（跨天会漏算，与预期不符）
//  v3 = 每天累加"当轮完整 acc"（今天每轮的总量之和，跨天归零）
const DAILY_VERSION_KEY = 'cuckoo-token-daily-version';
const DAILY_VERSION = '3';

/** 是否子代理窗口（由 bridge 注入）。子代理共享父窗口 localStorage，不应参与 token 统计 */
let isSubagentWindow = false;
function setIsSubagentWindow(v: boolean): void { isSubagentWindow = !!v; }

/** 旧口径数据迁移：v1 的今日值是"完整 acc 之和"（会膨胀），不可比，检测到就清空重来 */
function migrateDailyVersion(): void {
  try {
    if (localStorage.getItem(DAILY_VERSION_KEY) !== DAILY_VERSION) {
      localStorage.removeItem(TOKEN_DAILY_KEY);
      localStorage.setItem(DAILY_VERSION_KEY, DAILY_VERSION);
    }
  } catch (_) {}
}

/** 取本地日期字符串 YYYY-MM-DD */
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/** 某天累加 token（传入"当轮完整 acc"） */
function addDailyToken(delta: number): void {
  if (typeof delta !== 'number' || delta <= 0) return;
  try {
    const raw = localStorage.getItem(TOKEN_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const map = (obj && typeof obj === 'object') ? obj : {};
    const k = todayKey();
    map[k] = (typeof map[k] === 'number' ? map[k] : 0) + delta;
    localStorage.setItem(TOKEN_DAILY_KEY, JSON.stringify(map));
  } catch (_) {}
}

/** 今日累计消耗（今天新消耗的 token；跨天归零） */
function getTodayCumulative(): number {
  try {
    migrateDailyVersion();
    const raw = localStorage.getItem(TOKEN_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const v = obj ? obj[todayKey()] : 0;
    return typeof v === 'number' ? v : 0;
  } catch (_) {
    return 0;
  }
}

/** 近 N 日的每日用量（升序，含今天；缺失日补 0） */
function getRecentDaily(days: number): Array<{ date: string; value: number }> {
  try {
    migrateDailyVersion();
    const raw = localStorage.getItem(TOKEN_DAILY_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const map = (obj && typeof obj === 'object') ? obj : {};
    const out: Array<{ date: string; value: number }> = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const key = y + '-' + m + '-' + day;
      const v = typeof map[key] === 'number' ? map[key] : 0;
      out.push({ date: key, value: v });
    }
    return out;
  } catch (_) {
    return [];
  }
}

/** 取当前页面对应的会话 ID（无则 null） */
function getCurrentSessionId(): string | null {
  try {
    const provider = getProviderByUrl(window.location.href);
    if (provider && typeof provider.extractSessionId === 'function') {
      return provider.extractSessionId(window.location.href) || null;
    }
  } catch (_) {}
  return null;
}

/** 单个会话的 token 数据 */
interface SessionToken {
  /** 当前上下文总量（最新 accumulated） */
  context: number;
  /** 累计消耗（各轮回复结束时的 accumulated 之和） */
  cumulative: number;
  /** 上次记录的 accumulated（用于去重/判断是否新增一轮） */
  lastAcc: number;
}

/** 读整个 token 缓存（sessionId → SessionToken） */
function readTokenCache(): Record<string, SessionToken> {
  try {
    const raw = localStorage.getItem(TOKEN_CACHE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) {
    return {};
  }
}

/**
 * 记录某会话的当前上下文 token，并累加累计消耗。
 * 累计消耗 = 各轮回复结束时的 accumulated 之和
 *（DeepSeek 每轮都把完整历史作为 prompt 重发，故每轮实际处理的 token ≈ 当轮 accumulated）。
 * 仅在 acc 相比上次增大时才累加，避免同一轮重复事件重复计数。
 */
function saveTokenForSession(sessionId: string, acc: number): void {
  if (!sessionId || typeof acc !== 'number') return;
  try {
    const cache = readTokenCache();
    let entry: any = cache[sessionId];
    // 兼容旧格式（数字）
    if (typeof entry === 'number') entry = { context: entry, cumulative: entry, lastAcc: entry };
    if (!entry || typeof entry !== 'object') entry = { context: 0, cumulative: 0, lastAcc: 0 };
    const lastAcc = typeof entry.lastAcc === 'number' ? entry.lastAcc : 0;
    if (acc > lastAcc) {
      // 窗口累计：累加"当轮完整上下文"（DeepSeek 每轮都重发完整历史）
      entry.cumulative = (typeof entry.cumulative === 'number' ? entry.cumulative : 0) + acc;
      // 今日窗口：累加"当轮完整 acc"（今天每轮的总量之和）；跨天由 todayKey() 天然归零
      addDailyToken(acc);
    }
    entry.context = acc;
    entry.lastAcc = acc;
    cache[sessionId] = entry;
    // 限制缓存条数，避免无限增长（保留最近 200 个）
    const keys = Object.keys(cache);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete cache[k];
    }
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

/** 窗口累计：本窗口所有会话的累计消耗之和（localStorage 按 partition 隔离，天然是本窗口的） */
function getWindowCumulative(): number {
  try {
    const cache = readTokenCache();
    let sum = 0;
    for (const k of Object.keys(cache)) {
      const e: any = cache[k];
      if (typeof e === 'number') sum += e;
      else if (e && typeof e.cumulative === 'number') sum += e.cumulative;
    }
    return sum;
  } catch (_) {
    return 0;
  }
}

/** 取某会话的 token 数据（兼容旧格式） */
function getTokenForSession(sessionId: string | null): { context: number; cumulative: number } {
  if (!sessionId) return { context: 0, cumulative: 0 };
  const entry: any = readTokenCache()[sessionId];
  if (typeof entry === 'number') return { context: entry, cumulative: entry };
  if (entry && typeof entry === 'object') {
    return {
      context: typeof entry.context === 'number' ? entry.context : 0,
      cumulative: typeof entry.cumulative === 'number' ? entry.cumulative : 0,
    };
  }
  return { context: 0, cumulative: 0 };
}
/** 由 bridge/entry 在初始化时注入 bridge 能力 */
function wireEvents(h: typeof hooks): void {
  hooks = h;
}

let eventsBound = false;

/**
 * 「刷新技能与代理」按钮：让主进程重新扫描技能 + 代理目录，把最新清单发给 AI
 */
async function handleSendSkills() {
  const api = (window as any).electronAPI;
  if (!api || !api.refreshSkills) {
    showToast('接口不可用', 3000);
    return;
  }
  try {
    const result = await api.refreshSkills();
    if (!result || !result.success) {
      showToast('获取清单失败: ' + ((result && result.error) || '未知错误'), 3000);
      return;
    }
    const section = result.section || '';
    if (!section.trim()) {
      showToast('没有找到任何技能或代理', 3000);
      return;
    }
    // 注意：sendToChat 是 async，必须 await，否则恒为真值、误报成功
    const ok = await sendToChat(section, '技能与代理清单', 300);
    if (!ok) {
      showToast('发送失败：未找到输入框', 3000);
      return;
    }
    showToast('已发送（技能 ' + (result.skillCount || 0) + ' 个 / 代理 ' + (result.agentCount || 0) + ' 个）', 2500);
  } catch (e: any) {
    showToast('发送失败: ' + e.message, 3000);
  }
}

/**
 * 「卡住了?点我」按钮：向 AI 发一句继续，催促其接着之前的工作
 */
async function handleManualParseDispatch() {
  // [定制-flash] 用带出口的版本：用户点"我卡住了"时，AI 大概率真的卡住了，
  // 回一句裸的"接着干"正好把它推回穷举扫描。带出口后缀后它能选"说明卡点"。
  if (!(await sendToChat(buildContinueMessage(), '继续', 300))) {
    showToast('发送失败：未找到输入框', 3000);
    return;
  }
  showToast('已发送：继续', 2500);
}

/**
 * 格式化 token 数：过万显示为「xxx万」，否则原样显示
 */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 10000) {
    return (n / 10000).toFixed(2) + '万';
  }
  return String(Math.round(n));
}

/**
 * 刷新面板里的「对话 Token」显示
 * 数据来源：服务端 accumulated_token_usage（含 prompt+输出）；未收到时显示 0。
 */
function updateConversationTokenDisplay() {
  const countEl = document.getElementById('cuckoo-conv-token-count');
  // 优先用"当前会话"的缓存值（切会话/刷新后仍能显示该会话的 token）
  const sid = getCurrentSessionId();
  const cached = sid ? getTokenForSession(sid) : { context: 0, cumulative: 0 };
  const context = (cached.context > 0)
    ? cached.context
    : (serverTokenUsage && typeof serverTokenUsage.accumulatedTokens === 'number' ? serverTokenUsage.accumulatedTokens : 0);
  const cumulative = cached.cumulative || 0;

  if (countEl) countEl.textContent = formatTokenCount(context);

  // 同步到壳页面状态条（地址栏下方）：上下文 + 对话累计 + 窗口累计 + 今日累计 + 近 10 日
  try {
    (window as any).electronAPI.updateTokenUsage(
      context, cumulative, getWindowCumulative(), getTodayCumulative(), getRecentDaily(10)
    ).catch(() => {});
  } catch (_) {}
}

/** 供 bridge 在 URL 变化时调用：刷新当前会话的 token 显示 */
function refreshTokenForCurrentSession(): void {
  updateConversationTokenDisplay();
}

// ========== 上下文策略（三选一：off / compact / new-chat）==========
// off       = 关闭
// compact   = 自动压缩（保留摘要，原功能）
// new-chat  = 自动开启新对话（不压缩，靠「项目进度」文件夹承接上下文）
type ContextMode = 'off' | 'compact' | 'new-chat';
let contextMode: ContextMode = 'off';
let autoCompactThresholdWan = 80;
// 防止触发过程中重复触发
let autoCompactTriggering = false;

// ========== 「项目进度维护引导」待注入 ==========
// 保存 new-chat 时只建文件夹、不发消息（此时用户可能还没发布任务）。
// 设置本标志；等用户发消息、AI 完成一轮回复后，注入一次维护引导再清除。
const PENDING_PROGRESS_KEY = 'cuckoo-pending-progress-guide';
function readPendingProgressGuide(): string | null {
  try { return localStorage.getItem(PENDING_PROGRESS_KEY); } catch (_) { return null; }
}
function setPendingProgressGuide(folder: string): void {
  try { localStorage.setItem(PENDING_PROGRESS_KEY, folder || ''); } catch (_) {}
}
function clearPendingProgressGuide(): void {
  try { localStorage.removeItem(PENDING_PROGRESS_KEY); } catch (_) {}
}
// 已引导过的项目目录集合：同一目录只引导一次，避免"改阈值保存"重复注入引导。
const GUIDED_DIRS_KEY = 'cuckoo-progress-guided-dirs';
function readGuidedDirs(): string[] {
  try {
    const raw = localStorage.getItem(GUIDED_DIRS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function hasGuidedDir(dir: string): boolean {
  return readGuidedDirs().indexOf(dir) !== -1;
}
function markGuidedDir(dir: string): void {
  try {
    const arr = readGuidedDirs();
    if (arr.indexOf(dir) === -1) {
      arr.push(dir);
      localStorage.setItem(GUIDED_DIRS_KEY, JSON.stringify(arr));
    }
  } catch (_) {}
}

// ========== 「任务空闲」等待器 ==========
// 自动开启新对话时，需"先让 AI 更新进度、等它写完"再开新对话。
// onTaskIdle 是注册式回调，这里提供 Promise 化的"等下一次空闲"。
let taskIdleWaiters: Array<() => void> = [];
function waitForNextTaskIdle(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      taskIdleWaiters = taskIdleWaiters.filter((w) => w !== fire);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      taskIdleWaiters = taskIdleWaiters.filter((w) => w !== fire);
      resolve(false); // 超时
    }, timeoutMs);
    taskIdleWaiters.push(fire);
  });
}
function resolveTaskIdleWaiters(): void {
  const ws = taskIdleWaiters;
  taskIdleWaiters = [];
  for (const w of ws) { try { w(); } catch (_) { /* ignore */ } }
}

/** 读 localStorage 中的上下文策略（含旧配置迁移） */
function readContextMode(): ContextMode {
  let mode: string | null = null;
  try { mode = localStorage.getItem('cuckoo-context-mode'); } catch (_) {}
  if (mode === 'off' || mode === 'compact' || mode === 'new-chat') return mode;
  // 旧配置迁移：cuckoo-auto-compact-enabled === '1' → compact
  try {
    if (localStorage.getItem('cuckoo-auto-compact-enabled') === '1') return 'compact';
  } catch (_) {}
  return 'off';
}

/** 从 localStorage 读取上下文策略配置并同步到 UI */
function loadAutoCompactConfig() {
  try {
    const th = localStorage.getItem('cuckoo-auto-compact-threshold');
    contextMode = readContextMode();
    // 同样避免 "parseFloat() || 80"（0 会被丢弃）
    if (th !== null) { const v = parseFloat(th); if (Number.isFinite(v) && v > 0) autoCompactThresholdWan = v; }
  } catch (_) {}
  const modeEls = document.querySelectorAll('input[name="tk-context-mode"]') as any;
  modeEls.forEach((el: any) => { el.checked = (el.value === contextMode); });
  const thEl = document.getElementById('cuckoo-auto-compact-threshold');
  if (thEl) (thEl as any).value = autoCompactThresholdWan;
}

/** 读取 UI 中选中的上下文策略 */
function getSelectedContextMode(): ContextMode {
  const el = document.querySelector('input[name="tk-context-mode"]:checked') as any;
  const v = el ? el.value : 'off';
  return (v === 'compact' || v === 'new-chat') ? v : 'off';
}

/** 保存上下文策略配置 */
function saveAutoCompactConfig() {
  const mode = getSelectedContextMode();
  const thEl = document.getElementById('cuckoo-auto-compact-threshold');
  let th = thEl ? parseFloat((thEl as any).value) : 80;
  if (!Number.isFinite(th) || th <= 0) {
    showToast('阈值需为正数（万）', 3000);
    return;
  }
  contextMode = mode;
  autoCompactThresholdWan = th;
  try {
    localStorage.setItem('cuckoo-context-mode', mode);
    localStorage.setItem('cuckoo-auto-compact-threshold', String(th));
    // 兼容旧键：compact 时置 '1'，否则置 '0'
    localStorage.setItem('cuckoo-auto-compact-enabled', mode === 'compact' ? '1' : '0');
  } catch (_) {}
  const modeLabel = mode === 'compact' ? '自动压缩' : (mode === 'new-chat' ? '自动开启新对话' : '关闭');
  showToast('上下文策略已保存：' + modeLabel + '，阈值 ' + th + ' 万', 2500);
}

/**
 * 检查是否触发上下文策略（压缩 / 开新对话）
 * 数据源：state.serverTokenUsage.accumulatedTokens
 */
function checkAutoCompact() {
  const mode = readContextMode();
  contextMode = mode; // 同步内存变量
  if (mode === 'off' || autoCompactTriggering) return;
  const server = serverTokenUsage;
  if (!server || typeof server.accumulatedTokens !== 'number') return;
  let thresholdWan = autoCompactThresholdWan;
  try {
    const th = localStorage.getItem('cuckoo-auto-compact-threshold');
    if (th !== null) { const v = parseFloat(th); if (Number.isFinite(v) && v > 0) thresholdWan = v; }
  } catch (_) {}
  const thresholdTokens = thresholdWan * 10000;
  if (server.accumulatedTokens < thresholdTokens) return;
  // 触发
  autoCompactTriggering = true;
  if (mode === 'new-chat') {
    console.log('[Cuckoo NewChat] 自动触发：当前 ' + server.accumulatedTokens + ' >= 阈值 ' + thresholdTokens);
    showToast('Token 超阈值（' + autoCompactThresholdWan + '万），先更新进度再开启新对话...', 4000);
    // 先让 AI 把当前进度落盘到「项目进度」文件，再开新对话（超时则照常开）
    flushProgressThenNewChat().finally(() => {
      // 成功会跳转页面（变量随页面重载重置）；失败则重置标志允许下次重试
      autoCompactTriggering = false;
    });
  } else {
    console.log('[Cuckoo Compact] 自动触发：当前 ' + server.accumulatedTokens + ' >= 阈值 ' + thresholdTokens);
    showToast('Token 超阈值（' + autoCompactThresholdWan + '万），自动压缩中...', 4000);
    runCompaction(state.currentProjectDir || undefined).finally(() => {
      // 压缩会跳转页面；若未跳转（失败），重置标志允许下次重试
      autoCompactTriggering = false;
    });
  }
}

/**
 * 自动开启新对话前：先让 AI 把当前进度落盘到「项目进度」文件，等它写完再开新对话。
 * - 未选项目目录：直接开新对话（无进度文件可更新）
 * - 超时（默认 3 分钟）：照常开新对话（不能因更新失败把用户卡死）
 */
const FLUSH_PROGRESS_TIMEOUT_MS = 300000;

/**
 * 拼接路径（渲染进程不可用 node:path，统一用正斜杠，Windows 亦可识别）
 * @param dir 目录
 * @param name 文件名
 * @returns 拼接后的路径
 */
function joinFsPath(dir: string, name: string): string {
  return String(dir).replace(/[\\/]+$/, '') + '/' + name;
}

async function flushProgressThenNewChat(): Promise<void> {
  const projectDir = state.currentProjectDir;
  // 无项目目录：没有进度文件可更新，直接开新对话
  if (!projectDir) {
    await triggerNewChatWithProgress();
    return;
  }
  const folder = joinFsPath(projectDir, '项目进度');
  // 清除可能残留的"待注入引导"标志：本次归档指令已覆盖其作用，避免 AI 回复后重复注入
  clearPendingProgressGuide();
  try {
    console.log('[Cuckoo NewChat] 先发指令让 AI 更新进度文件，再开新对话');
    showToast('正在让 AI 更新项目进度文件...', 4000);
    const msg =
      '【自动开启新对话前的进度归档】' + String.fromCharCode(10) +
      '当前对话即将因上下文过长而开启新对话，新对话只能看到「项目进度/STATUS.md」。请现在按「收尾」规则归档（只改下面这些，别的不用动）：' + String.fromCharCode(10) +
      '1. **整份覆盖 STATUS.md**（≤ 80 行）：写清 正在做 / 做到哪了 / 下一步（具体到文件或函数）；本对话已完成的待办直接删除；新踩的坑写进「已知的坑」。' + String.fromCharCode(10) +
      '2. **挂起**：用户要求暂缓/放弃的任务移到 STATUS.md 的「已挂起」并写明原因。' + String.fromCharCode(10) +
      '3. **LOG.md 追加一行**：- YYYY-MM-DD 本对话完成了什么（不要先读 LOG.md）；有重要选择才往 DECISIONS.md 追加一行。' + String.fromCharCode(10) +
      '4. 不写交接笔记；总目标没变就不要改 GOAL.md。' + String.fromCharCode(10) +
      '规则详见 ' + joinFsPath(folder, 'RULES.md') + '（系统提示词里已有「## 项目进度」就不用再读）。' + String.fromCharCode(10) +
      '**注意：你必须真实调用文件写入工具来更新上述文件，仅仅口头回复“进度已更新”不算完成。**' + String.fromCharCode(10) +
      '真实更新完成后，回复一句"进度已更新"即可。';

    let sent = false;
    let waitIdleResolve: (val: boolean) => void = () => {};
    const waitIdlePromise = new Promise<boolean>((resolve) => { waitIdleResolve = resolve; });

    // 重试机制：最多 5 次，每次间隔 10 秒
    for (let attempt = 1; attempt <= 5; attempt++) {
      const ok = await sendToChat(msg, '系统提示词', undefined, () => {
        // 消息真正投递后，延迟 1 秒再注册任务空闲监听。
        // 这样可以漏掉发送瞬间可能产生的残留 idle 信号，防止“秒跳转”
        setTimeout(() => {
          waitForNextTaskIdle(FLUSH_PROGRESS_TIMEOUT_MS).then(waitIdleResolve);
        }, 1000);
      });

      if (ok) {
        sent = true;
        break;
      }
      console.log(`[Cuckoo NewChat] 进度归档指令发送失败，10秒后重试 (第 ${attempt}/5 次)...`);
      showToast(`归档指令发送失败，10秒后重试 (${attempt}/5)`, 3000);
      if (attempt < 5) {
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    if (!sent) {
      console.error('[Cuckoo NewChat] 连续 5 次发送归档指令失败，中止自动新对话');
      showToast('归档指令发送失败，已中止自动新对话，请检查页面是否正常', 5000);
      return; // 中止，不跳转
    }

    const finished = await waitIdlePromise;
    console.log('[Cuckoo NewChat] 进度更新' + (finished ? '完成，开新对话' : '等待超时（照常开新对话）'));
    if (!finished) showToast('进度更新超时，仍将开启新对话', 4000);
  } catch (err: any) {
    console.error('[Cuckoo NewChat] 更新进度失败，照常开新对话:', err && err.message);
  }
  await triggerNewChatWithProgress();
}

/**
 * 触发「自动开启新对话」：调主进程 IPC，创建/校验项目进度文件夹并开新对话。
 * 若未选项目目录，则提示并放弃。
 */
async function triggerNewChatWithProgress(): Promise<void> {
  const projectDir = state.currentProjectDir;
  if (!projectDir) {
    showToast('未选择项目目录，无法自动开启新对话（请先初始化项目）', 5000);
    return;
  }
  const api = (window as any).electronAPI;
  if (!api || typeof api.newConversationWithProgress !== 'function') {
    showToast('当前环境不支持自动开启新对话', 4000);
    return;
  }
  try {
    const r = await api.newConversationWithProgress(projectDir);
    if (r && r.success) {
      const tip = r.created
        ? '项目位置已有：项目进度 文件夹（本次新建：' + ((r.createdFiles || []).join('、') || '目录结构') + '）'
        : '项目位置已有：项目进度 文件夹';
      showToast(tip, 5000);
    } else {
      showToast('自动开启新对话失败：' + ((r && r.error) || '未知错误'), 5000);
    }
  } catch (err: any) {
    showToast('自动开启新对话失败：' + (err.message || err), 5000);
  }
}

/**
 * 若存在"待注入的进度维护引导"，则注入一次并清除。
 * 触发时机：用户发消息、AI 完成一轮回复后（onTaskIdle）。
 * 此时用户已发布任务，引导 AI 把总目标写进 GOAL.md 才有意义。
 */
async function maybeInjectProgressGuide(): Promise<void> {
  const folder = readPendingProgressGuide();
  if (!folder) return;
  clearPendingProgressGuide(); // 先清除，避免重复注入
  try {
    const msg =
      '【项目进度文件夹已启用】' + String.fromCharCode(10) +
      '项目目录下已有「项目进度」文件夹：' + folder + String.fromCharCode(10) +
      '请从本次对话的上下文里判断总目标，并开始维护以下文件（规则详见 ' + joinFsPath(folder, 'RULES.md') + '，请先读一遍）：' + String.fromCharCode(10) +
      '- GOAL.md：最开始的完整目标（原始需求尽量一字不差 / 交付物 / 验收标准 / 不做什么）' + String.fromCharCode(10) +
      '- STATUS.md：当前状态（里程碑 / 当前任务 / 下一步 / 待办 / 已知的坑 / 项目速查），完成一项待办就整份覆盖' + String.fromCharCode(10) +
      '- LOG.md：每完成一项追加一行流水（只写不读）' + String.fromCharCode(10) +
      '- DECISIONS.md：重要决策，每条一行' + String.fromCharCode(10) +
      '注意：GOAL.md 记的是**最开始那个完整目标**，不要用后续的零散选择/确认去覆盖它；' +
      '方案选择、技术决策请记到 DECISIONS.md。' + String.fromCharCode(10) +
      '若本对话目前还没有明确任务，就先别写，等任务明确了再记录。';
    const ok = await sendToChat(msg, '系统提示词');
    if (!ok) {
      // [定制-flash] 修复 P1：投递失败必须把"待注入"标志放回去，
      // 否则引导永久丢失（旧实现先 clear 再 send，失败只打日志）。
      setPendingProgressGuide(folder);
      console.warn('[Cuckoo Code] 注入进度维护引导失败（消息未投递），已恢复待注入标志: ' + folder);
      return;
    }
    markGuidedDir(folder); // 记下：该目录已引导过，改阈值保存时不再重复注入
    console.log('[Cuckoo Code] 已注入进度维护引导并标记: ' + folder);
  } catch (err: any) {
    // 同上：异常时也要恢复标志，避免引导丢失
    setPendingProgressGuide(folder);
    console.error('[Cuckoo Code] 注入进度维护引导失败，已恢复待注入标志:', err && err.message);
  }
}

// ========== [定制-flash] 空闲自动唤醒 ==========
// 背景：AI 一轮回复结束（任务空闲）后常"卡住等用户"。若空闲超过 N 秒仍无动作，
// 自动发一条唤醒探针（要求 AI 先输出一行 log 证明 + 继续之前的工作）。
// 默认只对 chatgpt 生效；连续 3 次唤醒后 AI 仍未继续工作则自动停用，避免刷屏烧钱。
const AUTO_WAKE_ENABLED_KEY = 'cuckoo-auto-wake-enabled';
const AUTO_WAKE_PROVIDERS_KEY = 'cuckoo-auto-wake-providers';
const AUTO_WAKE_DELAY_KEY = 'cuckoo-auto-wake-delay';
const AUTO_WAKE_MAX_KEY = 'cuckoo-auto-wake-max';

/** 自动唤醒配置（delayMs 已由"秒"换算为毫秒） */
interface AutoWakeConfig {
  /** 是否启用（localStorage '0' = 关闭；默认启用） */
  enabled: boolean;
  /** 生效平台白名单（provider id，小写；默认仅 chatgpt） */
  providers: string[];
  /** 空闲多久后唤醒（毫秒） */
  delayMs: number;
  /** 最多连续唤醒次数；-1 = 无限 */
  maxCount: number;
}

/** 待触发的唤醒定时器（null = 无） */
let autoWakeTimer: any = null;
/** 已成功发出的唤醒次数（用户主动操作后归零） */
let autoWakeCount = 0;
/** 连续"无效"唤醒次数（AI 未继续输出 cuckoo 代码块） */
let autoWakeInvalidCount = 0;
/** 是否已停止自动唤醒（达上限 / 连续无效） */
let autoWakeStopped = false;
/** 安排唤醒时所在的会话 ID：90 秒窗口内切了会话就不该把探针灌到新会话 */
let autoWakeSessionId: string | null = null;

/**
 * 读取自动唤醒配置（全部来自 localStorage，渲染进程不碰 node:fs）。
 * @returns 归一化后的配置；任何异常都退回默认值
 */
function readAutoWakeConfig(): AutoWakeConfig {
  const cfg: AutoWakeConfig = { enabled: true, providers: ['chatgpt'], delayMs: 90000, maxCount: 20 };
  try {
    if (localStorage.getItem(AUTO_WAKE_ENABLED_KEY) === '0') cfg.enabled = false;
  } catch (_) { /* 读不到按默认开启 */ }
  try {
    const raw = localStorage.getItem(AUTO_WAKE_PROVIDERS_KEY);
    if (typeof raw === 'string' && raw.trim()) {
      const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => !!s);
      if (list.length > 0) cfg.providers = list;
    }
  } catch (_) { /* 用默认白名单 */ }
  try {
    const raw = localStorage.getItem(AUTO_WAKE_DELAY_KEY);
    // 注意：不能用 "parseInt() || 90"——0 是有效值（虽无意义），会被 || 丢弃
    if (raw !== null) {
      const sec = parseInt(raw, 10);
      if (Number.isFinite(sec) && sec > 0) cfg.delayMs = sec * 1000;
    }
  } catch (_) { /* 用默认延迟 */ }
  try {
    const raw = localStorage.getItem(AUTO_WAKE_MAX_KEY);
    if (raw !== null) {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) cfg.maxCount = n; // -1 = 无限
    }
  } catch (_) { /* 用默认上限 */ }
  return cfg;
}

/** 当前页面 provider id（小写）；识别不到返回空串 */
function currentProviderId(): string {
  try {
    const p = getProviderByUrl(window.location.href);
    return p && p.id ? String(p.id).toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

/** 取消待触发的唤醒（已发出/已计数的不受影响） */
function cancelAutoWake(): void {
  if (autoWakeTimer) {
    clearTimeout(autoWakeTimer);
    autoWakeTimer = null;
    console.log('[Cuckoo AutoWake] 已取消待触发的自动唤醒');
  }
}

/** 生成 8 位随机 id（小写字母 + 数字），用于探针消息配对 */
function makeWakeId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

/**
 * 构造唤醒探针消息（复刻参考实现文案）。
 * @param id 本轮 8 位随机 id
 * @returns 探针消息文本
 */
function buildWakeUpMessage(id: string): string {
  const nl = String.fromCharCode(10);
  const fence = String.fromCharCode(96).repeat(3);
  // [定制-flash] 结构：先判定、再分支（三分支）。
  // 旧版把「直接接着做」写成全局无条件祈使句放在最前，后面的例外句会被忽略；
  // 且收尾句「如果你已经完成了所有工作」与"没有任务"是两个不同条件（空项目里
  // AI 一件活没干，不满足"已完成所有工作"），出口被稀释。
  // 现改为第 0 步三选一判定，每个终止分支都明确阻断后续阅读。
  // 第三分支「已陷入技术障碍」来自真实事故：AI 面对压缩混淆代码时无停止出口，
  // 只能对同一文件做 6 遍结构相同的扫描（58 次 read、同一行连读 4 次）、23 次唤醒不收敛。
  // 「所有任务已完成」在整条消息中只出现 1 次 —— handleResponseForAutoWake 靠它立即停用。
  return '【Cuckoo 自动唤醒·' + id + '】' + nl +
    '你是 Cuckoo 执行者，代码块会被自动执行。' + nl + nl +
    // [任务范围自检] 事故起点：用户只说"分析"，AI 分析出问题后自己决定"修复"，
    // 然后卡在压缩代码里穷举扫描。范围约束必须独立于"有没有任务"这个判定。
    '第 0 步之前先自检：你接下来要做的动作，是否在用户原话要求的范围内？' +
    '若已超出（例如用户只说"分析"你却要改文件），按【受阻停下】处理并说明需要授权。' + nl + nl +
    '第 0 步·先判定你当前处于哪种状态：' + nl +
    '- 没有用户提出的具体任务 → 只回复一行「所有任务已完成」，不要输出任何 cuckoo 代码块，不要去找项目，' +
    '不要向上级目录或盘符根目录搜索，不要自己给自己派活。到此结束，不要读下面的内容。' + nl +
    // 门槛与 chat-input.ts、chatgpt.md 保持 AND 语义（三处必须一致，否则模型按最宽松的走）。
    '- 有任务但已陷入技术障碍（代码压缩混淆无法定位、工具反复截断、缺信息；**且**同一方法已尝试 ≥3 次、' +
    '连续 3 次无实质进展）→ ' +
    '不要再调用工具，用纯文本列出：卡点是什么、已试过哪些方法、需要用户提供什么。' +
    // 【受阻停下】是与「所有任务已完成」同级的**固定协议字面**，状态机靠它立即停用唤醒。
    // 必须唯一写法、不能有多种变体，否则 handleResponseForAutoWake 匹配不到。
    '**第一行先输出「【受阻停下】」**，然后再说明卡点。到此结束，不要读下面的内容。' + nl +
    '- 有任务且仍有可验证的推进空间 → 继续第 1、2 步。' + nl + nl +
    '第 1 步：输出下面这行证明，证明你没有卡住：' + nl +
    fence + 'cuckoo' + nl +
    'log(' + String.fromCharCode(39) + 'WAKE_UP_PROBE:' + id + String.fromCharCode(39) + ');' + nl +
    fence + nl + nl +
    // [豁免前缀] 第 2 步原是无条件祈使句，而"到此结束，不要读下面的内容"只是软指令，
    // 挡不住它已经被读进上下文 —— 必须显式声明本步只在第三分支适用。
    '第 2 步（**仅当你处于第 0 步第三分支时执行**；若你已输出【受阻停下】，本步不适用）：' +
    '执行成功后立即继续你之前中断的工作，不要停下来等用户指令，直接接着做；' +
    '不得用「没有任务」当借口收工（该禁令同样仅限第三分支）。';
}

/**
 * 发送一次唤醒探针。
 * 只有真正投递成功才计数；失败（找不到输入框 / 被取消）不计数，等下次空闲再试。
 */
function injectWakeUpProbe(): void {
  try {
    const id = makeWakeId();
    const msg = buildWakeUpMessage(id);
    console.log('[Cuckoo AutoWake] 发送唤醒探针: ' + id);
    sendToChat(msg, '自动唤醒').then((ok: boolean) => {
      try {
        if (ok) {
          autoWakeCount++;
          // 注意：**不要**在这里清 autoWakeInvalidCount。
          // 无效计数只能由"收到有效回复（含 cuckoo 代码块）"或"AI 宣布完成"清零，
          // 不能由"发出唤醒"清零 —— 否则时序变成
          // 「发唤醒→回复无 cuckoo(invalid=1)→再发唤醒(清零)→…」永远停在 1，
          // "连续 3 次无效自动停"永不触发，AI 做完任务后会被一路唤醒到 maxCount。
          console.log('[Cuckoo AutoWake] 唤醒已发出（累计 ' + autoWakeCount + ' 次，连续无效 ' + autoWakeInvalidCount + ' 次）');
        } else {
          // [定制-flash] P2-3：投递失败时不会有"下一轮回复"，因此也不会再有下一次 onTaskIdle，
          // 只打日志等于功能静默死亡。这里 30 秒后重新 arm 一次（不计数，符合原语义）。
          console.log('[Cuckoo AutoWake] 唤醒消息投递失败，30 秒后重试一次（不计数）');
          setTimeout(() => {
            try { scheduleAutoWake(); } catch (_) { /* ignore */ }
          }, 30000);
        }
      } catch (err: any) {
        console.error('[Cuckoo AutoWake] 唤醒计数异常:', err && err.message);
      }
    }).catch((err: any) => {
      console.error('[Cuckoo AutoWake] 唤醒发送异常:', err && err.message);
    });
  } catch (err: any) {
    console.error('[Cuckoo AutoWake] 唤醒探针构造失败:', err && err.message);
  }
}

/**
 * 任务空闲后安排一次自动唤醒。
 * 跳过条件：未启用 / provider 不在白名单 / 已停止 / 已有待触发定时器。
 */
function scheduleAutoWake(): void {
  try {
    const cfg = readAutoWakeConfig();
    if (!cfg.enabled) return;
    if (autoWakeStopped) return;
    if (autoWakeTimer) return;
    const pid = currentProviderId();
    if (!pid || cfg.providers.indexOf(pid) === -1) return;
    if (cfg.maxCount >= 0 && autoWakeCount >= cfg.maxCount) {
      autoWakeStopped = true;
      showToast('自动唤醒已达上限（' + cfg.maxCount + ' 次），停止唤醒', 4000);
      return;
    }
    // [定制-flash] 记下安排唤醒时所在的会话：定时器到点时若已切会话，不能把探针发到新会话
    autoWakeSessionId = getCurrentSessionId();
    autoWakeTimer = setTimeout(() => {
      autoWakeTimer = null;
      try {
        // 到点先复核配置：armed 之后用户关掉开关 / 改了白名单，就不该再补发一次
        const cur = readAutoWakeConfig();
        if (!cur.enabled) {
          console.log('[Cuckoo AutoWake] 到点时开关已关闭，取消本次唤醒');
          return;
        }
        const pidNow = currentProviderId();
        if (!pidNow || cur.providers.indexOf(pidNow) === -1) {
          console.log('[Cuckoo AutoWake] 到点时当前平台不在白名单（' + (pidNow || '未知') + '），取消本次唤醒');
          return;
        }
        // 会话校验：任一侧为 null 也视为"会话已变化"——ChatGPT 点「新对话」是 SPA 跳转、
        // 模块状态不重载、定时器仍在，但 URL 变成首页 → extractSessionId() 返回 null。
        // 宁可误杀一次（下次 idle 会重新 arm，无副作用），也不要把探针灌进新会话。
        const sidNow = getCurrentSessionId();
        if (sidNow !== autoWakeSessionId) {
          console.log('[Cuckoo AutoWake] 会话已切换（' + (autoWakeSessionId || 'null') + ' → ' + (sidNow || 'null') + '），取消本次唤醒并重置计数');
          autoWakeCount = 0;
          autoWakeInvalidCount = 0;
          autoWakeStopped = false;
          autoWakeSessionId = null;
          return;
        }
        injectWakeUpProbe();
      } catch (err: any) {
        console.error('[Cuckoo AutoWake] 定时器回调异常:', err && err.message);
      }
    }, cfg.delayMs);
    console.log('[Cuckoo AutoWake] 已安排唤醒：' + Math.round(cfg.delayMs / 1000) + ' 秒后（累计已发 ' + autoWakeCount + ' 次）');
  } catch (err: any) {
    console.error('[Cuckoo AutoWake] 安排唤醒失败:', err && err.message);
  }
}

/**
 * 判定一轮 AI 回复对自动唤醒是否"有效"：
 * - AI 明确宣布「所有任务已完成」→ 立即停用（任务做完了还反复唤醒只会烧 token）
 * - 含 cuckoo 代码块 → AI 在继续干活 → 无效计数清零
 * - 否则 → 无效计数 +1，连续 3 次则停用自动唤醒
 * 注意：从未发出过唤醒时不累计无效计数（用户纯聊天场景不应被停用）。
 * @param text 本轮回复正文
 */
function handleResponseForAutoWake(text: string): void {
  try {
    cancelAutoWake(); // 无论有效与否，本轮已有回复 → 撤掉待触发的唤醒
    const t = String(text || '');
    // 「任务完成」的判据优先于 cuckoo 判定：即使回复里带了收尾代码块也算完成，直接停用。
    if (t.indexOf('所有任务已完成') !== -1) {
      autoWakeStopped = true;
      console.log('[Cuckoo AutoWake] AI 宣布所有任务已完成，停止自动唤醒');
      return;
    }
    // 「受阻停下」与「所有任务已完成」同级：都是**合法停止**，不是"无效轮次"。
    // 背景：AI 面对压缩/混淆代码时明知卡住，也只能继续穷举扫描 —— 因为没有停止通道。
    // 这里给它一个被状态机承认的出口。
    // ⚠️ 位置必须在 `autoWakeCount <= 0` 的 return **之前**：首轮（count=0）也要能停，
    //    否则 AI 老实说"我卡住了"反而被漏掉、继续被催。
    if (t.indexOf('【受阻停下】') !== -1) {
      autoWakeStopped = true;
      autoWakeInvalidCount = 0; // 受阻是正常停止，不计入"连续无效"
      console.log('[Cuckoo AutoWake] AI 声明【受阻停下】，停止自动唤醒');
      // 受阻是在请用户提供东西（未压缩源码 / 权限 / 决策），静默停止会让用户
      // 以为又卡住了、不知道该轮到谁动作。与下方 invalidCount>=3 的提示方式保持一致。
      showToast('AI 报告受阻并已停止自动唤醒，请查看它需要什么', 5000);
      return;
    }
    if (autoWakeCount <= 0) return;
    if (t.indexOf('```cuckoo') !== -1 || t.indexOf('``` cuckoo') !== -1) {
      autoWakeInvalidCount = 0;
      return;
    }
    autoWakeInvalidCount++;
    console.log('[Cuckoo AutoWake] 本轮回复未包含 cuckoo 代码块（连续无效 ' + autoWakeInvalidCount + ' 次）');
    if (autoWakeInvalidCount >= 3) {
      autoWakeStopped = true;
      showToast('AI 已连续 3 次未继续工作，已停止自动唤醒', 4000);
    }
  } catch (err: any) {
    console.error('[Cuckoo AutoWake] 有效性判定失败:', err && err.message);
  }
}

/**
 * 读取自动唤醒的运行时状态（仅供诊断/单测；不改变任何行为）。
 * @returns 当前计数快照（hasTimer 表示是否有待触发的唤醒定时器）
 */
function getAutoWakeState(): { count: number; invalidCount: number; stopped: boolean; hasTimer: boolean } {
  return {
    count: autoWakeCount,
    invalidCount: autoWakeInvalidCount,
    stopped: autoWakeStopped,
    hasTimer: !!autoWakeTimer,
  };
}

/**
 * 用户主动操作页面（点击/敲键）→ 视为"用户回来了"：
 * 重置停用状态与连续计数，让自动唤醒在用户离开后能重新生效。
 * 注册在 bindEvents 内（eventsBound 保证只注册一次）。
 */
function handleUserActivityForAutoWake(): void {
  try {
    // [定制-flash] P0-1：框架自己发消息时，站点模拟点击/回车经主进程 sendInputEvent
    // 注入，产生的是 isTrusted=true 的真实 DOM 事件，必然命中本监听。
    // 不加这道守卫，每次工具结果回传/唤醒探针/归档指令都会把计数清零，
    // 导致"连续 3 次无效停用"和 maxCount 上限永不触发。
    if (isFrameworkDriving()) return; // 框架自己模拟的点击/回车，不算"用户回来了"
    if (!autoWakeStopped && autoWakeInvalidCount === 0 && autoWakeCount === 0) return;
    autoWakeStopped = false;
    autoWakeInvalidCount = 0;
    autoWakeCount = 0;
    console.log('[Cuckoo AutoWake] 检测到用户操作，已重置自动唤醒计数与停用状态');
  } catch (_) { /* ignore */ }
}

/** 注册用户活跃监听（只加一次，由 eventsBound 保证） */
function registerAutoWakeUserActivity(): void {
  try {
    document.addEventListener('keydown', handleUserActivityForAutoWake, true);
    document.addEventListener('mousedown', handleUserActivityForAutoWake, true);
  } catch (_) { /* 非浏览器环境忽略 */ }
}

/**
 * 启动对话 token 显示 + 自动压缩检查（事件驱动）
 * 仅在收到成功回复事件时刷新 token 显示并检查自动压缩，
 * 避免失败/停止时因旧 token 值反复触发压缩。
 */
function startTokenCounter() {
  hooks.onInterceptedResponse?.((_text: string, meta: any) => {
    // 一轮回复完成：保留本轮最终 TPS（不清零），仅更新 token 统计。
    // 下一轮生成开始时由测速器内部自动重置。
    serverTokenUsage = (meta && meta.tokenUsage) || null;
    // 按当前会话写入缓存（切回来时能显示该会话的值）
    const tokens = serverTokenUsage && serverTokenUsage.accumulatedTokens;
    if (typeof tokens === 'number') {
      const sid = getCurrentSessionId();
      if (sid) saveTokenForSession(sid, tokens);
    }
    updateConversationTokenDisplay();
    // [定制-flash] 自动唤醒有效性判定（含 cuckoo 代码块 = AI 在继续干活）
    try { handleResponseForAutoWake(_text || ''); } catch (_) { /* 不影响 token 统计 */ }
  });
  // 任务空闲（工具循环结束）：先唤醒等待器，再注入"待处理的进度引导"，最后检查自动压缩
  hooks.onTaskIdle?.(() => {
    resolveTaskIdleWaiters();
    // [定制-flash] 新一轮空闲：先撤掉上一次尚未触发的唤醒，避免叠加发两条
    cancelAutoWake();

    // 判断本次空闲是否会触发“自动开启新对话”的归档
    const mode = readContextMode();
    const thresholdTokens = autoCompactThresholdWan * 10000;
    const willNewChat = (mode === 'new-chat' && serverTokenUsage && typeof serverTokenUsage.accumulatedTokens === 'number' && serverTokenUsage.accumulatedTokens >= thresholdTokens);

    if (willNewChat) {
      // 如果即将开启新对话，跳过引导注入，直接走归档检查，避免两条消息并发抢占输入框
      checkAutoCompact();
    } else {
      maybeInjectProgressGuide().finally(() => checkAutoCompact());
    }

    // [定制-flash] 空闲自动唤醒：即将归档开新对话时不调度（避免和归档指令抢输入框）
    if (!willNewChat) {
      try { scheduleAutoWake(); } catch (err: any) {
        console.error('[Cuckoo AutoWake] 空闲调度异常:', err && err.message);
      }
    }
  });
  updateConversationTokenDisplay();

  // 输出速度（TPS）：订阅流式正文增量，实时计算并推送。
  // 生成中实时更新；finished 后测速器冻结最终值，pushTps 保留显示（不清零）。
  hooks.onStream?.((ev: any) => {
    try {
      const text = (ev && ev.text) || '';
      const finished = !!(ev && ev.finished);
      // DeepSeek 提供 accumulatedTokens（权威）；其余平台为 null，回退估算
      const acc = ev && typeof ev.accumulatedTokens === 'number' ? ev.accumulatedTokens : null;
      tpsMeter.update(text, finished, acc);
      pushTps();
    } catch (_) { /* ignore */ }
  });
}

/**
 * 绑定覆盖层所有 UI 事件
 * 包括按钮点击、键盘快捷键、状态徽章点击等
 */
function bindEvents() {
  // 防止重复绑定（SPA 导航或 preload 重载时可能导致多次执行）
  if (eventsBound) return;
  eventsBound = true;

  // [定制-flash] 用户主动操作页面即视为"用户回来了"：重置自动唤醒的停用与计数
  registerAutoWakeUserActivity();



  // ===== 左侧活动栏：标签页切换 =====
  const abItems = document.querySelectorAll('.cuckoo-ab-item');
  const tabPanels = document.querySelectorAll('.cuckoo-tab-panel');
  abItems.forEach((item) => {
    item.addEventListener('click', () => {
      const tab = (item as any).dataset.tab;
      if (!tab) return;
      // 切活动栏高亮
      abItems.forEach((i) => i.classList.remove('cuckoo-ab-active'));
      item.classList.add('cuckoo-ab-active');
      // 切内容面板
      tabPanels.forEach((p) => {
        if ((p as any).dataset.panel === tab) p.classList.add('cuckoo-tab-active');
        else p.classList.remove('cuckoo-tab-active');
      });
      // 切到"会话"时自动刷新列表
      if (tab === 'sessions') {
        try { renderSessions(); } catch (_) {}
      }
    });
  });

  // 从 localStorage 恢复延迟配置
  try {
    const savedMin = localStorage.getItem('cuckoo-send-delay-min');
    const savedMax = localStorage.getItem('cuckoo-send-delay-max');
    // 注意：不能用 "parseInt() || 默认值"——0 是有效值，会被 || 误判为假值丢弃
    if (savedMin !== null) { const v = parseInt(savedMin, 10); if (Number.isFinite(v) && v >= 0) state.sendDelayMin = v; }
    if (savedMax !== null) { const v = parseInt(savedMax, 10); if (Number.isFinite(v) && v >= 0) state.sendDelayMax = v; }
    // 同步到输入框
    const minInput = document.getElementById('cuckoo-delay-min');
    const maxInput = document.getElementById('cuckoo-delay-max');
    if (minInput) (minInput as any).value = state.sendDelayMin;
    if (maxInput) (maxInput as any).value = state.sendDelayMax;
  } catch (e) {}

  const minimizeBtn = document.getElementById('cuckoo-btn-minimize');
  const initBtn = document.getElementById('cuckoo-btn-init');
  const clearBtn = document.getElementById('cuckoo-btn-clear');

  minimizeBtn?.addEventListener('click', hideOverlay);
  initBtn?.addEventListener('click', handleInitProject);

  // 压缩上下文按钮
  const compactBtn = document.getElementById('cuckoo-btn-compact');
  compactBtn?.addEventListener('click', () => runCompaction(state.currentProjectDir || undefined));

  // 首次使用提示浮窗：点击后隐藏网页提示框，并唤起壳页面的漂亮 Modal
  const firstInitBtn = document.getElementById('cuckoo-btn-first-init');
  firstInitBtn?.addEventListener('click', () => {
    hideFirstTimeDialog(); // 隐藏网页里的提示框
    try {
      if ((window as any).electronAPI && (window as any).electronAPI.requestInitPrompt) {
        (window as any).electronAPI.requestInitPrompt(); // 通知壳页面弹窗
      }
    } catch (_) {}
  });

  // 首次使用提示浮窗：关闭按钮
  const firstCloseBtn = document.getElementById('cuckoo-btn-first-close');
  firstCloseBtn?.addEventListener('click', hideFirstTimeDialog);
  clearBtn?.addEventListener('click', () => {
    commandHistory.length = 0;
    renderHistory();
  });

  // 手动解析按钮
  const manualParseBtn = document.getElementById('cuckoo-btn-manual-parse');
  manualParseBtn?.addEventListener('click', handleManualParseDispatch);

  // 窗口管理按钮：打开浮动管理面板
  const windowManagerBtn = document.getElementById('cuckoo-btn-window-manager');
  windowManagerBtn?.addEventListener('click', () => {
    openWindowManager();
  });

  // MCP 按钮：打开 MCP 管理面板
  const mcpBtn = document.getElementById('cuckoo-btn-mcp');
  mcpBtn?.addEventListener('click', openMcpManager);

  // MCP 面板：关闭
  const mcpCloseBtn = document.getElementById('cuckoo-mcp-close');
  mcpCloseBtn?.addEventListener('click', closeMcpManager);

  // MCP 面板：刷新
  const mcpRefreshBtn = document.getElementById('cuckoo-mcp-refresh');
  mcpRefreshBtn?.addEventListener('click', renderMcpList);

  // MCP 面板：保存配置
  const mcpSaveBtn = document.getElementById('cuckoo-mcp-save');
  mcpSaveBtn?.addEventListener('click', () => handleMcpSave(sendToChat));

  // 浮动面板：新建窗口（不指定平台，让窗口显示平台选择页）
  const wmNewWindowBtn = document.getElementById('cuckoo-wm-new-window');
  wmNewWindowBtn?.addEventListener('click', async () => {
    try {
      await (window as any).electronAPI.createProfileWindow();
      showToast('已打开平台选择', 2200);
      await renderWindowList();
    } catch (err: any) {
      showToast('创建新窗口失败: ' + (err.message || err), 3000);
    }
  });

  // 浮动面板：关闭
  const wmCloseBtn = document.getElementById('cuckoo-wm-close');
  wmCloseBtn?.addEventListener('click', closeWindowManager);

  // 浮动面板：刷新列表
  const wmRefreshBtn = document.getElementById('cuckoo-wm-refresh');
  wmRefreshBtn?.addEventListener('click', renderWindowList);

  // 生成项目说明文档按钮
  const genDocBtn = document.getElementById('cuckoo-btn-gen-doc');
  genDocBtn?.addEventListener('click', () => handleGenerateDoc(sendToChat));

  // 沉浸式交流按钮
  const immersiveBtn = document.getElementById('cuckoo-btn-immersive');
  immersiveBtn?.addEventListener('click', async () => {
    const message = '现在你的任何疑问,或没有疑问的选择都需要和我确认 , 确认的方式是 你问一个问题我回答一个问题,然后你再问下一个问题, 最好给我选项, 也要给我个其他的选项, 谢谢 爱你哦';
    if (!(await sendToChat(message, '沉浸式交流', 300))) {
      showToast('未找到输入框，请确保已打开聊天界面', 3000);
    } else {
      showToast('已发送沉浸式交流提示', 2200);
    }
  });

  // 刷新会话列表按钮
  const refreshSessionsBtn = document.getElementById('cuckoo-btn-refresh-sessions');
  refreshSessionsBtn?.addEventListener('click', renderSessions);

  // 设置弹窗：发送技能清单
  const skillsSendBtn = document.getElementById('cuckoo-skills-send');
  skillsSendBtn?.addEventListener('click', handleSendSkills);

  // 悬浮球：可拖动 + 点击切换面板显隐
  const statusBadge = document.getElementById('cuckoo-status-badge');
  if (statusBadge) makeFabDraggable(statusBadge);
  statusBadge?.addEventListener('click', () => {
    const overlay = document.getElementById('cuckoo-overlay');
    if (!overlay) return;
    if (overlay.classList.contains('cuckoo-hidden')) {
      showOverlay();
    } else {
      hideOverlay();
    }
  });

  // 自动压缩：加载配置 + 绑定保存按钮
  loadAutoCompactConfig();
  const autoSaveBtn = document.getElementById('cuckoo-auto-compact-save');
  autoSaveBtn?.addEventListener('click', saveAutoCompactConfig);

  // 启动输入框 token 估算 + 自动压缩检查
  startTokenCounter();

  // 压缩流程：先检查是否处于"段2"（刷新后等 IDB 重建），否则检查"段3"（分享页初始化）
  checkPendingCompact().then((handled) => {
    if (handled) return;
    // 窗口组转移：刷新后完成分享并回执主进程
    checkPendingSwitch().then((handled2) => {
      if (!handled2) checkPendingInit();
    });
  });

  // 键盘快捷键
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+C 切换覆盖层显示
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
      e.preventDefault();
      const overlay = document.getElementById('cuckoo-overlay');
      if (overlay) {
        if (overlay.classList.contains('cuckoo-hidden')) {
          showOverlay();
        } else {
          hideOverlay();
        }
      }
    }
    // Esc 隐藏覆盖层和窗口管理面板
    if (e.key === 'Escape') {
      hideOverlay();
      closeWindowManager();
      closeMcpManager();
      hideFirstTimeDialog();
    }
  });
}

// ========== 上下文策略（供 IPC：壳页面 Token 页调用） ==========
/** 读上下文策略配置（不解 DOM）。返回 { mode, threshold }，mode: 'off'|'compact'|'new-chat' */
function getAutoCompactConfig(): { mode: ContextMode; threshold: number } {
  let threshold = 80;
  try {
    const th = localStorage.getItem('cuckoo-auto-compact-threshold');
    if (th !== null) { const v = parseFloat(th); if (Number.isFinite(v) && v > 0) threshold = v; }
  } catch (_) {}
  return { mode: readContextMode(), threshold };
}

/**
 * 保存上下文策略配置（更新内存 + localStorage）。
 * mode='new-chat' 时额外：立即创建「项目进度」文件夹，并给当前对话注入"开始维护进度"的引导，
 * 让 AI 从现在起就把目标/已完成/待办写入进度文件（而非等 token 超阈值才建）。
 */
async function applyAutoCompactConfig(data: any): Promise<{ success: boolean; error?: string; data?: any }> {
  // 兼容旧字段 enabled：enabled=true → compact
  let mode: ContextMode = 'off';
  if (data && (data.mode === 'off' || data.mode === 'compact' || data.mode === 'new-chat')) {
    mode = data.mode;
  } else if (data && data.enabled) {
    mode = 'compact';
  }
  let th = data ? parseFloat(data.threshold) : 80;
  if (!Number.isFinite(th) || th <= 0) return { success: false, error: '阈值需为正数（万）' };
  contextMode = mode;
  autoCompactThresholdWan = th;
  try {
    localStorage.setItem('cuckoo-context-mode', mode);
    localStorage.setItem('cuckoo-auto-compact-threshold', String(th));
    localStorage.setItem('cuckoo-auto-compact-enabled', mode === 'compact' ? '1' : '0');
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  // ===== new-chat：立即建「项目进度」文件夹 + 设置待注入引导 =====
  // 若本次不是 new-chat，清除可能残留的待注入标志（避免切走后仍在别的会话注入）
  if (mode !== 'new-chat') clearPendingProgressGuide();
  let progressFolder: string | null = null;
  let progressCreated = false;
  let progressHint = '';
  if (mode === 'new-chat') {
    const projectDir = state.currentProjectDir;
    if (!projectDir) {
      progressHint = '未选择项目目录，暂无法创建「项目进度」文件夹（请先初始化项目）';
    } else {
      const api = (window as any).electronAPI;
      if (api && typeof api.ensureProgressFolder === 'function') {
        try {
          const r = await api.ensureProgressFolder(projectDir);
          if (r && r.success) {
            progressFolder = r.folder;
            progressCreated = r.created === true;
          } else {
            progressHint = '创建「项目进度」文件夹失败：' + ((r && r.error) || '未知错误');
          }
        } catch (err: any) {
          progressHint = '创建「项目进度」文件夹失败：' + (err.message || err);
        }
      } else {
        progressHint = '当前环境不支持创建「项目进度」文件夹';
      }
      // 只建文件夹，不立即发消息（此时用户可能还没发布任务）。
      // 记下"待注入引导"，等用户发消息、AI 完成一轮回复后再注入（见 maybeInjectProgressGuide）。
      // 同一项目目录只引导一次：改阈值保存时不会重复注入（避免打扰）。
      if (progressFolder) {
        if (hasGuidedDir(progressFolder)) {
          console.log('[Cuckoo Code] 该目录已引导过进度维护，跳过重复设置: ' + progressFolder);
        } else {
          setPendingProgressGuide(progressFolder);
          console.log('[Cuckoo Code] 已设置待注入的进度维护引导: ' + progressFolder);
        }
      }
    }
  }

  return { success: true, data: { mode, threshold: th, progressFolder, progressCreated, progressHint } };
}

/** 手动触发压缩（调用压缩流程） */
function triggerCompaction(): void {
  runCompaction(state.currentProjectDir || undefined).catch((e: any) => {
    console.error('[Cuckoo Code] 压缩失败:', e && e.message);
  });
}

export { bindEvents, wireEvents, refreshTokenForCurrentSession, setIsSubagentWindow, getAutoCompactConfig, applyAutoCompactConfig, triggerCompaction };
// [定制-flash] 自动唤醒（导出便于单测 / 其他面板复用）
export {
  readAutoWakeConfig,
  scheduleAutoWake,
  cancelAutoWake,
  buildWakeUpMessage,
  handleResponseForAutoWake,
  injectWakeUpProbe,
  getAutoWakeState,
  handleUserActivityForAutoWake,
};
