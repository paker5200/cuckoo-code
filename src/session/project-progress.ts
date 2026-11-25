/**
 * 项目进度文件夹：自动创建、默认模板、注入提示词
 *
 * [定制-flash v2 2026-11-24] 精简为「单状态文件」结构：
 *   - 新对话开工 0 次读文件：RULES.md + STATUS.md 由 prompt-builder 自动注入系统提示词
 *   - 收尾只覆盖 STATUS.md 一个文件 + 往 LOG.md 追加一行
 *
 * 结构：
 *   项目进度/
 *   ├── RULES.md      进度规则（自动注入；可按项目修改）
 *   ├── STATUS.md     当前状态（自动注入；AI 收尾时整份覆盖，≤ 80 行）
 *   ├── GOAL.md       原始需求 / 交付物 / 验收标准 / 不做什么（需要时才读）
 *   ├── DECISIONS.md  重要决策，每条一行（需要时才读）
 *   └── LOG.md        工作流水，只追加不读
 *
 * 旧版文件（AI_CONTEXT.md / PROGRESS.md / TODO.md / 交接笔记/）不再创建，也不再被任何指令引用。
 * 注意：本文件刻意不用模板字符串和反斜杠转义，换行统一用 NL。
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROGRESS_FOLDER_NAME = '项目进度';

const NL = String.fromCharCode(10);

/** 注入提示词时单个文件的最大字符数（系统提示词过长会被网页输入框静默截断） */
const MAX_INJECT_CHARS = 6000;

/** RULES.md 默认模板：进度规则 */
const RULES_TEMPLATE = [
  '# 项目进度规则',
  '',
  '本规则和「当前状态」（项目进度/STATUS.md）在每次初始化时自动注入提示词，开工不需要再读它们。',
  '',
  '## 开工',
  '- 直接从「当前状态」的「下一步」开始干；用户本轮给了新任务，则以新任务为最高优先级。',
  '- 已勾选的里程碑、已从待办删除的事一律信任：不复查、不重跑测试、不通读代码和文档。',
  '- 按需才读：需求或验收标准不清 → GOAL.md；要做的选择以前可能做过 → DECISIONS.md；LOG.md 只写不读。',
  '- 看代码先用 grep / glob 定位，再用 read 的 offset/limit 只读相关行段，不整文件通读。',
  '- 「当前任务」和「待办」都为空、且用户没给任务：简述现状并等待指令，不要自己找活、不要扫描项目。',
  '',
  '## 防跑偏',
  '- 只做「当前任务」「待办」里的事；冒出的新想法写进「待办」，不顺手做。',
  '- 不碰「已挂起」，除非用户本轮明确要求。',
  '- 与 GOAL.md「不做什么」冲突的事，先问用户。',
  '- 同一方法失败 2 次：记入「已知的坑」，换思路或问用户，不要硬试。',
  '',
  '## 收尾（完成一项待办、用户说“收尾”、或收到【进度归档】指令时）',
  '1. 用 write 整份覆盖 项目进度/STATUS.md：≤ 80 行，保持原有标题结构；完成的待办直接删除（不留勾，不另建已完成列表）。',
  '2. 往 项目进度/LOG.md 追加一行（不要先读它）：- YYYY-MM-DD 完成了什么（涉及哪些文件）',
  '3. 有重要选择才往 项目进度/DECISIONS.md 追加一行：- YYYY-MM-DD【标题】选 X 不选 Y，因为…',
  "4. 追加方法：pwsh 执行 Add-Content -LiteralPath '项目进度/LOG.md' -Encoding UTF8 -Value '一行文字'（文字里不要带单引号；DECISIONS.md 同理）",
  '5. 总目标确实变了才改 GOAL.md；不写交接笔记。',
  '6. 回复末尾输出一行：【进度】✅ 本次完成：… ｜ ▶ 下一步：… ｜ ⚠ 需用户处理：…（没有就写“无”）',
  '',
].join(NL);

/** STATUS.md 默认模板：当前状态 */
const STATUS_TEMPLATE = [
  '# 当前状态（AI 收尾时整份覆盖；≤ 80 行；完成的待办直接删除）',
  '',
  '更新时间：YYYY-MM-DD',
  '',
  '## 一句话目标（详见 GOAL.md）',
  '- ',
  '',
  '## 里程碑',
  '- [ ] M1 ',
  '',
  '## 当前任务',
  '- 正在做：',
  '- 做到哪了：',
  '- 下一步（具体到文件/函数）：',
  '',
  '## 待办',
  '- [ ] ',
  '',
  '## 已挂起',
  '- （任务 —— 原因）',
  '',
  '## 已知的坑 / 试过没用的方案（长期保留，过时才删）',
  '- ',
  '',
  '## 项目速查',
  '- 技术栈：',
  '- 运行 / 测试命令：',
  '- 关键文件：路径 —— 作用',
  '',
].join(NL);

/** GOAL.md 默认模板：任务总目标 */
const GOAL_TEMPLATE = [
  '# 任务总目标（需求或验收标准不清时才读）',
  '',
  '> 记录最开始那个完整目标，不要用后续零散的选择/确认去覆盖它；方案选择记到 DECISIONS.md。',
  '',
  '## 原始需求（尽量一字不差）',
  '',
  '',
  '## 最终交付物',
  '',
  '',
  '## 验收标准',
  '- [ ] ',
  '',
  '## 不做什么（范围边界，防跑偏）',
  '- ',
  '',
].join(NL);

/** DECISIONS.md 默认模板 */
const DECISIONS_TEMPLATE = [
  '# 重要决策（需要做选择时才读；每条一行）',
  '',
  '格式：- YYYY-MM-DD【标题】选 X 不选 Y，因为…',
  '',
].join(NL);

/** LOG.md 默认模板 */
const LOG_TEMPLATE = [
  '# 工作流水（只追加，AI 平时不读）',
  '',
].join(NL);

interface EnsureResult {
  /** 进度文件夹的绝对路径 */
  folder: string;
  /** 是否新建了文件夹或补齐了文件 */
  created: boolean;
  /** 本次新建的文件名列表 */
  createdFiles: string[];
}

/**
 * 确保项目目录下存在「项目进度」文件夹及其文件。
 * 已存在的文件不覆盖（保护用户已有内容）。
 * @param projectDir 项目根目录
 */
function ensureProgressFolder(projectDir: string): EnsureResult {
  if (!projectDir || !projectDir.trim()) {
    throw new Error('项目目录为空，无法创建「项目进度」文件夹');
  }
  const folder = path.join(projectDir, PROGRESS_FOLDER_NAME);
  const createdFiles: string[] = [];
  let created = false;

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    created = true;
  }

  const files: Array<{ name: string; content: string }> = [
    { name: 'RULES.md', content: RULES_TEMPLATE },
    { name: 'STATUS.md', content: STATUS_TEMPLATE },
    { name: 'GOAL.md', content: GOAL_TEMPLATE },
    { name: 'DECISIONS.md', content: DECISIONS_TEMPLATE },
    { name: 'LOG.md', content: LOG_TEMPLATE },
  ];
  for (const f of files) {
    const p = path.join(folder, f.name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, f.content, 'utf-8');
      createdFiles.push(f.name);
      created = true;
    }
  }

  return { folder, created, createdFiles };
}

/** 读文件用于注入：去 BOM、去首尾空白、超长截断；失败返回空串 */
function readCapped(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    let text = fs.readFileSync(filePath, 'utf-8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.trim();
    if (text.length > MAX_INJECT_CHARS) {
      text = text.slice(0, MAX_INJECT_CHARS) + NL + '…（已截断：该文件超过 ' + MAX_INJECT_CHARS + ' 字符，请在收尾时精简）';
    }
    return text;
  } catch (_) {
    return '';
  }
}

/**
 * 生成注入系统提示词的「## 项目进度」章节（RULES.md + STATUS.md）。
 * 仅当 项目进度/STATUS.md 存在时生效，否则返回空串（不影响未使用本功能的项目）。
 */
function buildProgressSection(projectDir: string | null | undefined): string {
  if (!projectDir || !String(projectDir).trim()) return '';
  const folder = path.join(String(projectDir), PROGRESS_FOLDER_NAME);
  const statusPath = path.join(folder, 'STATUS.md');
  if (!fs.existsSync(statusPath)) return '';
  const rules = readCapped(path.join(folder, 'RULES.md'));
  const status = readCapped(statusPath);
  const parts: string[] = [
    '---',
    '## 项目进度（自动注入，开工无需再读这些文件）',
    '',
    '进度文件夹：' + folder,
    '',
  ];
  if (rules) parts.push('### 进度规则（来自 RULES.md）', '', rules, '');
  parts.push('### 当前状态（来自 STATUS.md）', '', status || '（STATUS.md 为空）', '');
  return parts.join(NL);
}

/** 生成自动开新对话后追加到系统提示词末尾的指令 */
function buildProgressInstruction(projectDir: string): string {
  const folder = path.join(projectDir, PROGRESS_FOLDER_NAME);
  return '【自动开启的新对话】上一对话因上下文过长已结束，进度已归档到「项目进度」文件夹：' + folder + '。' +
    '进度规则和当前状态已在系统提示词的「## 项目进度」章节中，不要再读 RULES.md / STATUS.md。' +
    '请直接从「下一步」继续干活，不要停下来等我确认；已完成的不重做、不复查，「已挂起」的不碰。' +
    '若用户在当前对话发布了新任务，以新任务为最高优先级。' +
    // [定制-flash] 无待办出口：否则空项目场景下「继续干活」会驱动 AI 自己找活
    '若「当前任务」和「待办」都为空，说明当前无待办：直接告诉用户并等待指令，不要自己找活干。';
}

export { ensureProgressFolder, buildProgressInstruction, buildProgressSection };
export type { EnsureResult };
