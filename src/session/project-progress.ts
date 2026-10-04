/**
 * 项目进度文件夹：自动创建与默认模板
 *
 * 用途：当"自动开启新对话"触发时，不压缩上下文，而是靠 `{项目目录}/项目进度/`
 * 下的文件承接上下文，让 AI 在长任务/大项目中保持连续性。
 *
 * 结构：
 *   项目进度/
 *   ├── AI_CONTEXT.md   入口指令（告诉 AI 该读哪些文件、如何记录）
 *   ├── GOAL.md         任务总目标（原始需求 / 交付物 / 验收标准 / 整体进度）
 *   ├── PROGRESS.md     已完成事项（打勾 + 日期）
 *   ├── TODO.md         待办
 *   ├── DECISIONS.md    重要决策及原因
 *   └── 交接笔记/        每次对话结束的交接笔记（按日期命名）
 */
import fs from 'node:fs';
import path from 'node:path';

export const PROGRESS_FOLDER_NAME = '项目进度';

/** AI_CONTEXT.md 默认模板：入口指令 */
const AI_CONTEXT_TEMPLATE = `# AI 上下文入口

> 本文件是给 AI 的**第一入口**。每次开新对话，AI 应先读本文件，再按下面指示读其它文件。

## 请 AI 按顺序执行

1. 读 \`GOAL.md\` —— **先搞清楚总目标是什么**（原始需求、交付物、验收标准、整体进度）
2. 读 \`PROGRESS.md\` —— 了解**已完成**的工作（打勾项 + 日期）
3. 读 \`TODO.md\` —— 了解**待办**事项
4. 读完判断：**总目标完成了多少、还差什么、是否已全部完成**
5. 确认后，**直接自动继续未完成的工作**，不要停下来等用户确认
6. 若发现所有目标都已完成，**停下并明确告诉用户"任务已全部完成"**

## 干活过程中的记录规则

- 完成一个功能 → 更新 \`PROGRESS.md\`（打勾并加日期），并同步勾掉 \`GOAL.md\` 里对应的整体进度
- 做了重要选择 → 把"为什么这么选"记到 \`DECISIONS.md\`
- 冒出新待办 → 加到 \`TODO.md\`
- 发现总目标有变化 → 更新 \`GOAL.md\`

## 每次对话结束前（最重要）

更新 \`GOAL.md\`（整体进度勾选）、\`PROGRESS.md\`、\`TODO.md\`，并在 \`交接笔记/\` 下按模板写一份
\`交接笔记/YYYY-MM-DD.md\`，重点写：

- 关键改动
- 踩的坑
- 试过没用的方案
- 下一步建议
`;

/** GOAL.md 默认模板：任务总目标 */
const GOAL_TEMPLATE = `# 任务总目标

> 本文件记录**最开始的任务是什么**。每次开新对话，AI 应先读本文件，
> 搞清楚"我们到底在做什么、要做到什么程度"，再看进度。

## 原始需求

<!-- 把用户最开始提的完整需求记在这里，尽量一字不差 -->

## 最终交付物

<!-- 做完之后应该是什么样子 -->

## 验收标准

<!-- 怎么判断真的完成了（可勾选） -->
- [ ] 

## 整体进度

<!-- 把任务拆成模块/阶段，完成一个勾一个 -->
- [ ] 
`;

/** PROGRESS.md 默认模板 */
const PROGRESS_TEMPLATE = `# 进度记录

> 记录**已完成**的工作。每完成一项就打勾并加日期，格式：\`- [x] 事项（YYYY-MM-DD）\`

## 已完成

<!-- 在这里追加已完成事项 -->

## 进行中

<!-- 在这里记录当前正在做的事项 -->
`;

/** TODO.md 默认模板 */
const TODO_TEMPLATE = `# 待办事项

> 记录**待办**。完成一项后移动到 PROGRESS.md 并打勾。

## 待办

<!-- 在这里追加待办事项 -->
`;

/** DECISIONS.md 默认模板 */
const DECISIONS_TEMPLATE = `# 重要决策记录

> 记录重要的技术/设计选择，以及"为什么这么选"。

## 决策列表

<!-- 格式：
## YYYY-MM-DD 决策标题
- 背景：
- 选项：
- 决定：
- 原因：
-->
`;

/** 交接笔记示例模板（仅用于首次创建时的说明，不强制生成具体文件） */
const HANDOFF_README = `# 交接笔记

> 每次对话结束前，在这里按日期新建一份笔记，例如 \`2026-10-03.md\`。

模板要点：
- 关键改动
- 踩的坑
- 试过没用的方案
- 下一步建议
`;

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
 * @param projectDir 项目根目录（如 D:\\Mirserver）
 */
function ensureProgressFolder(projectDir: string): EnsureResult {
  if (!projectDir || !projectDir.trim()) {
    throw new Error('项目目录为空，无法创建「项目进度」文件夹');
  }
  const folder = path.join(projectDir, PROGRESS_FOLDER_NAME);
  const createdFiles: string[] = [];
  let created = false;

  // 1) 文件夹
  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true });
    created = true;
  }

  // 2) 各文件（存在则跳过）
  const files: Array<{ name: string; content: string }> = [
    { name: 'AI_CONTEXT.md', content: AI_CONTEXT_TEMPLATE },
    { name: 'GOAL.md', content: GOAL_TEMPLATE },
    { name: 'PROGRESS.md', content: PROGRESS_TEMPLATE },
    { name: 'TODO.md', content: TODO_TEMPLATE },
    { name: 'DECISIONS.md', content: DECISIONS_TEMPLATE },
  ];
  for (const f of files) {
    const p = path.join(folder, f.name);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, f.content, 'utf-8');
      createdFiles.push(f.name);
      created = true;
    }
  }

  // 3) 交接笔记子目录
  const handoffDir = path.join(folder, '交接笔记');
  if (!fs.existsSync(handoffDir)) {
    fs.mkdirSync(handoffDir, { recursive: true });
    const readme = path.join(handoffDir, 'README.md');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, HANDOFF_README, 'utf-8');
    created = true;
  }

  return { folder, created, createdFiles };
}

/** 生成"先读进度文件"的指令（追加到系统提示词末尾） */
function buildProgressInstruction(projectDir: string): string {
  const folder = path.join(projectDir, PROGRESS_FOLDER_NAME);
  return '先读 ' + path.join(folder, 'AI_CONTEXT.md') +
    '，然后按里面说的依次读 GOAL.md（总目标）、PROGRESS.md（已完成）、TODO.md（待办）。' +
    '读完先判断总目标完成了多少、还差什么、是否已全部完成；' +
    '若未完成，直接自动继续未完成的工作，不要停下来等我确认；' +
    '若已全部完成，停下并明确告诉我"任务已全部完成"。';
}

export { ensureProgressFolder, buildProgressInstruction };
export type { EnsureResult };
