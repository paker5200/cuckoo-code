'use strict';
/**
 * [定制-flash] 持续执行两套机制的单测：
 * 1) 本轮执行提醒（chat-input）：平台白名单 / 开关 / 固定文案
 * 2) 空闲自动唤醒（events）：配置读取 / 探针文案 / 计数与停止状态机
 *
 * 状态机部分重点回归一个真实 bug：
 *   `injectWakeUpProbe()` 发出唤醒后曾把 autoWakeInvalidCount 清零，
 *   导致时序「发唤醒 → 回无 cuckoo → 再发唤醒(清零)」永远停在 1，
 *   "连续 3 次无效自动停"永不触发，AI 做完任务后会被一路唤醒到 maxCount。
 *
 * window/document/localStorage/provider 是外部边界，按需 mock；
 * sendToChat 用"只覆盖这一个函数"的部分 mock（其余 chat-input 导出保持真实）。
 */
import { test, beforeEach, afterEach, vi } from 'vitest';
import assert from 'node:assert';

const hoisted = vi.hoisted(() => ({ sendOk: true, sendCalls: 0, provider: null }));

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createRequire: () => () => ({ ipcRenderer: { on: () => {}, invoke: async () => ({}) } }),
  };
});

// 只覆盖 sendToChat（唤醒探针投递 + 计数调用次数），其余 chat-input 导出保持真实
vi.mock('../../src/overlay/chat-input.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    sendToChat: async () => { hoisted.sendCalls++; return hoisted.sendOk; },
  };
});

// 可控的当前平台 + 当前会话 ID
let providerId = 'chatgpt';
let sessionId = 'sess-A';
vi.mock('../../src/providers/registry.js', () => ({
  // hoisted.provider 非空时优先返回它（用于真驱动 providers/chatgpt 的 triggerSend）
  getProviderByUrl: () => hoisted.provider || { id: providerId, extractSessionId: () => sessionId },
}));

let store;

function setupGlobals() {
  store = {};
  globalThis.window = {
    location: { href: 'https://chatgpt.com/' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    HTMLTextAreaElement: { prototype: {} },
    HTMLInputElement: { prototype: {} },
  };
  globalThis.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const makeEl = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} });
  globalThis.document = {
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: () => null,
    createElement: makeEl,
    body: { appendChild() {} },
    addEventListener: () => {},
    execCommand: () => true,
  };
  globalThis.Event = class { constructor() {} };
  globalThis.KeyboardEvent = class { constructor(type, opts) { this.type = type; Object.assign(this, opts || {}); } };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

beforeEach(() => {
  vi.resetModules();
  setupGlobals();
  providerId = 'chatgpt';
  sessionId = 'sess-A';
  hoisted.sendOk = true;
  hoisted.sendCalls = 0;
  hoisted.provider = null;
});

afterEach(() => {
  vi.useRealTimers();
});

/** 等待 injectWakeUpProbe 内部 .then 链跑完（微任务 + 一个宏任务 tick） */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ===== 一、本轮执行提醒 =====

test('本轮执行提醒：默认只对 chatgpt 生效，可用开关关闭', async () => {
  const chat = await import('../../src/overlay/chat-input.js');
  assert.deepEqual(chat.readRoundReminderProviders(), ['chatgpt']);
  assert.equal(chat.shouldApplyRoundReminder(), true);

  // 开关置 '0' → 关闭
  store['cuckoo-round-reminder-enabled'] = '0';
  assert.equal(chat.shouldApplyRoundReminder(), false);
  delete store['cuckoo-round-reminder-enabled'];

  // 其他平台默认不生效
  providerId = 'deepseek';
  assert.equal(chat.shouldApplyRoundReminder(), false);
  // 白名单显式加上该平台后生效
  store['cuckoo-round-reminder-providers'] = ' chatgpt , deepseek ';
  assert.deepEqual(chat.readRoundReminderProviders(), ['chatgpt', 'deepseek']);
  assert.equal(chat.shouldApplyRoundReminder(), true);
});

test('本轮执行提醒：文案固定且包含关键纪律', async () => {
  const chat = await import('../../src/overlay/chat-input.js');
  const txt = chat.buildRoundReminder();
  assert.equal(txt, chat.buildRoundReminder()); // 不随机
  assert.ok(txt.indexOf('【Cuckoo 本轮执行提醒】') === 0);
  // 反引号必须是连续 3 个直接跟 cuckoo；不允许把源码拼接符 ` + ` 漏进正文
  assert.ok(txt.indexOf('```cuckoo') > 0);
  assert.equal(txt.indexOf('``` + cuckoo'), -1);
  assert.equal(txt.indexOf('``` +'), -1);
  assert.ok(txt.indexOf('不得虚构执行结果') > 0);
  assert.ok(txt.indexOf('汇报之后若任务未完成') > 0);

  // [P1-1 核心] 第2条必须带「（且用户已提出具体任务）」限定。
  // 删掉它 → "未完成就继续"回到无条件，空项目下仍被要求干活，本次修复的一半失效。
  // 变异实测：删该限定后，本文件此前 15 条断言全部仍 PASS（漏报），故必须单独锁。
  assert.ok(
    txt.indexOf('未完成（且用户已提出具体任务）') > 0,
    '第2条必须带「（且用户已提出具体任务）」限定，否则等于无条件"不许停"'
  );

  // [第三出口] 必须存在"技术障碍"停止条件，否则 AI 卡在压缩/混淆代码上只能穷举扫描。
  // 真实事故：单文件 6 遍结构相同扫描、58 次 read、同一行连读 4 次、23 次唤醒不收敛。
  assert.ok(txt.indexOf('停止条件有三个') > 0, '停止条件必须从两个扩到三个');
  assert.ok(txt.indexOf('技术障碍') > 0, '缺少"技术障碍"出口');
  // 量化门槛用正则捕获数字（容忍"实质性/明显"等措辞微调，仍锁死必须是 3 次）。
  // 改成 1 次会让第 ③ 出口退化成"一遇困难就收工"，比原来更糟。
  const thrMatch = txt.match(/同一方法(?:已)?连续\s*(\d+)\s*次无(?:实质|明显)进展/);
  assert.ok(thrMatch, '技术障碍出口必须带量化门槛（否则会被滥用成"一遇困难就停"）');
  assert.strictEqual(thrMatch[1], '3', '门槛必须是连续 3 次，改成 1 次会让第③退化成"一遇困难就收工"');
  // 量化门槛必须在"技术障碍"之后（限定它属于该出口，而不是被别处引用）
  assert.ok(
    txt.indexOf('技术障碍') < txt.indexOf('连续 3 次无实质进展'),
    '量化门槛必须写在第 ③ 出口内部'
  );
  // 普通的报错/语法错误不算第 ③ 类，原有的"失败就重试"必须保留
  assert.ok(txt.indexOf('失败：分析错误、修正后重试') > 0, '"失败就重试"这条不能因新增出口而消失');
  // 第③必须明确要求"停止"（弱化成"可以考虑停止"会让出口失效）
  assert.ok(txt.indexOf('应停止调用工具') > 0, '第③必须明确要求"停止"，不能弱化成"可以考虑"');
  // 第③的位置必须在"一律继续"之前，否则被后者覆盖（两个都在同一 bullet 里并列时尤其危险）
  assert.ok(
    txt.indexOf('第 ③ 种情况') < txt.indexOf('一律继续输出'),
    '第③必须在"一律继续"之前，否则会被后者覆盖'
  );
  // 交集守卫：第 ③ 出口必须从"一律继续"的适用范围里被显式排除。
  // 删掉它，AI 即便卡住也会被"只要用户提出过任务且未完成就一律继续"覆盖掉。
  assert.ok(
    txt.indexOf('且不属于第 ③ 种情况') > 0,
    '交集守卫：第③出口必须从"一律继续"里被排除'
  );
  // 澄清句必须是精确子句：只要求「不属于」和「等待用户」两个词存在的话，
  // 它们在别处也都有，删掉整句澄清仍然通过（漏报）。
  assert.ok(
    txt.indexOf('这是"受阻停下"，不属于"等待用户"') > 0,
    '第③出口必须声明与"等待用户"的区别'
  );
  // [任务范围] 事故起点：用户只说"分析"，AI 分析出问题后自己升级成"修复"，然后卡在压缩代码里。
  // 这条必须独立存在，不能只在"用户尚未提出任务"那个条件分支里出现 —— 事故里用户给过任务。
  assert.ok(txt.indexOf('任务范围：只做用户明确要求的事') > 0, '提醒必须独立声明任务范围约束');
  assert.ok(txt.indexOf('不要自动升级成"修复/修改"') > 0, '必须点明"分析→修复"的越界形态');
  assert.ok(txt.indexOf('等用户确认再动手') > 0, '发现 bug 必须先等确认，不能直接改');
  // [协议字面] 只在本处要求是不够的：走提醒路径停下、或平台不在 auto-wake 白名单时，
  // 状态机认不到该字面，AI 停了也会多烧 1~3 轮唤醒。
  assert.ok(txt.indexOf('【受阻停下】') > 0, '提醒路径停下时也必须输出【受阻停下】协议字面');
  const remindVariants = txt.match(/【受阻[^】]*】/g) || [];
  assert.ok(
    remindVariants.every((v) => v === '【受阻停下】'),
    '提醒里的协议字面必须唯一写法：' + remindVariants.join(' / ')
  );
  // [P1-1 核心] 第5条出口②的 scope 必须是「本轮」。
  // 写成"用户尚未提出"会让 AI 用"用户之前没说清"当借口停下，出口被滥用。
  assert.ok(
    txt.indexOf('用户本轮尚未提出任何具体任务') > 0,
    '第5条出口②必须带「本轮」scope 限定，否则 AI 可用"用户之前没说清"钻空子'
  );

  // [空项目边界] 用户没提出具体任务时必须允许停下，且不得越界向上级目录/盘符根目录搜索。
  //
  // ⚠️ 以下断言经变异验证，两个"必须抓到"的回归点（改文案时不可退化）：
  //   ① 删掉「但若用户本轮尚未提出任何具体任务」这个适用范围限定 → 必须失败。
  //      少了它，这条就退化成无条件的"继续干活"，空项目场景直接复发原 bug。
  //   ② 把边界条挪到最前面（优先级失效） → 必须失败。
  //   注：早先版本用「整句精确匹配」，上述两个变异都能漏过去，且稍微改措辞就误报，
  //   故改为「限定句 + token + 位置」三重断言，兼顾强度与抗脆性。
  assert.ok(
    txt.indexOf('但若用户本轮尚未提出任何具体任务') > 0,
    '必须保留适用范围限定「但若用户本轮尚未提出任何具体任务」，否则空项目下 AI 仍被要求干活'
  );
  // scope 一致性：第 5 条出口②与第 6 条边界条都必须带「本轮」。
  // 若只改一处（旧版第 6 条写"用户尚未提出"），AI 可用"用户之前没说清"当借口停下。
  assert.equal(
    txt.split('用户本轮尚未提出').length - 1,
    2,
    '第5条出口②与第6条边界条都必须带「本轮」scope（应恰好出现 2 次）'
  );
  // token 级断言（抗措辞微调；不锁整句，避免改标点就误报）
  assert.ok(txt.indexOf('上级目录') > 0);
  assert.ok(txt.indexOf('盘符根目录') > 0);
  assert.ok(txt.indexOf('其它路径搜索') > 0);
  assert.ok(txt.indexOf('等待用户指令') > 0);

  // 位置断言。先显式确认锚点存在：否则 indexOf 返回 -1 会让下面的比较**退化成恒真**，
  // 等于把断言写成摆设（这是"看着有测试、其实没锁住"的典型坑）。
  assert.ok(txt.indexOf('不要只写计划') > 0, '第2条「不要只写计划」必须存在（位置断言锚点）');
  assert.ok(txt.indexOf('汇报之后若任务未完成') > 0, '第5条汇报纪律必须存在（位置断言锚点）');
  assert.ok(
    txt.indexOf('等待用户指令') > txt.indexOf('不要只写计划'),
    '边界条必须排在第2条主指令之后（第2条现已带适用条件，但其"继续干活"倾向仍先于边界条）'
  );
  assert.ok(
    txt.indexOf('等待用户指令') > txt.indexOf('汇报之后若任务未完成'),
    '边界条必须排在第5条停止闸门之后，否则"后者覆盖前者"的读法不成立'
  );
  assert.ok(
    txt.indexOf('等待用户指令') < txt.indexOf('不得虚构执行结果'),
    '边界条必须在收口句「不得虚构执行结果」之前'
  );
});

// [跨文件一致性] 三处"技术障碍"门槛必须同为 **AND** 语义。
// 早期 chat-input 用顿号平列（= 或）：只要命中"代码被压缩无法定位"一条就够停，
// 3 次门槛形同虚设。而提醒是每轮注入、recency 最高的那份，模型会按最宽松的执行 ——
// 所以单看任一文件都抓不到这个问题，必须跨文件比对。
test('三处「技术障碍」门槛必须同为 AND 语义，不得顿号平列', async () => {
  const fs = await import('node:fs');
  const chat = await import('../../src/overlay/chat-input.js');
  const ev = await import('../../src/overlay/events.js');
  const md = fs.readFileSync('src/prompt/chatgpt.md', 'utf-8');

  const sources = [
    { name: 'chat-input.ts 提醒', text: chat.buildRoundReminder() },
    { name: 'events.ts 探针', text: ev.buildWakeUpMessage('ab12cd34') },
    { name: 'chatgpt.md', text: md },
  ];

  for (const s of sources) {
    const gate = s.text.indexOf('同一方法');
    assert.ok(gate > 0, s.name + '：必须含「同一方法…连续 3 次无实质进展」门槛');
    // 门槛前 12 字内必须出现「且」，形成与本条前半的 AND
    const before = s.text.slice(Math.max(0, gate - 12), gate);
    assert.ok(before.indexOf('且') !== -1, s.name + '：门槛必须用「且」形成 AND，当前为：' + before);
    // 顿号平列（、同一方法）= 或 语义，正是本 bug 的形态
    assert.equal(
      s.text.indexOf('、同一方法'),
      -1,
      s.name + '：不得用顿号把 3 次门槛平列成"或"'
    );
    assert.ok(
      /同一方法(?:已)?(?:尝试\s*≥?\s*3\s*次[、，]?\s*)?连续\s*3\s*次无(?:实质|明显)进展/.test(s.text) ||
      s.text.indexOf('同一方法已连续 3 次无实质进展') > 0,
      s.name + '：门槛必须是"连续 3 次"'
    );
  }
});

// [双出口后缀] 用户点「卡住了?点我」和自动重试都走 buildContinueMessage()：
// 回一句裸的"接着干"会把已受阻的 AI 推回穷举扫描。
test('buildContinueMessage 必须带"无任务 / 受阻"双出口后缀', async () => {
  const cp = await import('../../src/infra/continue-prompt-pool.js');
  const msg = cp.buildContinueMessage();
  assert.ok(msg.indexOf('【受阻停下】') > 0, '后缀必须含受阻出口，否则卡住时被推回去穷举');
  assert.ok(msg.indexOf('所有任务已完成') > 0, '后缀必须含无任务出口');
  assert.ok(msg.indexOf('不要去找项目') > 0, '后缀必须禁止越界找项目');
  // 底池文案本身不能被改动（1000 条默认池保持原样，只加后缀）
  assert.ok(
    cp.DEFAULT_CONTINUE_PROMPTS.some((p) => msg.indexOf(p) === 0),
    '必须在原池文案之后追加后缀，不得替换池子内容'
  );
});

// ===== 二、自动唤醒：配置与文案 =====

test('自动唤醒：配置默认值与覆盖', async () => {
  const ev = await import('../../src/overlay/events.js');
  const dft = ev.readAutoWakeConfig();
  assert.equal(dft.enabled, true);
  assert.deepEqual(dft.providers, ['chatgpt']);
  assert.equal(dft.delayMs, 90000); // 90 秒
  assert.equal(dft.maxCount, 20);

  store['cuckoo-auto-wake-enabled'] = '0';
  store['cuckoo-auto-wake-providers'] = 'ChatGPT,Claude';
  store['cuckoo-auto-wake-delay'] = '30';
  store['cuckoo-auto-wake-max'] = '-1';
  const cfg = ev.readAutoWakeConfig();
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.providers, ['chatgpt', 'claude']);
  assert.equal(cfg.delayMs, 30000);
  assert.equal(cfg.maxCount, -1); // -1 = 无限
});

test('自动唤醒：探针文案含 8 位 id 与可执行代码块', async () => {
  const ev = await import('../../src/overlay/events.js');
  const msg = ev.buildWakeUpMessage('ab12cd34');
  assert.ok(msg.indexOf('【Cuckoo 自动唤醒·ab12cd34】') === 0);
  assert.ok(msg.indexOf("```cuckoo\nlog('WAKE_UP_PROBE:ab12cd34');\n```") > 0);

  // ===== 结构：先判定、再分支（三分支） =====
  // 开头的「直接接着做」曾是无条件祈使句，模型会先执行它、把后面的例外句当补充；
  // 现改为第 0 步三选一判定，「直接接着做」只存在于"仍有推进空间"分支里。
  assert.ok(msg.indexOf('第 0 步') > 0, '探针必须先做状态判定（第 0 步）');

  // 三个分支的标识串缺一不可：
  // ① 无任务 → 收工；② 有任务但卡死 → 停止并说明卡点（这条来自真实事故：
  //   AI 面对压缩混淆代码无停止出口，对同一文件做了 6 遍扫描、58 次 read、23 次唤醒）；
  // ③ 有任务且可推进 → 继续干活。
  assert.ok(msg.indexOf('没有用户提出的具体任务') > 0, '缺少"无任务"分支');
  assert.ok(msg.indexOf('已陷入技术障碍') > 0, '缺少"技术障碍"分支（真实事故的止损出口）');
  assert.ok(msg.indexOf('仍有可验证的推进空间') > 0, '缺少"可推进"分支');
  assert.ok(msg.indexOf('连续 3 次无实质进展') > 0, '技术障碍分支必须有量化门槛，否则会被滥用成"一遇困难就停"');
  assert.ok(msg.indexOf('到此结束，不要读下面的内容') > 0, '缺少阻断注意力下滑的语句');
  assert.ok(msg.indexOf('上级目录') > 0 && msg.indexOf('盘符根目录') > 0, '探针未禁止越界搜索');
  assert.ok(msg.indexOf('不得用「没有任务」当借口收工') > 0, '缺少反偷懒约束');
  // 障碍分支的两条硬要求：明确禁止继续调工具 + 要求说明需要用户提供什么
  assert.ok(msg.indexOf('不要再调用工具') > 0, '障碍分支必须明确禁止继续调用工具');
  assert.ok(msg.indexOf('需要用户提供什么') > 0, '障碍分支必须要求说明需要用户提供什么');
  // [任务范围自检] 事故起点：用户只说"分析"，AI 自己升级成"修复"。
  // 范围约束必须独立于"有没有任务"这个判定，否则"用户已提出任务"时它不生效。
  assert.ok(msg.indexOf('第 0 步之前先自检') > 0, '探针必须在判定前先做任务范围自检');
  assert.ok(msg.indexOf('是否在用户原话要求的范围内') > 0, '自检必须点明"用户原话要求的范围"');
  assert.ok(msg.indexOf('按【受阻停下】处理并说明需要授权') > 0, '越界时必须能走【受阻停下】出口');
  // [第 2 步豁免前缀] 原为无条件祈使句，"到此结束，不要读下面的内容"只是软指令挡不住，
  // 必须显式声明第 2 步只在第三分支适用，否则受阻分支的 AI 仍会执行"直接接着做"。
  assert.ok(msg.indexOf('仅当你处于第 0 步第三分支时执行') > 0, '第 2 步必须有分支豁免前缀');
  assert.ok(msg.indexOf('若你已输出【受阻停下】，本步不适用') > 0, '第 2 步必须声明受阻时不适用');
  // 【受阻停下】是**协议字面**：handleResponseForAutoWake 靠它立即停用唤醒。
  // 少它或写成别的变体，AI 走合法出口也会被 state machine 当成"无效轮次"罚 3 次。
  assert.ok(msg.indexOf('【受阻停下】') > 0, '探针第三分支必须给出固定的【受阻停下】协议字面');
  // 它现在合理地出现 2 次（前置自检的"越界"分支 + 第 0 步第三分支），两处都指向同一个停止协议。
  // 真正要防的不是次数，而是**变体写法**（【受阻】/【受阻停止】之类），那样状态机就匹配不到了。
  // 所以逐个校验所有 `【受阻…】` 形态，必须全部是标准字面。
  const blockedVariants = msg.match(/【受阻[^】]*】/g) || [];
  assert.ok(blockedVariants.length > 0, '探针必须包含【受阻停下】协议字面');
  assert.ok(
    blockedVariants.every((v) => v === '【受阻停下】'),
    '协议字面必须唯一写法，不得出现变体：' + blockedVariants.join(' / ')
  );

  // 「所有任务已完成」必须只出现一次：handleResponseForAutoWake 靠这个字面立即停用，
  // 出现两次（旧版第 0 步出口 + 收尾"已完成所有工作"）会形成两个不同条件互相稀释。
  assert.equal(
    msg.split('所有任务已完成').length - 1,
    1,
    '「所有任务已完成」在探针中必须恰好出现 1 次'
  );
  // 旧版收尾句已被删除（其条件"已完成所有工作"与"没有任务"不同，会稀释出口）
  assert.equal(msg.indexOf('如果你已经完成了所有工作'), -1, '旧的收尾句必须已删除');

  // ===== 位置：三个分支判定都必须在「直接接着做」之前 =====
  // 先验锚点存在，防 indexOf 返回 -1 让下面的比较退化成恒真。
  const keep = msg.indexOf('直接接着做');
  assert.ok(keep > 0, '锚点「直接接着做」必须存在（否则位置断言会退化成恒真）');
  assert.ok(
    msg.indexOf('第 0 步') < keep,
    '状态判定必须排在「直接接着做」之前，否则模型会先执行无条件指令'
  );
  // 两个终止分支都必须在「直接接着做」之前，否则模型读完"接着做"就不会回头走出口。
  assert.ok(
    msg.indexOf('没有用户提出的具体任务') < keep,
    '"无任务"出口必须排在「直接接着做」之前'
  );
  assert.ok(
    msg.indexOf('已陷入技术障碍') < keep,
    '"技术障碍"出口必须排在「直接接着做」之前'
  );
  // 两个终止分支都必须带注意力阻断语（缺一个就会让模型读完继续往下执行第 1、2 步）。
  // 但只数 count=2 不够：两条都塞在"无任务"分支里也能满足计数，
  // 所以再按分支切片，断言"技术障碍"分支**自身**带阻断语。
  const blkStart = msg.indexOf('- 有任务但已陷入技术障碍');
  const blkEnd = msg.indexOf('- 有任务且仍有可验证的推进空间');
  assert.ok(blkStart > 0 && blkEnd > blkStart, '锚点：技术障碍分支必须存在且在三分支结构中');
  assert.ok(
    msg.slice(blkStart, blkEnd).indexOf('到此结束，不要读下面的内容') > 0,
    '"技术障碍"分支自身必须带阻断语，不能只靠别处计数满足'
  );
  assert.equal(
    msg.split('到此结束，不要读下面的内容').length - 1,
    2,
    '两个终止分支（无任务 / 技术障碍）都必须带"到此结束"阻断语'
  );
});

// ===== 三、自动唤醒：计数与停止状态机 =====

test('发出唤醒不清零无效计数：两轮「唤醒 + 无 cuckoo 回复」累计为 2', async () => {
  const ev = await import('../../src/overlay/events.js');

  await ev.injectWakeUpProbe();
  await flush();
  assert.strictEqual(ev.getAutoWakeState().count, 1);
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 0);

  // 第 1 轮：AI 回纯文本（没继续干活）
  ev.handleResponseForAutoWake('好的，改完了，你确认下');
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 1);

  // 再发一次唤醒：count 增加，但 invalidCount 必须保持 1（旧实现会清零 → bug）
  await ev.injectWakeUpProbe();
  await flush();
  assert.strictEqual(ev.getAutoWakeState().count, 2);
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 1);

  // 第 2 轮：又是纯文本 → 累计到 2
  ev.handleResponseForAutoWake('都做完了');
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 2);
  assert.strictEqual(ev.getAutoWakeState().stopped, false);
});

test('连续 3 次无 cuckoo 回复 → 停止自动唤醒', async () => {
  const ev = await import('../../src/overlay/events.js');
  await ev.injectWakeUpProbe();
  await flush();
  ev.handleResponseForAutoWake('纯文本 1');
  ev.handleResponseForAutoWake('纯文本 2');
  assert.strictEqual(ev.getAutoWakeState().stopped, false);
  ev.handleResponseForAutoWake('纯文本 3');
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 3);
  assert.strictEqual(ev.getAutoWakeState().stopped, true);
});

test('回复含 cuckoo 代码块 → 无效计数清零（有效唤醒）', async () => {
  const ev = await import('../../src/overlay/events.js');
  await ev.injectWakeUpProbe();
  await flush();
  ev.handleResponseForAutoWake('纯文本 1');
  ev.handleResponseForAutoWake('纯文本 2');
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 2);
  ev.handleResponseForAutoWake('继续：\n\n```cuckoo\nlog(1);\n```');
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 0);
  assert.strictEqual(ev.getAutoWakeState().stopped, false);
});

test('AI 宣布「所有任务已完成」→ 立即停止（无需累计到 3 次）', async () => {
  const ev = await import('../../src/overlay/events.js');
  await ev.injectWakeUpProbe();
  await flush();
  assert.strictEqual(ev.getAutoWakeState().stopped, false);
  ev.handleResponseForAutoWake('……所有任务已完成');
  assert.strictEqual(ev.getAutoWakeState().stopped, true);
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 0); // 属正常完成，不算"无效"
});

// [受阻停下] 与「所有任务已完成」同级的第二个合法出口。
// 真实事故：AI 明知卡在压缩代码上却无停止通道，只能穷举扫描（23 次唤醒不收敛）。
// 若状态机不认这个字面，AI 老实说"卡住了"反而被当成"无效轮次"罚 3 次，
// 或被催得再吐一个 cuckoo 块把 invalidCount 复位，一路跑到 maxCount。
test('AI 声明【受阻停下】→ 立即停止（受阻是合法出口，不算无效轮次）', async () => {
  const ev = await import('../../src/overlay/events.js');
  await ev.injectWakeUpProbe();
  await flush();
  assert.strictEqual(ev.getAutoWakeState().stopped, false);
  ev.handleResponseForAutoWake('【受阻停下】卡在压缩代码，需要你提供未压缩版本');
  assert.strictEqual(ev.getAutoWakeState().stopped, true);
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 0); // 属正常停止，不算"无效"
  assert.strictEqual(ev.getAutoWakeState().hasTimer, false); // 必须撤掉待触发的唤醒
});

test('未发出过唤醒时不受"无效"影响（纯聊天不误停用）', async () => {
  const ev = await import('../../src/overlay/events.js');
  ev.handleResponseForAutoWake('纯文本 1');
  ev.handleResponseForAutoWake('纯文本 2');
  ev.handleResponseForAutoWake('纯文本 3');
  assert.strictEqual(ev.getAutoWakeState().invalidCount, 0);
  assert.strictEqual(ev.getAutoWakeState().stopped, false);
});

test('发送失败不计数', async () => {
  hoisted.sendOk = false;
  const ev = await import('../../src/overlay/events.js');
  await ev.injectWakeUpProbe();
  await flush();
  assert.strictEqual(ev.getAutoWakeState().count, 0);
});

// ===== 四、P0 回归：框架自己发消息不得清零计数 =====

test('P0：框架驱动期间的点击/按键不算"用户回来了"，不重置计数', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(4102444800000); // 2100-01-01：起点确定，避免残留窗口干扰
  // 直接操作 events 所用的同一个 framework-driving 实例（chat-input 经 mock 工厂 importOriginal
  // 拿到的真实模块可能属于上一代模块图，两边的模块级状态不共享，故此处不借助 chat 打标）。
  const fd = await import('../../src/infra/framework-driving.js');
  fd.resetFrameworkDriving();
  const ev = await import('../../src/overlay/events.js');

  // 造出「发过唤醒 + 连续 3 次无效 → 已停用」的状态
  await ev.injectWakeUpProbe();
  await vi.advanceTimersByTimeAsync(0);
  ev.handleResponseForAutoWake('纯文本 1');
  ev.handleResponseForAutoWake('纯文本 2');
  ev.handleResponseForAutoWake('纯文本 3');
  let s = ev.getAutoWakeState();
  assert.strictEqual(s.count, 1);
  assert.strictEqual(s.invalidCount, 3);
  assert.strictEqual(s.stopped, true);

  // 框架正在驱动（triggerSend 打开的默认 5s 窗口内）→ 站点模拟点击产生 isTrusted 事件 → 必须被忽略
  fd.markFrameworkDriving();
  assert.strictEqual(fd.isFrameworkDriving(), true);
  ev.handleUserActivityForAutoWake();
  s = ev.getAutoWakeState();
  assert.strictEqual(s.count, 1, '框架驱动期间不得重置 count');
  assert.strictEqual(s.invalidCount, 3, '框架驱动期间不得重置 invalidCount');
  assert.strictEqual(s.stopped, true, '框架驱动期间不得解除停用');

  // 窗口过期后，真实用户操作才生效
  vi.advanceTimersByTime(5001); // 入口默认窗口 5 秒
  assert.strictEqual(fd.isFrameworkDriving(), false);
  ev.handleUserActivityForAutoWake();
  s = ev.getAutoWakeState();
  assert.strictEqual(s.count, 0);
  assert.strictEqual(s.invalidCount, 0);
  assert.strictEqual(s.stopped, false);
});

test('P0：triggerSend 入口窗口 5 秒（只覆盖同步兜底，不靠它覆盖长重试）', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(4102444800000); // 2100-01-01
  const chat = await import('../../src/overlay/chat-input.js');
  chat.resetFrameworkDriving(); // 清场（chat 与它的 framework-driving 实例自洽）
  assert.strictEqual(chat.isFrameworkDriving(), false);
  // provider 无 triggerSend/findSendButton → 走 fallbackSend 的 Enter 兜底，同样算框架驱动
  const input = { tagName: 'TEXTAREA', dispatchEvent: () => {}, focus: () => {} };
  chat.triggerSend(input);
  assert.strictEqual(chat.isFrameworkDriving(), true, 'triggerSend 之后应处于框架驱动中');
  vi.advanceTimersByTime(4999);
  assert.strictEqual(chat.isFrameworkDriving(), true);
  vi.advanceTimersByTime(2); // 累计 5.001s
  assert.strictEqual(chat.isFrameworkDriving(), false, '入口窗口默认 5 秒后自然过期');
});

test('P0：真驱动 chatgpt.triggerSend 的 10 轮点击重试，t≈6.5s 时仍在框架驱动窗口内', async () => {
  // ⚠️ 本用例保护 providers/chatgpt.ts 的**逐轮续期**（每轮 markFrameworkDriving(2000) +
  // 兜底 DOM click 前续期）。改动这两处续期参数（或删掉）必须同步复核本用例，否则 P0 会静默回归。
  vi.useFakeTimers();
  vi.setSystemTime(4102444800000); // 2100-01-01
  const fd = await import('../../src/infra/framework-driving.js');
  fd.resetFrameworkDriving();

  // mock DOM：可见且有内容的输入框（remaining>2 → 迫使 10 轮都跑）+ 可见未禁用的发送按钮
  const input = { offsetWidth: 120, offsetHeight: 24, innerText: '这是一段还没发出去的长文本内容', focus: () => {} };
  const btn = {
    offsetWidth: 32, offsetHeight: 32, disabled: false,
    getBoundingClientRect: () => ({ left: 100, top: 100, width: 32, height: 32 }),
    click: () => { clicks++; },
  };
  let clicks = 0;
  document.querySelectorAll = () => [input];
  document.querySelector = () => btn;
  window.electronAPI = { simulateMouse: async () => { clicks++; } };

  // 让 chat-input 里的 getCurrentProvider() 返回**真实**的 chatgpt provider，
  // 从而 triggerSend → chatgpt.triggerSend 的 10 轮循环真的跑起来
  const { chatgpt } = await import('../../src/providers/chatgpt.js');
  hoisted.provider = chatgpt;
  const chat = await import('../../src/overlay/chat-input.js');

  chat.triggerSend(input); // 入口：markFrameworkDriving()（默认 5s）+ provider.triggerSend

  // 逐轮推进：每轮 simulateMouse + 400ms + 200ms = 600ms；用 650ms 留余量。
  // 关键断点选在 t≈5.85s（第 9 轮之后）：此时入口 5s 窗口早已过期，而末尾兜底 click
  // 还没发生（它在 10 轮全部跑完之后）—— 此刻仍为 true **只可能**来自 chatgpt 的逐轮续期，
  // 这样才真正锁住"逐轮续期存在且幅度够"（删掉续期或把 2000 改小到 <700ms 都会挂）。
  for (let i = 0; i < 9; i++) await vi.advanceTimersByTimeAsync(650);
  assert.strictEqual(fd.isFrameworkDriving(), true, 't≈5.85s（入口窗口过期后）仍须在窗口内 —— 只能由逐轮续期解释');

  // 跑完第 10 轮（含末尾兜底 DOM click 的续期）
  await vi.advanceTimersByTimeAsync(650);
  assert.ok(clicks >= 10, '应完成 10 轮点击（实际 ' + clicks + ' 次）');
  assert.strictEqual(fd.isFrameworkDriving(), true, '最后一轮点击之后仍须处于框架驱动窗口内');

  // 续期**幅度**也要够：兜底点击之后 ~1.2s 仍应为 true。
  // 把续期参数从 2000 调到 <700ms 会在这里挂（窗口会先于最后一次真实事件注入关闭）。
  await vi.advanceTimersByTimeAsync(1200);
  assert.strictEqual(fd.isFrameworkDriving(), true, '续期幅度需 ≥ 约 1.2s');

  // 再之后窗口自然关闭
  await vi.advanceTimersByTimeAsync(2000);
  assert.strictEqual(fd.isFrameworkDriving(), false);
});

test('框架驱动窗口：mark 只延长不缩短（逐轮 2s 续期不会把较长窗口改小）', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(4102444800000); // 2100-01-01
  const fd = await import('../../src/infra/framework-driving.js');
  fd.resetFrameworkDriving();

  fd.markFrameworkDriving(20000); // triggerSend 入口
  fd.markFrameworkDriving(2000);  // chatgpt 每轮续期（更短）
  vi.advanceTimersByTime(19999);
  assert.strictEqual(fd.isFrameworkDriving(), true, '不能被更短的续期缩短');

  // 快到期时续期 2s → 窗口滚到 21.999s
  fd.markFrameworkDriving(2000);
  vi.advanceTimersByTime(1900);
  assert.strictEqual(fd.isFrameworkDriving(), true, '续期应把窗口往后滚');
  vi.advanceTimersByTime(300);
  assert.strictEqual(fd.isFrameworkDriving(), false, '滚过的窗口也要正常过期');

  // 窗口已过期时，续期用自己给的时长
  fd.resetFrameworkDriving();
  fd.markFrameworkDriving(2000);
  vi.advanceTimersByTime(2500);
  assert.strictEqual(fd.isFrameworkDriving(), false);
});

// ===== 五、scheduleAutoWake 守卫 =====

test('scheduleAutoWake 守卫：关闭 / 已停用 / 平台不在白名单 / 达上限都不调度', async () => {
  vi.useFakeTimers();
  const ev = await import('../../src/overlay/events.js');

  // 1) 开关关闭
  localStorage.setItem('cuckoo-auto-wake-enabled', '0');
  ev.scheduleAutoWake();
  assert.strictEqual(ev.getAutoWakeState().hasTimer, false, '关闭时不应调度');
  localStorage.removeItem('cuckoo-auto-wake-enabled');

  // 2) 平台不在白名单
  providerId = 'deepseek';
  ev.scheduleAutoWake();
  assert.strictEqual(ev.getAutoWakeState().hasTimer, false, '平台不在白名单时不应调度');
  providerId = 'chatgpt';

  // 3) 已停用（连续无效）
  await ev.injectWakeUpProbe();
  await vi.advanceTimersByTimeAsync(0);
  ev.handleResponseForAutoWake('纯文本 1');
  ev.handleResponseForAutoWake('纯文本 2');
  ev.handleResponseForAutoWake('纯文本 3');
  assert.strictEqual(ev.getAutoWakeState().stopped, true);
  ev.scheduleAutoWake();
  assert.strictEqual(ev.getAutoWakeState().hasTimer, false, '已停用时不应调度');
});

test('scheduleAutoWake 守卫：达到 maxCount 上限 → 停止且不再调度', async () => {
  vi.useFakeTimers();
  localStorage.setItem('cuckoo-auto-wake-delay', '1');
  localStorage.setItem('cuckoo-auto-wake-max', '1');
  const ev = await import('../../src/overlay/events.js');

  // 第 1 次：正常 arm → 到点发出（count=1）
  ev.scheduleAutoWake();
  assert.strictEqual(ev.getAutoWakeState().hasTimer, true);
  await vi.advanceTimersByTimeAsync(1500);
  assert.strictEqual(ev.getAutoWakeState().count, 1);

  // 第 2 次：已达上限 → stopped=true 且不 arm
  ev.scheduleAutoWake();
  assert.strictEqual(ev.getAutoWakeState().stopped, true);
  assert.strictEqual(ev.getAutoWakeState().hasTimer, false);
});

// ===== 六、会话切换 / 到点复核配置 =====

test('会话切换：定时器到点发现已换会话 → 不发探针且计数重置', async () => {
  vi.useFakeTimers();
  localStorage.setItem('cuckoo-auto-wake-delay', '1');
  const ev = await import('../../src/overlay/events.js');

  // 先在 sess-A 里发过一次唤醒，制造非零计数
  await ev.injectWakeUpProbe();
  await vi.advanceTimersByTimeAsync(0);
  assert.strictEqual(ev.getAutoWakeState().count, 1);

  ev.scheduleAutoWake(); // 记下 sess-A
  assert.strictEqual(ev.getAutoWakeState().hasTimer, true);

  sessionId = 'sess-B'; // 90 秒窗口内切了会话
  const before = hoisted.sendCalls;
  await vi.advanceTimersByTimeAsync(1500);

  assert.strictEqual(hoisted.sendCalls, before, '切会话后不应再发探针');
  const s = ev.getAutoWakeState();
  assert.strictEqual(s.count, 0, '跨会话应重置计数');
  assert.strictEqual(s.invalidCount, 0);
  assert.strictEqual(s.stopped, false);
  assert.strictEqual(s.hasTimer, false);
});

test('到点复核配置：arm 之后关掉开关，到点不再补发', async () => {
  vi.useFakeTimers();
  localStorage.setItem('cuckoo-auto-wake-delay', '1');
  const ev = await import('../../src/overlay/events.js');

  ev.scheduleAutoWake();
  assert.strictEqual(ev.getAutoWakeState().hasTimer, true);

  localStorage.setItem('cuckoo-auto-wake-enabled', '0'); // 用户中途关闭
  const before = hoisted.sendCalls;
  await vi.advanceTimersByTimeAsync(1500);
  assert.strictEqual(hoisted.sendCalls, before, '关闭后到点不应补发');
  assert.strictEqual(ev.getAutoWakeState().count, 0);
});

// ===== 七、投递失败后的重试（P2-3） =====

test('投递失败：30 秒后重新 arm（不计数），避免功能静默死亡', async () => {
  vi.useFakeTimers();
  localStorage.setItem('cuckoo-auto-wake-delay', '1');
  hoisted.sendOk = false;
  const ev = await import('../../src/overlay/events.js');

  await ev.injectWakeUpProbe();
  await vi.advanceTimersByTimeAsync(0);
  assert.strictEqual(ev.getAutoWakeState().count, 0, '失败不计数');
  assert.strictEqual(ev.getAutoWakeState().hasTimer, false);

  // 30 秒后 → 重新 arm 一个定时器
  await vi.advanceTimersByTimeAsync(30000);
  assert.strictEqual(ev.getAutoWakeState().hasTimer, true, '失败后应重新 arm');
});

test('会话切换：新对话导致 sessionId 变 null 也要拦（SPA 跳转不留旧会话）', async () => {
  vi.useFakeTimers();
  localStorage.setItem('cuckoo-auto-wake-delay', '1');
  const ev = await import('../../src/overlay/events.js');

  // 先制造非零计数
  await ev.injectWakeUpProbe();
  await vi.advanceTimersByTimeAsync(0);
  assert.strictEqual(ev.getAutoWakeState().count, 1);

  ev.scheduleAutoWake(); // 记下 sess-A
  assert.strictEqual(ev.getAutoWakeState().hasTimer, true);

  // ChatGPT 点「新对话」：URL 变首页 → extractSessionId() 返回 null（SPA 跳转，定时器仍在）
  sessionId = null;
  const before = hoisted.sendCalls;
  await vi.advanceTimersByTimeAsync(1500);

  assert.strictEqual(hoisted.sendCalls, before, 'sessionId 变 null 时不应把探针发进新会话');
  const s = ev.getAutoWakeState();
  assert.strictEqual(s.count, 0, '应重置计数');
  assert.strictEqual(s.invalidCount, 0);
  assert.strictEqual(s.stopped, false);
  assert.strictEqual(s.hasTimer, false);
});
