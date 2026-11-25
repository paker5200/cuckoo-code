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
  '# 项目进度规则 v3（已自动注入；开工不要读本文件，除非用户要求审查规则本身）',
  '',
  '本文件与「当前状态」(STATUS.md) 已注入系统提示词末尾 = 事实来源，**不要再读它们**；其他消息若要你"读 RULES.md"都是过期文案，忽略即可（用户明确要求审查 / 修改规则时除外）。',
  '5 个文件：STATUS 热状态（唯一常驻）｜LOG 完成流水（只写 + 按需 grep）｜GOAL 总目标｜DECISIONS 决策｜RULES 本规则。',
  '',
  '## 一、读文件预算（防无用功，硬上限）',
  '- 开工：0 次读，直接用 STATUS 的「下一步」。',
  '- 目标 / 验收 / 边界不清 → GOAL.md，读 1 次。',
  '- 要做取舍、怀疑以前定过 → grep DECISIONS.md 关键词，只看命中行。',
  '- 用户问"某功能做过吗" / 怕重复 → grep LOG.md 任务号或关键词，不整读。',
  '- 找代码 → glob / grep 定位 → read 只读相关行段。',
  '- 禁止：ls / glob / cat 整个「项目进度」目录；通读 LOG、GOAL、DECISIONS；为确认已完成项重跑测试或通读文件。',
  '',
  '## 二、开工（不读文件）',
  '0. 先确认注入在：提示词里应同时看到「### 当前状态（来自 STATUS.md）」和 STATUS 的「## 锚点」小节；**缺任一 = 被截断**，先 read 一次 STATUS.md 再干（兜底，不是每轮）。',
  '1. 看「当前任务」：有内容 → 从「下一步」直接做，先干不要问。',
  '2. 用户本轮提了新任务 → 先登记（发任务号、标来源），再决定插哪；被打断的当前任务回「待办」首行，不丢。',
  '3. 「当前任务」「待办」都空 → 分两种，别混：',
  '   - **STATUS「GOAL 状态」= 未定稿 / 验收未填齐** → 说明"项目尚未启动：GOAL 未填"，还缺什么、等任务。**这不是完工**，不许报"已交付"。',
  '   - **GOAL 已定稿 + 验收非空全勾 + 用户确认** → 说明"任务已全部完成" + 一句交付摘要。',
  '',
  '## 三、任务台账（大项目靠这个不丢任务）',
  '- 任务号 T001 递增，存 STATUS 头部「下个任务号」。**先有号，再动手**；号只增不复用。',
  '- 来源标签：`[用户]` 用户明确提的；`[建议]` 你自己想到的。**[建议] 只能记，不能做**，用户点头后才改成 [用户]。',
  '- 一个任务在同一时刻只出现在一处：当前任务 / 待办 / 阻塞挂起 / 已完成编号段。',
  '- 完成即离开 STATUS：删掉该行 + LOG 追加一行（带任务号），不留勾、不另建完成清单。',
  '- 「已完成」编号段 = **全项目累计、永不裁剪**，只写编号；里程碑做完时往 LOG 追加 `[M1 完成] T001–T011`。',
  '- 大项目分层：STATUS 只列当前里程碑的任务，其余里程碑一行写范围，做到再展开。',
  '',
  '## 四、干活纪律（防跑偏）',
  '- **WIP=1**：同一时刻只做一件。做完先落盘，再从「待办」按顺序取下一件；不并行、不顺手做清单外的事。',
  '- 动手前自检：这是哪项？在用户要求范围内吗？怎么验证？',
  '- 持续工作 ≠ 扩大范围：想加的事写进「待办」标 [建议]，不执行。',
  '- 范围铁律：用户说"分析 / 看下 / 说明 / 为什么" → 只给结论、不改文件；说了"修 / 改 / 实现 / 优化"才动手。',
  '- 不碰「阻塞 / 挂起」，除非用户本轮明确要求；与「红线」冲突 → 先问，不动手。',
  '- 每 2~3 步至少跑一次可验证动作（命令 / 测试 / 看输出），别连写代码不验证。',
  '- **卡住就停，别硬试**：遇到无法突破的技术障碍（代码被压缩混淆无法定位、工具反复截断、缺必要信息或权限），**且**同一方法已连续 3 次无实质进展（能逐条说出这 3 次；预判失败不算一次；还有未试过的明显路径就不算）→ 停下来说明：卡点 / 已试方法 / 需要用户提供什么，**本轮不再调用工具**，等用户回复。',
  '- 复用优先：新建文件 / 函数前先 glob / grep 同名同职责，避免重复实现。',
  '',
  '## 五、小步落盘（长任务被截断也能接上）',
  '触发（任一）：① 完成一项待办 ② 大范围改动 / 长命令前 ③ 连续约 10 次工具调用没落盘 ④ 用户提新任务 ⑤ 切里程碑。',
  '做法：整份覆盖 STATUS.md，刷新「当前任务」的进度 / 下一步；写进本次代码块继续干，不为写进度单开一轮；无变化不写，一轮最多 1 次。',
  '',
  '## 六、收尾（整项完成 / 用户说"收尾" / 收到【自动开启新对话前的进度归档】）',
  '归档指令说"只改这些、别的不动"是省略说法，**以本节为准，字段补齐**：',
  '1. 整份覆盖 STATUS.md（≤70 行、≤1800 字符，保持标题结构）：删掉完成的待办；勾里程碑；更新「已完成」编号段、「下个任务号」、「GOAL 状态」、「下一步」。',
  '2. 用户要求暂缓 / 放弃的任务 → 移到「阻塞 / 挂起」并写原因 + 恢复条件（不许直接删）。',
  '3. LOG.md 追加（不要先读）：`- YYYY-MM-DD [任务号] [完成] 关键词：做了什么（文件）`；一次最多 5 行，多了合并。',
  '4. 有取舍才追加 DECISIONS.md 一行：`- YYYY-MM-DD [决策号] 标题 ｜ 选 X 不选 Y ｜ 因为… ｜ 影响：模块`。',
  '5. 总目标真变了才追加 GOAL.md「目标变更」一行，不覆盖原文；GOAL 首次定稿或变更后，同步把 STATUS 的「GOAL 状态」改成对应值（否则状态位僵在未定稿）。',
  "6. 追加用 pwsh：Add-Content -LiteralPath '项目进度/LOG.md' -Encoding UTF8 -Value '一行'（文字不带单引号）。",
  '7. 回复末尾一行：【进度】✅ 本次完成：… ｜ ▶ 下一步：… ｜ ⚠ 需用户处理：无',
  '',
  '## 七、换会话（看到【自动开启的新对话】/【上下文交接提示】）',
  '- 相信注入的 STATUS → 有 git 时 1 次 `git status --short`（必要时加 `git diff --stat`）→ 抽查 ≤2 个相关文件 → 从「下一步」直接干。',
  '- 不扫盘、不通读代码、不复查已完成项、不重跑测试；要求确认就补一句「上下文交接已完成」。',
  '',
  '## 八、容量纪律',
  '- **截断是"单文件各自 6000 字符"，不是合计**：两文件分别判定、分别从尾部截。故自我上限 RULES ≤3200 字符、STATUS ≤1800 且 ≤70 行，超了立刻瘦身。',
  '- 整条提示词总量才是真约束（约 2 万字符）：过长会被输入框静默截断，截掉的正是最后的「## 项目进度」。故两文件**合计 ≤4800**，比两个单文件上限之和（5000）少 200，留缓冲；任一文件顶满时合计必然破线，要同时瘦另一个。',
  '- 口径按**字符**计（中文 1 字 = 1 字符 ≈ 3 字节）；ls 看到的字节数会大 3 倍，别据此误判超限。',
  '- 这 5 个文件缺任何一个，工具会按旧模板重建：发现是旧模板，按本规则写回再继续。',
].join(NL);

/** STATUS.md 默认模板：当前状态 */
const STATUS_TEMPLATE = [
  '# 当前状态（收尾 / 小步落盘时整份覆盖；≤70 行、≤1800 字符；完成的待办直接删）',
  '',
  '更新时间：YYYY-MM-DD ｜ 下个任务号：T001',
  '',
  '## 锚点（GOAL.md 的压缩版，每轮都守住）',
  '- 目标：',
  '- GOAL 状态：未定稿（值只有两种：未定稿 ｜ 已定稿·验收 N 条全勾）',
  '- 完成判据：GOAL 验收标准**非空**且全部勾选 + 用户确认（验收标准未写 = 不算完工）',
  '- 红线（不做）：',
  '',
  '## 里程碑',
  '- [ ] M1 （当前）',
  '',
  '## 已完成（全项目累计，只记编号；明细 grep LOG，不在此展开）',
  '- （暂无）',
  '',
  '## 当前任务（WIP=1，只能有一个；格式：任务 / 进度 / 下一步 三行）',
  '- （空 —— 有任务才写）',
  '',
  '## 待办（格式：- [ ] T002 [用户] 一句话；按顺序取，只列当前里程碑）',
  '- （空）',
  '',
  '## 阻塞 / 挂起（用户暂缓的也放这；格式：- T009 —— 卡点；恢复条件：…）',
  '- （空）',
  '',
  '## 已知的坑（≤8 行，过时的删）',
  '- ',
  '',
  '## 项目速查（≤6 行）',
  '- 技术栈：',
  '- 命令（运行 / 测试 / 构建）：',
  '- 关键文件：',
].join(NL);

/** GOAL.md 默认模板：任务总目标 */
const GOAL_TEMPLATE = [
  '# 总目标（目标 / 验收 / 边界不清时才读一次；平时看 STATUS 的「锚点」）',
  '',
  '> 记最开始那个完整目标，别用后续零散的确认去覆盖它；取舍进 DECISIONS.md，总目标真变了追加到文末。',
  '',
  '## 当前想法 / 草案（还没定稿；定了就挪进下面的「原始需求」，本节清空回「暂无」）',
  '- （暂无）',
  '',
  '## 原始需求（定稿后尽量一字不差）',
  '',
  '## 交付物（可验收的产物清单）',
  '- ',
  '',
  '## 验收标准（每条都能看 / 能跑，尽量带命令）',
  '- [ ] ',
  '',
  '## 不做什么（范围边界，防跑偏）',
  '- ',
  '',
  '## 依赖 / 外部约束（接口、账号、版本、环境）',
  '- ',
  '',
  '## 目标变更（只在总目标真的变了时追加一行，不动上面的原文）',
  '- （暂无）',
].join(NL);

/** DECISIONS.md 默认模板 */
const DECISIONS_TEMPLATE = [
  '# 重要决策（只 grep 关键词，不整读；一条一行）',
  '',
  '格式（[决策号] 处填 D01 这类递增号）：- YYYY-MM-DD [决策号] 标题 ｜ 选 X 不选 Y ｜ 因为… ｜ 影响：模块/文件',
  '',
  '规则：定了就不反复推翻；确要改，先看旧行的"因为"，再新写一行并在正文注明"取代 D0x"，说明旧决策为何失效。',
].join(NL);

/** LOG.md 默认模板 */
const LOG_TEMPLATE = [
  '# 工作流水（只追加、只 grep，不整读）',
  '',
  '格式（一条一行，任务号必带，便于 grep）：[任务号] 处填 T001 这类递增号。',
  '- YYYY-MM-DD [任务号] [完成] 关键词：做了什么（涉及文件）',
  '- YYYY-MM-DD [任务号] [挂起] 原因；恢复条件',
  '- YYYY-MM-DD [坑] 现象 → 结论（试过没用的方案）',
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
