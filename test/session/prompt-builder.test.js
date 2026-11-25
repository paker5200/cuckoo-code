'use strict';
import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

// Electron 是"外部运行时边界"（其 index.js 导出的是可执行文件路径字符串，非模块）。
// 真实 Electron 下 app.getAppPath() 返回项目根；这里用 Module._load 拦截 require('electron')，
// 把 app 指到真实项目根，从而让 paths/prompt-builder 用真实模板与文件跑起来。
// 这不属于"mock 内部模块"，符合测试哲学（只模拟外部边界）。
const origLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === 'electron') {
    return {
      app: {
        getAppPath: () => process.cwd(),
        getPath: () => path.join(process.cwd(), 'test', 'tmp', 'prompt-builder-userdata'),
        isPackaged: false,
      },
    };
  }
  return origLoad.apply(this, arguments);
};

let pb;
beforeAll(async () => {
  pb = await import('../../src/session/prompt-builder.js');
});

afterAll(() => {
  Module._load = origLoad;
});

test('PROMPT_DIR 指向 src/prompt', () => {
  assert.ok(pb.PROMPT_DIR.endsWith(path.join('src', 'prompt')), pb.PROMPT_DIR);
});

test('loadTemplate 已知平台返回非空内容', () => {
  const r = pb.loadTemplate('deepseek');
  assert.ok(r.content.length > 0);
  assert.ok(!r.error);
});

// [空项目修复] chatgpt.md 的「空白项目与访问边界」章节此前零测试保护：
// 整节删掉也不会有任何用例报警，空项目场景会静默复发。这里用关键词 + 位置断言锁住。
test('loadTemplate chatgpt 含「空白项目与访问边界」章节', () => {
  const r = pb.loadTemplate('chatgpt');
  assert.ok(!r.error, r.error);
  assert.ok(r.path.endsWith('chatgpt.md'), '应读 src/prompt/chatgpt.md，实际: ' + r.path);

  const c = r.content;
  // 关键词断言（不用整段快照，避免无关排版改动就误报）
  assert.ok(c.includes('## 空白项目与访问边界'), '缺少「空白项目与访问边界」章节');
  assert.ok(c.includes('盘符根目录'), '缺少「盘符根目录」越界约束');
  assert.ok(c.includes('停下来等待用户指令'), '缺少「停下来等待用户指令」出口');
  assert.ok(c.includes('空目录是合法状态'), '缺少「空目录是合法状态」定调');

  // 位置：该章节必须在「持续执行纪律」之后、「当前项目目录」之前
  const at = c.indexOf('## 空白项目与访问边界');
  assert.ok(at > c.indexOf('## 持续执行纪律（重要）'), '该章节应排在「持续执行纪律」之后');
  assert.ok(at < c.indexOf('## 当前项目目录'), '该章节应排在「当前项目目录」之前');

  // [受阻也要停] 「完成判据」曾是"不许停"的源头之一：只要判据没满足就必须一直干，
  // 即使目标代码被压缩混淆到无法定位也只能穷举扫描（真实事故：23 次唤醒不收敛）。
  // 这条给"技术上推不动"一个合法停止出口，且带量化门槛防滥用。
  assert.ok(c.includes('**受阻也要停**'), '持续执行纪律必须有「受阻也要停」条目');
  assert.ok(c.includes('连续 3 次无实质进展'), '「受阻也要停」必须带量化门槛');
  assert.ok(c.includes('代码被压缩混淆'), '应点明典型技术障碍形态');
  // 原有「完成判据」不能被删掉，只能被补充
  assert.ok(c.includes('**完成判据**'), '「完成判据」条目必须保留');

  // [任务范围] 事故起点：用户只说"分析"，AI 分析出问题后自己升级成"修复"，
  // 然后卡在压缩代码里穷举扫描。这条必须独立成条 —— 不能只在"无任务"条件下生效，
  // 因为事故里用户**明确给了**任务。
  assert.ok(c.includes('**只做用户要求的那一件事**'), '必须独立声明任务范围约束');
  assert.ok(c.includes('交付物是**结论**'), '必须点明"分析"的交付物是结论而非代码改动');
  assert.ok(c.includes('不得写入任何文件'), '未明确要求修改时必须禁止写文件');
  assert.ok(c.includes('等用户确认后再动手'), '发现 bug 必须先等确认');
  // 位置：范围约束必须在「完成判据」之前（先划范围，再谈何时停）
  assert.ok(
    c.indexOf('**只做用户要求的那一件事**') < c.indexOf('**完成判据**'),
    '任务范围约束应排在「完成判据」之前'
  );

  // [协议字面] 走提示词路径停下时也要输出该字面，否则状态机认不到，会多烧 1~3 轮唤醒
  assert.ok(c.includes('【受阻停下】'), '提示词必须要求输出【受阻停下】协议字面');
  const mdVariants = c.match(/【受阻[^】]*】/g) || [];
  assert.ok(
    mdVariants.every((v) => v === '【受阻停下】'),
    '协议字面必须唯一写法：' + mdVariants.join(' / ')
  );
  // 自证要求：停下前必须列出这 3 次分别试了什么，且不足 3 条不许停
  assert.ok(c.includes('停下前列出这 3 次分别试了什么'), '必须要求自证这 3 次尝试');
  assert.ok(c.includes('不足 3 条不许停'), '必须显式封住"不足 3 条也停"的漏洞');

  // [受阻例外必须串进"继续"的两处] 否则三条纪律读下来是「继续 → 停 → 继续」，
  // 而且最后那句在**收尾位置**、recency 最强，会把「受阻也要停」压掉。
  assert.ok(
    c.includes('或已属「受阻也要停」情形时除外'),
    ':153「未完成就继续」必须给受阻情形开口子'
  );
  assert.ok(
    c.includes('必须继续输出 cuckoo 代码块（已属「受阻也要停」的情形除外）'),
    ':157 收口句必须给受阻例外（它在末尾，recency 压过「受阻也要停」）'
  );
});

test('loadTemplate 未知 providerId 回退 default.md', () => {
  const r = pb.loadTemplate('no-such-provider-xyz');
  assert.ok(r.content.length > 0, '应回退到 default.md');
  assert.ok(r.path.endsWith('default.md'));
  assert.ok(!r.error);
});

test('loadTemplate provider.getPromptTemplate 优先级最高', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => '来自 getPromptTemplate 的模板内容 {{TOOLS_LIST}}';
  try {
    const r = pb.loadTemplate('deepseek');
    assert.strictEqual(r.path, '(provider.getPromptTemplate)');
    assert.ok(r.content.includes('来自 getPromptTemplate'));
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('loadTemplate provider.getPromptTemplate 返回空则回退文件模板', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => '   ';
  try {
    const r = pb.loadTemplate('deepseek');
    assert.ok(r.path.endsWith('deepseek.md'));
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('loadTemplate provider.getPromptTemplate 抛错时回退文件模板', async () => {
  const { getProvider } = await import('../../src/providers/registry.js');
  const p = getProvider('deepseek');
  const orig = p.getPromptTemplate;
  p.getPromptTemplate = () => { throw new Error('模板方法崩溃'); };
  try {
    const r = pb.loadTemplate('deepseek');
    assert.ok(r.content.length > 0);
    assert.ok(!r.error);
  } finally {
    if (orig) p.getPromptTemplate = orig; else delete p.getPromptTemplate;
  }
});

test('buildPrompt 替换核心占位符', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(!r.error, r.error);
    const p = r.prompt;
    // 占位符应已被替换（不再残留）
    assert.ok(!p.includes('{{TOOLS_LIST}}'));
    assert.ok(!p.includes('{{TOOL_SECTIONS}}'));
    assert.ok(!p.includes('{{PLATFORM_INFO}}'));
    assert.ok(!p.includes('{{PROJECT_DIR}}'));
    assert.ok(!p.includes('{{MCP_SECTION}}'));
    assert.ok(!p.includes('{{TOOL_API_TYPES}}'));
    assert.ok(!p.includes('{{PROJECT_INTRO_SECTION}}'));
    // 项目目录被写入
    assert.ok(p.includes(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt PLATFORM_INFO 含当前平台信息', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('操作系统'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt isCompaction 末尾追加"请继续"并带"无任务"出口', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp, isCompaction: true });
    assert.ok(r.prompt.includes('请继续你之前的工作'), '缺少「请继续你之前的工作」');
    // [定制-flash] 这句在系统提示词**最末尾**，recency 上会压过 chatgpt.md 的
    // 「空白项目与访问边界」，故必须自带"无任务"出口，否则空项目场景又被催着找活。
    // 旧断言是 trimEnd().endsWith('请继续你之前的工作')，加了条件后缀后不再成立，
    // 改为「前缀 + 后缀关键词 + 仍是末段」三重锁定。
    assert.ok(
      r.prompt.includes('请继续你之前的工作（若用户尚未提出任何具体任务'),
      '「请继续」必须紧跟"无任务"出口，否则空项目下会驱动 AI 自己找活'
    );
    assert.ok(
      r.prompt.includes('不要向上级目录或盘符根目录搜索'),
      '该出口必须含越界搜索禁令'
    );
    assert.ok(
      r.prompt.trimEnd().endsWith('不要向上级目录或盘符根目录搜索）'),
      '该句必须仍是提示词的最后一段（不能后面再追加别的话把出口冲淡）'
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 无 CUCKOO.md 时 PROJECT_INTRO_SECTION 为空', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    // 没有项目介绍章节
    assert.ok(!r.prompt.includes('## 项目介绍'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 读取 CUCKOO.md 并注入项目介绍', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const dir = path.join(tmp, '.cuckooCode');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'CUCKOO.md'), '这是一个测试项目的介绍内容', 'utf-8');
    const r = pb.buildPrompt({ providerId: 'deepseek', selectedDir: tmp });
    assert.ok(r.prompt.includes('## 项目介绍'));
    assert.ok(r.prompt.includes('这是一个测试项目的介绍内容'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('buildPrompt 不存在的模板文件走 default（未知 provider）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuckoo-pb-'));
  try {
    const r = pb.buildPrompt({ providerId: 'nonexistent-xyz', selectedDir: tmp });
    assert.ok(!r.error);
    assert.ok(r.prompt.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
