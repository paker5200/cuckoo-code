# Cuckoo Code Flash — 定制改动说明（合并上游必读）

> 本文件记录本项目相对上游 (wangyongpeng90/cuckoo-code) 的**全部定制改动**。
> 当上游更新、需要把定制合并到新版时，**先读本文件**，按"合并指南"操作。

---

## 一、定制版基本信息

| 项 | 值 |
|---|---|
| 定制版名称 | Cuckoo Code Flash |
| 基于上游版本 | 0.8.22（已合并） |
| 起点锚点 tag | flash-v0.8.7（**永远不动**，记录最初从哪个上游版本分叉） |
| 当前基线 tag | flash-v0.8.22（**每次合并上游后更新**，指向本次合并+修复完成的提交） |
| 定制开发分支 | flash-dev |
| 上游仓库 | https://github.com/wangyongpeng90/cuckoo-code |
| 上游最新版本 | 0.8.22（已合并）；master 另有 11 个**未发版**提交（剪贴板粘贴修复 / usage-stats 竞态 / Electron 升级），尚未合并 |
| 本 fork 仓库 | https://github.com/paker5200/cuckoo-code |
| 定制目的 | ①新增"自动开启新对话"上下文策略 ②改名为独立应用，与原版并存 ③新增 ChatGPT「持续工作」机制 |

> **tag 策略说明**：
> - `flash-v0.8.7` = 起点锚点，永远不动。回答"从哪个版本开始分叉"。
> - `flash-vX.Y.Z` = 当前基线，每次合并上游后新增（不是移动）。回答"当前定制版基于哪个上游版本"。
> - 正式发布时另打 `flash-release-X.Y.Z`，与基线 tag 区分（基线可能在合并后打，发布一定在打包完打）。

---

## 二、定制功能清单

### 功能 1：新增「自动开启新对话」上下文策略（核心新功能）

原来只有"自动压缩"一个开关。现改为**三选一**：
- 关闭
- 自动压缩（保留摘要，原功能）
- 自动开启新对话（不压缩，靠「项目进度」文件夹承接上下文）

#### 行为 A：保存策略为"自动开启新对话"时（立即发生）

1. **立即检查/创建** 项目目录下的「项目进度」文件夹（缺文件则按模板补齐，已存在不覆盖）
2. **弹窗告知**文件夹路径和创建结果
3. 此时**不向对话发任何消息**（因为用户往往还没发布任务）

#### 行为 B：用户发布任务后（AI 完成一轮回复时）

4. 系统**注入一次**引导消息，让 AI：读 AI_CONTEXT.md → 把总目标写进 GOAL.md → 之后每完成一项更新 PROGRESS.md / TODO.md
5. 引导**每个项目目录只注入一次**：用 localStorage 的 cuckoo-progress-guided-dirs 记录已引导目录。
   改阈值保存（如 20万→30万）不会重复注入（否则会重复打扰 AI）。换新项目目录才会重新引导。
6. 引导措辞带容错：明确要求"GOAL.md 记最开始那个完整目标，不要用后续零散选择覆盖；方案选择进 DECISIONS.md"

> 为什么分两步：保存设置时用户还没提任务，立即发"请写 GOAL.md"AI 会无内容可写。
> 故等用户真正发布任务（AI 完成一轮回复）后再引导，GOAL.md 才有意义。

#### 行为 C：token 超阈值时

7. **先发指令让 AI 把当前进度落盘**到「项目进度」文件（GOAL/PROGRESS/TODO/DECISIONS），等 AI 写完
   （等待"任务空闲"= 工具循环结束；超时 3 分钟则照常开新对话，不把用户卡死）
8. 检查/创建 项目目录下的「项目进度」文件夹（缺文件则按模板补齐，已存在不覆盖）
9. 提示"项目位置已有：项目进度 文件夹"
10. 开新对话
11. 自动初始化项目，系统提示词末尾追加：先读 AI_CONTEXT.md，再依次读 GOAL.md（总目标）、PROGRESS.md（已完成）、TODO.md（待办）；读完判断总目标完成多少、是否已全部完成；未完成则直接继续干活，全部完成则停下明确告知

> 第 7 步是本定制新增（对齐"自动压缩"先发摘要指令的做法）：确保新对话读到的进度文件是最新的，
> 而不是靠 AI 平时自觉维护。超时兜底：即使更新失败/超时，也照常开新对话。

#### 记忆优化：新对话"只读关键、信任记录、从中断处继续"

为让新对话快速接续（而非从头把已完成项全部重新核对），AI_CONTEXT.md 模板与开新对话指令均强调：
- **先读 \`交接笔记/\` 里最新一份**（含上次到哪、下一步做什么）
- 只扫 GOAL.md 整体进度 + TODO.md 待办，**不重新验证已打勾的完成项**
- **信任记录**，直接做 TODO 第一项，不重跑已完成测试/重查已改好的文件
- 依据：新对话目标是"接着干"，不是"复盘重来"。

「项目进度」文件夹结构：
    项目进度/
    ├── AI_CONTEXT.md   入口指令
    ├── GOAL.md         任务总目标（原始需求/交付物/验收标准/整体进度）
    ├── PROGRESS.md     已完成（打勾+日期）
    ├── TODO.md         待办
    ├── DECISIONS.md    决策记录
    └── 交接笔记/       每次对话结束的交接笔记

补充说明：
- GOAL.md 用于解决"多次开新对话后，AI 忘了最初任务是什么"的问题，
  让 AI 每次都能先搞清楚总目标，并据此判断任务是否全部完成。
- 触发后的行为是"自动继续干活"，不等待用户确认；
  只有判定"全部完成"时才停下告知用户。
- 为让 GOAL.md 从一开始就有内容（而非等 token 超阈值才空着），
  保存 new-chat 后、用户发布任务时会引导 AI 立即开始维护进度文件（见行为 B）。

### 功能 2：改名 Cuckoo Code Flash（与原版并存）

- 安装目录、用户数据目录、单实例锁全部独立
- 可与原版 Cuckoo Code 同时安装、同时运行
- 自动更新源改为本 fork (paker5200/cuckoo-code)

### 功能 3：ChatGPT「持续工作」机制（解决 AI 干一会儿就停）

> **问题**：ChatGPT 上 AI 每干完一步就输出纯文本收尾、等用户贴结果，任务无法连续推进。
> 上游自带的 `watchdog`（只看 SSE 流静默 5 分钟）和 `retry`（只处理报错/429）都覆盖不到
> 「正常结束回合」这种停法，所以需要单独的机制。

三件套（**默认只对 ChatGPT 生效**，其他平台需在设置页勾选或改白名单才启用）：

1. **每轮执行提醒**：每次工具结果回传的消息末尾追加一段固定文案，要求「未完成就输出下一个
   cuckoo 代码块、失败就修正重试、有进展顺手更新项目进度、汇报之后不许停在汇报上」。
2. **空闲自动唤醒**：AI 停止输出后 90 秒（可配）自动注入一条「自动唤醒·随机ID」探针，
   要求先 `log('WAKE_UP_PROBE:xxx')` 证明没卡住，再继续之前的工作。
   - 连续 3 次唤醒后 AI 仍未输出 cuckoo 代码块 → 自动停用（避免空转烧 token）
   - AI 回复含「所有任务已完成」→ 立即停用
   - 最多连续唤醒 20 次（可配，-1 = 无限）→ 达上限自动停
   - 用户真实点击/按键 → 重置全部计数与停用状态
   - 切会话 / 新对话（sessionId 变化，含变 null）→ 取消待发探针并重置计数

配置键（localStorage）：

| 键 | 默认 | 说明 |
|---|---|---|
| `cuckoo-round-reminder-enabled` | 未设置 = 开 | `'0'` 关闭本轮提醒 |
| `cuckoo-round-reminder-providers` | `chatgpt` | 生效平台白名单（逗号分隔） |
| `cuckoo-auto-wake-enabled` | `'1'` | 自动唤醒总开关 |
| `cuckoo-auto-wake-providers` | `chatgpt` | 生效平台白名单 |
| `cuckoo-auto-wake-delay` | `'90'`（秒） | 空闲多久后唤醒 |
| `cuckoo-auto-wake-max` | `'20'` | 最多连续唤醒次数，`-1` = 无限 |

设置页位置：设置 → 自动重试卡片内，「超时重试次数」下方三个控件。

#### ⚠️ 两个实现要点（改动时务必保留）

1. **`markFrameworkDriving` 时间窗是这套机制的命门**。
   框架自己发消息走 `sendInputEvent`，产生的是 `isTrusted=true` 的真实 DOM 事件，
   与用户手动点击无法用 `isTrusted` 区分。若不加时间窗，**每次框架发消息都会把唤醒计数清零**，
   导致「连续 3 次停用」和「20 次上限」永不触发 → 无限唤醒。
2. **5 秒入口窗口 + provider 逐轮续期，两者缺一不可**。
   `framework-driving.ts` 默认 5 秒只覆盖同步兜底；ChatGPT 的 `triggerSend` 是 10 轮 × 600ms
   ≈ 6 秒，必须靠 `providers/chatgpt.ts` 里**每轮 attempt 前 `markFrameworkDriving(2000)`**
   （`:125`）和兜底 click 前那次（`:163`）滚动续期。
   **删掉或调小这两处续期，P0 立刻回归。**

#### ⚠️ 任务边界（避免"为了不停而不停"）

三件套会形成很强的"必须继续"推力。**如果没有边界，AI 在没有任务时也会自己找活干**
（真实事故：选了个空文件夹初始化，AI 扫完发现是空项目，就逐级向上扫
`F:\chatgpt\空项目` → `F:\chatgpt` → `F:\` 盘根，停不下来）。

所以**三个入口必须同时带边界，缺一个就会被另一个推翻**：

| 入口 | 边界写法 | 位置 |
|---|---|---|
| 每轮执行提醒 | 停止条件双出口：① 完成判据全满足 ② 用户**本轮**尚未提出具体任务 | `chat-input.ts` `buildRoundReminder()` |
| 自动唤醒探针 | **第 0 步先判定再分支**：「没有→只回一行『所有任务已完成』并『到此结束，不要读下面的内容』」；「有→第 1 步证明 + 第 2 步继续」 | `events.ts` `buildWakeUpMessage()` |
| 初始化提示词 | 空目录是合法状态；禁止为找项目而向上级目录/盘符根目录搜索 | `prompt/chatgpt.md` 的「空白项目与访问边界」 |
| 压缩/进度开新对话 | 末尾「请继续你之前的工作」后加条件后缀（无任务/无待办则说明现状并等待） | `prompt-builder.ts` 的 `isCompaction` 分支 |
| 进度指令 | 「继续干活，不要停下来等我确认」后加「若 TODO 无 [进行中]/[待办] 则告知用户并等待」 | `project-progress.ts` `buildProgressInstruction()` |
| 失败自动重试 | 用 `buildContinueMessage()`（在 continue prompt 后拼"无任务则只回『所有任务已完成』"后缀）；**watchdog 不用**（它在你干活时触发，加出口会让你提前收工） | `continue-prompt-pool.ts` + `retry.ts` |
| **任务范围**（★最重要） | 用户说"分析/看下/说明"时**交付结论，不改文件**；除非明确说"修/改/实现/优化"，否则不得写入；发现问题只给「位置+建议改法+风险」等确认 | `chatgpt.md`「只做用户要求的那一件事」+ `chat-input.ts` 提醒独立 bullet + `events.ts` 探针前置自检 |
| **受阻停下**（运行时协议） | 停之前必须自证「同一方法连续 3 次无实质进展」（不足 3 条不许停、有未试路径也不许停、预判失败不算一次），并第一行输出 `【受阻停下】`；状态机认这个字面 → 立即停用唤醒 + 弹 toast | `chat-input.ts` 第③条 / `chatgpt.md`「受阻也要停」/ `events.ts` 探针第三分支 + `handleResponseForAutoWake` |

> **探针的结构演进（别再改回去）**：最初是「无条件祈使句『直接接着做』在前 + 例外句『仅当你没有任务…』在后」，
> 模型会照前一句执行，空项目下照样自己去扫盘。现在改成第 0 步判定 → 分支，
> 且「所有任务已完成」在整条探针消息里**只出现 1 次**（`handleResponseForAutoWake` 靠该字面立即停用）。
> 测试断言锁了：判定在「直接接着做」之前、字面唯一性、旧收尾句已删。

**改其中任何一处时，另外两处必须同步复核**——单改一处等于没改（尤其别漏探针：
它是 90 秒后才生效的"第三只手"，最容易在验收时被忽略）。

#### 与「项目进度」体系的关系（重要）

- 本机制**不引入** `updateState` 之类的新状态工具，避免与「项目进度」文件夹双写。
- 提醒文案里只让 AI「顺手更新 TODO.md / PROGRESS.md」，状态权威源仍是那套文件。
- ChatGPT 不下发累积 token（`accumulatedTokens` 恒为 `null`），所以 `checkAutoCompact()`
  在 ChatGPT 上**永不触发**「自动开启新对话」。为此另做了两件事补偿：
  - 每轮提醒里带「有进展就更新进度文件」，保证文件平时就是新鲜的；
  - 上下文真正耗尽走 `context-exhausted-continue` 时，**追加「先读 项目进度/AI_CONTEXT.md」**
    的指令，避免新会话失忆（这是 ChatGPT 上真正换会话的路径）。

#### 已知遗留（下次动这块时一并处理）

1. `project-progress.ts` 的 `buildProgressInstruction()` 出口**零测试覆盖**——`test/` 下没有该模块的测试文件，
   删掉那句出口没有任何测试会红。（补 8 行用例即可，但**测试文件会进 asar**，所以别在打包期间加。）
2. `events.ts` 里 `buildWakeUpMessage()` 的**注释**中还留着旧文案字面（「如果你已经完成了所有工作」），
   仅注释、不影响运行时；但将来若写"grep 源码"式断言会误判。
3. `package.json` 的 `build.files` 缺 `!test` → **整个 `test/` 目录（约 745K / 106 个文件）一直被打进 asar**。
   属既有打包卫生问题，不是本次引入。要修必须单独跑一次完整打包+启动验证。
4. `continue-prompt-pool.ts` 的 1000 条继续提示词**全都没有"无任务"出口**。本次只在 `retry.ts` 和
   「卡住了」按钮外面包了 `buildContinueMessage()` 加后缀，池子本身没动。
   `watchdog.ts`、`observer.ts`（两处）仍是裸 `pickContinuePrompt()`，未加出口。
5. **门槛对「缺信息」类障碍是空转**：`连续 3 次无实质进展` 这个门槛，对"用户没给未压缩版本"这类
   一次性可判定的障碍不适用（每次试的方法不同，凑不满 3 次同一方法）。改它要动整句结构。
6. **任务范围目前只有文案约束**：要硬约束得在会话上标记 taskKind（分析类/修改类），
   分析类对 `write/edit` 走人工确认。属产品决策，未做。

#### ⚠️ 这三条是本模块的"契约"，改动时必须三处同步

任何一处单独改都会让另外两处把它推翻（历史事故：只改了提示词和提醒，漏了探针，90 秒后又被踢回穷举扫描）：

1. **`【受阻停下】` 必须三处都有**（`chat-input.ts` 第③条、`chatgpt.md`、`events.ts` 探针第三分支），
   且**字面完全一致**（不能有「【受阻停止】」这类变体），否则状态机 `indexOf` 匹配不到，AI 停了也会被再催 3 次。
2. **门槛必须用「且」**：`技术障碍**且**同一方法连续 3 次无实质进展`。写成顿号平列（或）会让 3 次门槛形同虚设——
   命中"代码被压缩无法定位"一条就能停。测试里有跨文件一致性断言锁这个。
3. **提醒里的「一律继续」必须带「且不属于第 ③ 种情况」**，否则会盖掉第 ③ 出口。

---

## 三、逐文件改动清单

（改动的文件如果上游也改了，就是冲突高发区，合并时重点看这里）

### 🟢 新增文件（上游不会有，永不冲突，合并时保留即可）

- **src/infra/framework-driving.ts**（★v0.8.22 起，「持续工作」机制的命门）
  极简叶子模块（无任何 import，避免 `chat-input → providers/registry → providers/chatgpt → chat-input` 回环）。
  导出 `markFrameworkDriving(ms=5000)` / `isFrameworkDriving()` / `resetFrameworkDriving()`。
  状态挂在 `globalThis.__ckFrameworkDrivingUntil`，多份模块图共享同一实例。
  `mark` 语义为**只延长不缩短**（`if (until > 当前值)`），因此 provider 的 2 秒续期不会把入口窗口写小。
  ⚠️ 如果上游新增了"能区分合成事件与真实事件"的 API，可以改用那个，届时本模块可删。

- **test/overlay/auto-wake-reminder.test.js**（新增测试，20 例）
  覆盖：提醒文案/白名单/开关、唤醒配置默认值、状态机四条路径、`scheduleAutoWake` 四个守卫、
  会话切换（含 sessionId 变 null）、投递失败重试、框架驱动窗口、以及**真驱动 `chatgpt.triggerSend`
  10 轮循环**验证逐轮续期确实生效。
  其中「框架驱动期间不重置计数」和「真驱动续期」两条是关键回归保护，删守卫/删续期时必须失败。

- **src/session/project-progress.ts**
  新增模块。负责创建「项目进度」文件夹 + 默认模板（AI_CONTEXT.md / GOAL.md / PROGRESS.md / TODO.md / DECISIONS.md / 交接笔记/），
  导出 ensureProgressFolder() 和 buildProgressInstruction()。
  注意：GOAL.md（任务总目标）是为了让 AI 在多次开新对话后仍记得最初任务、并能判断是否全部完成。
  AI_CONTEXT.md 模板里规定了记录规则：完成功能→PROGRESS.md，重要选择→DECISIONS.md，新待办→TODO.md，目标变化→GOAL.md。
  **v0.8.22 起**：AI_CONTEXT 模板的「任务收尾与汇报纪律」段末尾加了一句引用块
  「汇报之后若任务仍未完成，必须继续输出 cuckoo 代码块推进，不得停在汇报上」——
  保留每轮汇报的格式，但不让它变成机器停顿点。

### 🟡 功能相关改动（上游若改了同一文件，需小心合并）

- **src/overlay/chat-input.ts**（v0.8.22 起，「持续工作」相关）
  - 顶部 import `markFrameworkDriving` from `../infra/framework-driving.js`
  - `triggerSend()` **函数体第一行**调 `markFrameworkDriving()`（默认 5 秒）
  - 新增 `readRoundReminderProviders()` / `shouldApplyRoundReminder()` / `buildRoundReminder()`
  - `sendCombinedJsResultsToChat()` 在 `applyResultTransform(...)` 之后、`findInputArea()` 之前
    追加 `if (shouldApplyRoundReminder()) msg += sep + sep + buildRoundReminder();`
  - `SYSTEM_MSG_TAGS` 增加 `'自动唤醒'`（探针算系统消息，不当用户消息上报）
  - 定制点：`markFrameworkDriving` 调用位置、三个提醒函数、SYSTEM_MSG_TAGS 那一项

- **src/prompt/chatgpt.md**（v0.8.22 起）
  - 在 `### 错误处理` 之后、`## 当前项目目录` 之前新增 `## 持续执行纪律（重要）` 章节（6 条）。
  - 在 `## 持续执行纪律` 之后、`## 当前项目目录` 之前**再新增** `## 空白项目与访问边界（重要）` 章节（4 条）：
    声明「空目录是合法状态」、禁止为"找真正的项目"而向上级目录/盘符根目录/其它路径搜索、
    判断是否继续的依据是"用户是否提出具体任务"而非"目录看起来没内容"。
    **起因**：用户选了空文件夹初始化，AI 扫完空目录后逐级向上爬（`F:\chatgpt\空项目` → `F:\chatgpt` → `F:\`）。
  - 同章节的 `## 持续执行纪律` 里，第 2 条与停止闸门都带上了「用户尚未提出具体任务」的例外回指
    （否则「不许停」的三条规则会压过「可以停」的一条，模型按交集读会继续自己找活）。
  - ⚠️ **只改 chatgpt.md**，不要改 `deepseek.md` / `claude.md` / `default.md` —— 其它平台行为保持不变。
  - ⚠️ 若用户在设置页用「系统提示词模板」编辑过（存 SQLite），**SQLite 自定义模板优先级高于 md**
    （`prompt-builder.ts` 的优先级 0），此时改 md 不生效，要改 SQLite 里的那份。

- **src/providers/chatgpt.ts**（v0.8.22 起，★续期命门）
  - 顶部 import `markFrameworkDriving`
  - `triggerSend` 的 10 轮循环里，**每轮 attempt 首行** `markFrameworkDriving(2000)`
  - 末尾兜底 `btn2.click()` 之前再 `markFrameworkDriving(2000)`
  - ⚠️ 这两处是 5 秒入口窗口能撑过 6 秒循环的唯一原因，**删掉或调小 → 唤醒计数会被框架自身事件清零 → 无限唤醒**

- **src/overlay/panels/settings.ts**（v0.8.22 起）
  - `SettingsData` 新增 `autoReminderEnabled` / `autoWakeEnabled` / `autoWakeDelay` 三个字段
  - `getSettingsData()` 读三个键、`applySettingsData()` 校验（延迟必须正整数）并按需写回、
    `resetSettingsData()` 的 KEYS 追加三个键

- **src/ui/shell/scripts/pages/settings-react.tsx**（v0.8.22 起）
  - `retry` 卡片内、`超时重试次数` 之后追加 3 个控件（2 个 ToggleRow + 1 个数字输入），约 425-431 行
  - ⚠️ 改完必须 `node scripts/build-shell.mjs` 重新生成 `src/ui/shell.html`
  - 注意：`src/ui/shell/partials/pages/settings.html` **已不被加载**（设置页已 React 化），别改错文件

- **src/app/ipc/session.ts**
  - 顶部新增 import：ensureProgressFolder, buildProgressInstruction from '../../session/project-progress.js'
  - 新增 IPC handler：'new-conversation-with-progress'（token 超阈值时用）
  - 新增 IPC handler：'ensure-progress-folder'（保存 new-chat 时仅建文件夹，不导航）
  - **v0.8.22 起新增**：`context-exhausted-continue` handler 里，组装完 `extraPrompt` 之后追加
    「【进度上下文】…先读 AI_CONTEXT.md / 交接笔记 / GOAL.md / TODO.md」一段
    （仅当 `项目进度` 文件夹存在时追加）。这是 ChatGPT 上真正换会话的路径，
    **不追加这段，新会话必然失忆**（ChatGPT 无 token，走不到阈值触发的 new-chat）。
  - 定制点：新增的两个 handler 块 + context-exhausted-continue 里的进度上下文段

- **src/bridge/api.ts**
  - electronAPI 新增方法 newConversationWithProgress（调 IPC 'new-conversation-with-progress'）
  - electronAPI 新增方法 ensureProgressFolder（调 IPC 'ensure-progress-folder'）
  - 定制点：updateProjectDir 之后新增的几行

- **src/bridge/entry.ts**
  - 'cuckoo-save-autocompact' 回调改为 async（因 applyAutoCompactConfig 变 async）
  - 定制点：那一行加 await

- **src/overlay/events.ts**（改动最大，冲突高发）
  - autoCompactEnabled(bool) → contextMode('off'|'compact'|'new-chat')
  - 新增 readContextMode()（含旧配置迁移）
  - loadAutoCompactConfig / saveAutoCompactConfig 改为读写 mode
  - checkAutoCompact() 按 mode 分支：compact 走原 runCompaction，new-chat 走 triggerNewChatWithProgress
  - 新增 triggerNewChatWithProgress()（token 超阈值时开新对话）
  - getAutoCompactConfig / applyAutoCompactConfig 返回/接收 mode（兼容旧 enabled 字段）
  - applyAutoCompactConfig 改为 async：保存 new-chat 时调 ensureProgressFolder 建文件夹，
    并 setPendingProgressGuide() 记下"待注入引导"
  - 新增 PENDING_PROGRESS_KEY / read/set/clearPendingProgressGuide（localStorage 标志）
  - 新增 GUIDED_DIRS_KEY / hasGuidedDir / markGuidedDir（记录已引导过的项目目录，同目录只引导一次）
  - 新增 maybeInjectProgressGuide()：在 onTaskIdle（AI 完成一轮回复）时注入一次进度维护引导，
    注入后 markGuidedDir() 标记该目录；applyAutoCompactConfig 里对已引导目录跳过重复设置
  - 新增 taskIdleWaiters / waitForNextTaskIdle() / resolveTaskIdleWaiters()（等待下一次任务空闲）
  - 新增 flushProgressThenNewChat()：token 超阈值开新对话前，先发指令让 AI 落盘进度，
    等 AI 写完（任务空闲）再开；超时 3 分钟则照常开新对话
  - checkAutoCompact() 的 new-chat 分支改调 flushProgressThenNewChat()
  - startTokenCounter() 的 onTaskIdle 回调改为先 resolveTaskIdleWaiters()，
    再 maybeInjectProgressGuide()，最后 checkAutoCompact()
  - 定制点：所有含 contextMode / new-chat / 项目进度 / progress-guide / taskIdle 的逻辑
  - **v0.8.22 起新增「空闲自动唤醒」整块**（约 632-900 行，`// ========== [定制-flash] 空闲自动唤醒 ==========`）
    - `readAutoWakeConfig()`：读 4 个 localStorage 键，默认 `{enabled:true, providers:['chatgpt'], delayMs:90000, maxCount:20}`
    - `scheduleAutoWake()`：记录 `autoWakeSessionId`，`setTimeout` 到点执行；四个守卫（未启用 / 已停用 / 平台不在白名单 / 达上限）
    - 定时器回调：先重读配置并复核 provider 白名单，再校验 `getCurrentSessionId()` 与 arm 时是否一致
      （**无条件比较 `sidNow !== autoWakeSessionId`**，任一侧为 null 也算变化），最后才 `injectWakeUpProbe()`
    - `injectWakeUpProbe()`：发「【Cuckoo 自动唤醒·<id>】」探针，投递失败 30 秒后重试一次（不计数）
    - `handleResponseForAutoWake()`：回复含「所有任务已完成」→ 立即停用；含 cuckoo → invalid 清零；
      否则 invalid+1，累计 3 次停用
    - `handleUserActivityForAutoWake()`：**首行 `if (isFrameworkDriving()) return;`**，用户真实操作才重置计数
    - `onTaskIdle` 回调：开头 `cancelAutoWake()`，末尾 `if (!willNewChat) scheduleAutoWake()`
    - `onInterceptedResponse` 回调：追加 `handleResponseForAutoWake(_text)`
  - **v0.8.22 修复的两个既有缺陷**
    - `maybeInjectProgressGuide()`：改为 `const ok = await sendToChat(...)`，失败时恢复 `setPendingProgressGuide`，
      `markGuidedDir` 只在成功分支（原实现先清 pending，发送失败后**该目录永久不再引导**）
    - `flushProgressThenNewChat()`：删掉虚假的「系统会校验文件时间戳」文案；
      路径拼接改用本地 `joinFsPath()`（渲染进程不能 import `node:path`）

- **src/overlay/panels/settings.ts**（修复上游遗留 bug）
  - applySettingsData()：goalMaxIterations 缺失时不再报错拦截，改为沿用当前存储值（默认 50）。
    原因：壳页面设置页不提供该字段，上游却强制校验，导致壳页面保存任何设置都被拦截。
  - 上游 0.8.10 已自行修复此 bug（goalMax: number | null，缺失时保留原值）。
    ✅ 合并 0.8.10 时已接受上游版本，本定制点不再需要，后续冲突直接取上游即可。

- **src/ui/shell/scripts/pages/token-react.tsx**（★v0.8.18 起的主战场）
  - 上游已把 Token 页从 HTML+TS 重构为 React 组件（`registerPage('token', TokenPage)`）。
  - 我们的定制已迁移进此文件：`auto` 状态由 `{ enabled: boolean }` 改为 `{ mode: 'off'|'compact'|'new-chat' }`；
  - UI 从"自动压缩开关"（ck-switch）改为"上下文策略"三选一单选（ck-radio-group）；
  - `loadAuto` 读 `r.data.mode`；`onSaveAuto` 提交 `{ mode, threshold }`，
    且 mode==='new-chat' 成功后弹窗反馈 progressFolder / progressCreated / progressHint。
  - ⚠️ 下次合并若上游再改此文件，重点保住 mode 三态、radio 组、new-chat 弹窗反馈这三块。

- **src/ui/shell/partials/pages/token.html**（v0.8.18 起已废弃）
  - 上游改 React 后此文件不再被加载（`main.ts` 只 import token-react）。
  - 我们在此文件里加的三选一 radio 已迁移到 token-react.tsx；此文件可忽略或删除。

- **src/ui/shell/scripts/pages/token.ts**（v0.8.18 起已废弃）
  - 同上，已被 token-react.tsx 取代，定制逻辑已迁移。不再有引用点。

- **src/ui/shell/styles/pages.css**
  - 新增 .ck-radio-group / .ck-radio-item 样式（v0.8.18 合并时已保留）

- **src/ui/shell/scripts/pages/about-react.tsx**（★v0.8.18 起）
  - 上游 about 页也 React 化了，且链接被改回 wangyongpeng90。
  - 需改回 paker5200：`openExternal('https://github.com/paker5200/cuckoo-code')` + 显示文本。

### 🔵 改名相关改动（机械性，冲突时按"保留 Flash 名"原则处理）

- **package.json**
  - name: cuckoo-code → cuckoo-code-flash
  - build.appId: com.cuckoo.cuckoo-code → com.cuckoo.cuckoo-code-flash
  - build.productName: Cuckoo-Code → Cuckoo Code Flash
  - build.publish.owner: wangyongpeng90 → paker5200
  - artifactName（win/mac/nsis）: cuckoo-code-* → cuckoo-code-flash-*
  - build.files 新增 "!**/*.log"（★关键，见第八节"打包注意事项"）
  - build.publish 新增 "releaseType": "release"（★关键：electron-builder 默认发草稿，
    而 electron-updater 看不到草稿；必须设为 release 正式发布，已装旧版才能检测到更新）
  - ⚠️ version 字段每次上游更新必冲突，合并时**取上游的新版本号**（如 0.8.9），不要保留旧版

- **src/app/entry.ts**
  - SESSION_DIR: 'cuckoo-ai-pro-session' → 'cuckoo-code-flash-session'（★关键，决定数据隔离+单实例锁）
  - 窗口标题 'Cuckoo Code Pro' → 'Cuckoo Code Flash'（2 处）
  - 关于菜单 label 'Cuckoo Code' → 'Cuckoo Code Flash'

- **src/app/ipc/renderer.ts**
  - 通知窗口名 'Cuckoo Code' → 'Cuckoo Code Flash'

- **src/ui/shell/scripts/pages/about-react.tsx**
  - github 链接 wangyongpeng90 → paker5200（2 处：openExternal 的 URL + 显示文本）
  - ⚠️ v0.8.18 起 about 页已 React 化，旧的 partials/pages/about.html 与 scripts/pages/about.ts 不再加载

- **src/ui/shell/scripts/pages/token-react.tsx**
  - 上下文策略三选一（见上"功能相关改动"），上游每次重做 Token 页都要重新迁移

- **src/app/ipc/session.ts**（v0.8.18 补充）
  - 二进制文件冲突（编码/行尾差异），合并时**不要依赖 git 自动合并**。
  - 正确做法：`git checkout master -- src/app/ipc/session.ts` 取上游版本，
    再手工加回 3 个 handler（export-session-log / new-conversation-with-progress / ensure-progress-folder）
    和顶部 import（project-progress.js）+ `const { ipcMain, dialog, app } = require('electron')`。

- **src/overlay/events.ts**（v0.8.18 补充）
  - 上游 v0.8.18 已把 onTaskIdle 简化为 `hooks.onTaskIdle?.(() => checkAutoCompact())`。
  - 合并后必须把定制逻辑补回：`resolveTaskIdleWaiters()` → willNewChat 分支判断 →
    `maybeInjectProgressGuide()` / `checkAutoCompact()`。
  - 这一段 git 不会报冲突（上游删改后自动合并），必须人工核查。

### ⚫ 生成物（不要手动合并！）

- **src/ui/shell.html**
  - 这是由 node scripts/build-shell.mjs 从 src/ui/shell/ 源码生成的。
  - 合并时：**随便选一边，然后重新跑 node scripts/build-shell.mjs 覆盖即可。**
  - 永远以 src/ui/shell/ 下的源码为准。

---

## 四、合并上游的完整流程

前提：已配置 upstream 远程（见第六节）。

    # 1. 切到 master（master 只跟上游，不含定制）
    git checkout master
    git fetch upstream
    git merge upstream/master
    # 若提示 fast-forward，直接过；master 现在 = 上游最新

    # 2. 切到定制分支
    git checkout flash-dev

    # 3. 把上游新版合进定制分支
    git merge master
    #   出现冲突时：对照本文件第三节，逐文件处理

    # 4. 【v0.8.18 新增】安装依赖
    #    上游引入 react/react-dom，package-lock 换新后必须装，否则 build-shell 会报
    #    "Could not resolve react" 而失败（33 个错误）。
    npm install

    # 5. 【关键】源码合并完后，重新生成 shell.html
    node scripts/build-shell.mjs
    #    产物约 5.26MB（v0.8.22 时实测 5,260,915 字节；内联了 monaco/echarts + 全量 CSS，正常）
    #    若报 Could not resolve "react" → 回到第 4 步

    # 6. 验证
    npm run typecheck
    npx vitest run
    #    v0.8.18 基线：102 个测试文件 / 964 个测试全过

    # 7. 提交并推送分支
    git add -A
    git commit -m "merge: 合并上游 X.X.X 到 flash-dev"
    git push origin flash-dev

    # 8. 【重要】打当前基线 tag 并推送（不移动旧 tag，每次合并后新增）
    git tag -a flash-vX.Y.Z -m "定制基线：基于上游 vX.X.X（含本次合并修复）"
    git push origin flash-vX.Y.Z

    # 9. 【重要】用户验收通过后，同步更新"合并话术模板"
    #    两个位置（内容必须一致）：
    #    - F:\deepseek\合并话术模板.txt
    #    - C:\Users\Administrator\Desktop\合并话术模板.txt
    #    需要更新的情况（只要出现其一就更新）：
    #      a) tag 策略变化（如新增基线 tag、起点锚点变动）
    #      b) 合并流程有新增步骤（如 npm install、npm run compile）
    #      c) 踩到新坑需要写进"铁律"
    #      d) 常用命令有新增/改动
    #    注意：AI 不会自动扫描这两个文件（它们在 projectDir 之外），
    #    必须由用户明确要求"同步更新合并话术模板"才会执行。

### ⚠️ v0.8.18 合并特别提醒（下次合并务必先看）

1. **Token 页已 React 化**：`token.html` / `token.ts` 废弃，定制迁到 `token-react.tsx`。
   `main.ts` 用 `registerPage('token', TokenPage)` 挂载，只认 React 版。
2. **about 页已 React 化**：`about-react.tsx` 里的 GitHub 链接会被上游改回 wangyongpeng90，需改回 paker5200。
3. **session.ts 是二进制冲突**：git 无法自动合并（报 "Cannot merge binary files"）。
   必须 `git checkout master -- src/app/ipc/session.ts` 取上游版，再手工加 3 个 handler。
4. **events.ts 的 onTaskIdle 会被静默覆盖**：上游删成一行 `hooks.onTaskIdle?.(() => checkAutoCompact())`，
   git 不报冲突，必须人工核对并补回 resolveTaskIdleWaiters / willNewChat 分支 / maybeInjectProgressGuide。
5. **新增依赖**：react / react-dom / @types/react / @types/react-dom，合并后先 `npm install`。

### ⚠️ v0.8.22 合并特别提醒（「持续工作」机制的命门）

1. **`src/infra/framework-driving.ts` 是新增叶子模块**，上游不会有，保留即可。若上游新增了
   能区分合成事件的方法，可考虑替换掉时间窗方案。
2. **`providers/chatgpt.ts` 里两处 `markFrameworkDriving(2000)` 绝对不能丢**（循环每轮 + 兜底 click 前）。
   上游若重写了 ChatGPT 的 `triggerSend`，必须把这两处补回去，否则唤醒计数会被框架自身事件清零
   →「连续 3 次停用」和「20 次上限」全部失效 → 无限唤醒烧 token。
3. **`events.ts` 的 `handleUserActivityForAutoWake` 首行守卫**（`if (isFrameworkDriving()) return;`）
   同样不能丢。上游改 events.ts 时这里不会报冲突，必须人工核查。
4. **设置页在壳页面 React（`settings-react.tsx`）**，不在 overlay。改完必须 `build-shell`。
   `src/ui/shell/partials/pages/settings.html` 已废弃、不再被加载，别改错文件。
5. **ChatGPT 没有 token 计数是上游事实**（`accumulatedTokens` 恒为 null），
   所以 `checkAutoCompact()` 在 ChatGPT 上不触发是**预期行为**，不要当 bug 修。
   进度接续靠「每轮提醒顺手更新进度文件」+「耗尽续接时补读 AI_CONTEXT」两条兜底。

---

## 五、冲突处理原则（重要）

遇到冲突时，按下面的优先级判断：

1. **功能保留**：你的"自动开启新对话"和"项目进度"相关改动（events.ts、project-progress.ts、session.ts 的 handler、token-react.tsx 的三选一）一律保留。
2. **改名保留**：Flash 的名字、appId、SESSION_DIR、publish 指向 paker5200，一律保留。
3. **上游新功能**：上游新增的功能代码，尽量接受。
4. **version**：取上游的新版本号，不要卡在旧版（当前应为 0.8.22；若上游发新版则跟随）。
5. **shell.html**：不对抗，合并后重新生成。

不确定时，把冲突片段和本文件一起给 AI，让 AI 判断"这段是你的定制还是上游的更新"。

---

## 五-补、血泪教训：设置面板被原生视图遮挡的终极修复（v0.8.18 合并后排查）

> ⚠️ **这是 v0.8.18 升级后最坑的一个 Bug。设置面板弹出来后，右侧被 AI 聊天窗完美覆盖，左侧无法点击，或者根本看不见。**

### 1. 为什么会被遮挡？
v0.8.18 中，上游将整个 UI 重构为 React，并使用了 Electron 的底层 API `BrowserWindow` + `WebContentsView` 组合（以前是 `BrowserView`）。
- **原生视图层级最高**：在 Electron 中，原生的 `WebContentsView`（即 AI 聊天页面）永远浮在 DOM 之上，CSS 的 `z-index: 9999` 对它完全无效。
- **上下文丢失**：以前隐藏视图靠 `getContextByWebContents` 找窗口，但在新架构下，壳页面本身也是个 View，传进来的 `sender` 经常匹配不到，导致隐藏逻辑直接 `return` 了。
- **弹窗竞态**：如果打开设置面板时，后台刚好有关闭的提示框（如 `ckAlert`），它退出时会触发 `setAiViewVisible(true)`，瞬间把刚隐藏的 AI 视图又放出来。

### 2. 终极修复方案（最终版，务必保留）

> ⚠️ **重要警告：曾经尝试过的 `removeChildView` 物理拔除方案已被废弃！**
> 该方案会导致取消选目录时网页彻底白屏（视图从 contentView 拔除后无法正确恢复），
> 且会破坏 Electron 内部的焦点和尺寸计算。**绝对不要再用 `removeChildView`！**

**最终采用方案**：
- **纯 setVisible 控制**：主进程的 `shell-set-ai-view-visible` 只调用原作者的 `win.__ckSetAiViewVisible(visible)`，
  由它内部处理 `__ckAiViewVisible` 标志位 + `layoutView()` 重排，不自己动 `contentView`。
- **前端互斥锁**：`shell-frame.tsx` 用 `__ckModalOpen` 标记设置面板打开状态，
  `shared.ts` 的 `ckAlert`/`ckConfirm` 关闭时检查该锁，防止误恢复视图。
- **独立的 `shell-hide-native-views` / `shell-show-native-views` 接口**：给设置面板专用，
  内部同样只调用 `__ckSetAiViewVisible`，不做任何 `contentView` 操作。

### 3. 涉及改动点（下次合并务必人工核查）
- `src/app/ipc/shell.ts`：`shell-set-ai-view-visible` / `shell-hide-native-views` / `shell-show-native-views` 三个 handler，**只能调 `__ckSetAiViewVisible`**。
- `src/app/shell-preload.ts`：暴露 `setAiViewVisible` / `hideNativeViews` / `showNativeViews`。
- `src/ui/shell/scripts/shell-api.ts`：对应类型定义。
- `src/ui/shell/scripts/shell-frame.tsx`：`onSettingsClick` / `closeSettings` / `useEffect`。
- `src/ui/shell/scripts/shared.ts`：`aiViewLeave` 里检查 `__ckModalOpen`。
- ⚠️ **绝对禁止**：`win.contentView.removeChildView(...)`（会导致白屏）。

### 4. ⚠️ 打包必死坑（非常重要）
> 在修改了 `.ts` 或 `.tsx` 源码后，**绝对不要直接跑 `npx electron-builder`！**
> 必须先跑 **`npm run compile`**，把最新的 TypeScript 源码编译到 `out/` 目录，否则 electron-builder 打包进去的依然是上一次的旧代码，导致“改了代码却毫无效果”的灵异现象！

### 5. 初始化弹窗"发送按钮无响应"的终极修复（v0.8.18 合并后）

> ⚠️ **症状**：点击"开启新对话"选好目录后，点"发送"按钮毫无反应（不弹窗、不关闭、不报错）。

**根因分析**：
1. 弹窗打开时调用了 `setAiViewVisible(false)` 隐藏了原生 AI 视图。当视图被隐藏时，DOM 渲染进程会被系统挂起（尺寸坍缩为 0），导致 `sendToChat` 找不到有宽度的输入框，静默失败。
2. 更关键的是：React 化后壳页面的 DOM 会被重新排列，传统 `onclick` 绑定在节点上的监听器可能在弹窗渲染时已经失效。

**修复方案**：
- **前端 `init-prompt.ts`**：改用**事件委托（Event Delegation）**绑定到 `document`，确保无论 DOM 怎么变，点击始终生效。点击瞬间立刻 `alert` 确认，然后隐藏弹窗、唤醒 AI 视图、`setTimeout` 300ms 后发起 IPC 发送，完全非阻塞。
- **主进程 `harness.ts`**：发送前强制调用 `win.__ckSetAiViewVisible(true)` 兜底唤醒视图。
- **接收端 `harness-bridge.ts`**：加入最多 20 次、间隔 500ms 的自动重试机制，确保视图从隐藏恢复后 DOM 渲染完成，再执行 `sendToChat`。
- **前端防空**：如果用户未填内容，自动填入"请开始分析该项目。"，绝不静默退出。

**涉及文件（下次合并务必人工核查）**：
- `src/ui/shell/scripts/init-prompt.ts`（全量重写为事件委托）
- `src/app/ipc/harness.ts`（send-init-message 强制唤醒视图）
- `src/bridge/harness-bridge.ts`（接收端加重试）

### 6. 偶发"工具调用被中断"提示说明

> 如果偶尔看到 AI 后面跟着 `<system>该工具调用被中断或未被处理。请为工具调用提供有效输入。</system>`，**这是 DeepSeek 页面原生的提示，不是 Cuckoo Code 的 BUG**。

**原因**：AI 生成 cuckoo 代码块时，流式输出被中断（可能是网络波动或服务端限流），导致输出的代码块不完整（如少了闭合的 ``````），DeepSeek 检测到后会自动插入这条提示，要求 AI 重新发送。

**处理方式**：偶发不需要处理，AI 会自动重试。如频繁出现，请检查网络稳定性或 DeepSeek 服务状态。

---

## 六、upstream 远程配置（若还没配）

    git remote add upstream https://github.com/wangyongpeng90/cuckoo-code.git
    git fetch upstream

验证：

    git remote -v
    # 应看到 origin(你的fork) 和 upstream(上游) 两个

---

## 七、分支策略

- **master**：只用来同步上游，保持"干净"（不含定制）。定期 git fetch upstream && git merge upstream/master。
- **flash-dev**：所有定制改动都在这里开发。日常工作和发布都用这个分支。
- **tag flash-v0.8.7**：定制基线，方便日后定位"从哪个版本开始定制"。

---

## 八、打包命令（生成 Cuckoo Code Flash 安装包）

    npm run build:win:nsis:local

产物在 dist/ 下：cuckoo-code-flash-win-v{版本号}.exe

### ⚠️ 打包注意事项（血泪教训，务必遵守）

1. **绝对不要在项目目录内写打包日志 / 临时文件。**
   例如不要写 `npm run build:win:nsis:local > build.log 2>&1`。
   原因：package.json 的 build.files 含 "**/*"（打包进所有文件），
   而被持续写入的日志文件大小会中途变化，导致 electron-builder 生成的
   asar 头部偏移与实际数据错位 → 整个 app.asar 损坏 →
   安装后双击**无任何反应**（主进程解析 package.json 失败，退出码 1，无日志）。

   正确做法：日志写到项目外，例如
       npm run build:win:nsis:local > %TEMP%\ccbuild.log 2>&1

2. 已加防护：build.files 含 "!**/*.log"，即使误在项目内产生 .log 也不会打进 asar。
   但"写入中的任意文件"都可能破坏 asar，所以**根因是别在项目内写构建期间的临时文件**，
   "!**/*.log" 只是兜底，不是万能。

3. 若打包后双击无反应，优先检查 asar 是否损坏：
   用 @electron/asar 的 extractFile 读 app.asar 里的 package.json，
   正常应能 JSON.parse 成功且 name=cuckoo-code-flash；若报 JSON 非法，即 asar 已损坏，需清理 dist 重新打包。

### ✅ 打包后必做自检

    # 1) 校验 asar 内 package.json 是否合法
    node -e "import('@electron/asar').then(a=>console.log(a.default.extractFile('dist/win-unpacked/resources/app.asar','package.json').toString().slice(0,80)))"
    # 2) 实测启动（应能保持运行，而非秒退）
    #    双击 dist/win-unpacked/Cuckoo Code Flash.exe 或安装后运行

---

## 九、发布到 GitHub Releases（让自动更新生效）

### 前提

1. package.json 的 version 改成新版本号（如 0.8.9）
2. package.json 的 build.publish 含 "releaseType": "release"
   （★不加则默认发草稿，electron-updater 检测不到）
3. 本机 .git-credentials 里有 GitHub token（ghp_ 开头，需 repo 权限）

### 命令

    # 1) 提交版本改动并推送
    git add package.json && git commit -m "release: X.X.X"
    git push origin flash-dev

    # 2) 设置 token（从 .git-credentials 读取，切勿硬编码/提交）
    set GH_TOKEN=<你的token>

    # 3) 构建并发布（--publish always 会自动创建 Release 并上传）
    npm run build:win:nsis

### 产物（会自动上传到 Release）

- cuckoo-code-flash-win-v{版本}.exe
- cuckoo-code-flash-win-v{版本}.exe.blockmap
- latest.yml   ← 自动更新的"版本清单"，updater 靠它判断有无新版

### 验证发布成功

    # 用 GitHub API 查 Release（draft 必须为 false）
    # GET https://api.github.com/repos/paker5200/cuckoo-code/releases
    # 期望：tag=vX.X.X, draft=false, prerelease=false, assets 三个 state=uploaded

### 常见坑

1. **EPERM: rename win-unpacked.tmp 失败** → dist 被残留进程/杀软占用。
   解决：清理 dist 后重试（Remove-Item dist -Recurse -Force）。
2. **updater 检测不到新版本** → 检查 Release 是不是 draft（草稿）。
   草稿对 updater 不可见，必须 releaseType=release。
3. **私人仓库收不到更新** → 私人仓库的 Release 需 token 才能访问，
   而已装旧版没配 token，故检测不到。要自动更新就得公开发布。
4. 发布是对外公开操作，确认无误再执行；发布后可删除（删 Release + 删远端 tag）。

---

## [2026-11-24] 项目进度 v2：单状态文件 + 自动注入
- project-progress.ts：模板改为 RULES / STATUS / GOAL / DECISIONS / LOG，不再创建 AI_CONTEXT / PROGRESS / TODO / 交接笔记；新增 buildProgressSection()
- prompt-builder.ts：存在 项目进度/STATUS.md 时，把 RULES.md + STATUS.md 注入系统提示词末尾（单文件上限 6000 字符）
- events.ts：归档指令、首次引导改为新文件结构
- ipc/session.ts：context-exhausted-continue 的进度段改为“已注入，不要再读”，判断条件改为 STATUS.md 存在
- chat-input.ts：每轮提醒改为完成待办时覆盖 STATUS.md + 追加 LOG.md
- compaction.ts：交接提示在有「项目进度」时只做 git status 抽查，不通读项目
- token-react.tsx / token.ts：设置页提示文案
- 定制点：以上所有含 项目进度 / STATUS.md / RULES.md / buildProgressSection 的逻辑
