# Cuckoo Code Flash — 定制改动说明（合并上游必读）

> 本文件记录本项目相对上游 (wangyongpeng90/cuckoo-code) 的**全部定制改动**。
> 当上游更新、需要把定制合并到新版时，**先读本文件**，按"合并指南"操作。

---

## 一、定制版基本信息

| 项 | 值 |
|---|---|
| 定制版名称 | Cuckoo Code Flash |
| 基于上游版本 | 0.8.10（已合并；定制基线为 0.8.7） |
| 定制基线 tag | flash-v0.8.7（历史锚点，不动） |
| 定制开发分支 | flash-dev |
| 上游仓库 | https://github.com/wangyongpeng90/cuckoo-code |
| 上游最新版本 | 0.8.10（已合并；tag 之后另有 13 个插件相关 commit 未纳入） |
| 本 fork 仓库 | https://github.com/paker5200/cuckoo-code |
| 定制目的 | ①新增"自动开启新对话"上下文策略 ②改名为独立应用，与原版并存 |

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

---

## 三、逐文件改动清单

（改动的文件如果上游也改了，就是冲突高发区，合并时重点看这里）

### 🟢 新增文件（上游不会有，永不冲突，合并时保留即可）

- **src/session/project-progress.ts**
  新增模块。负责创建「项目进度」文件夹 + 默认模板（AI_CONTEXT.md / GOAL.md / PROGRESS.md / TODO.md / DECISIONS.md / 交接笔记/），
  导出 ensureProgressFolder() 和 buildProgressInstruction()。
  注意：GOAL.md（任务总目标）是为了让 AI 在多次开新对话后仍记得最初任务、并能判断是否全部完成。
  AI_CONTEXT.md 模板里规定了记录规则：完成功能→PROGRESS.md，重要选择→DECISIONS.md，新待办→TODO.md，目标变化→GOAL.md。

### 🟡 功能相关改动（上游若改了同一文件，需小心合并）

- **src/app/ipc/session.ts**
  - 顶部新增 import：ensureProgressFolder, buildProgressInstruction from '../../session/project-progress.js'
  - 新增 IPC handler：'new-conversation-with-progress'（token 超阈值时用）
  - 新增 IPC handler：'ensure-progress-folder'（保存 new-chat 时仅建文件夹，不导航）
  - 定制点：新增的两个 handler 块

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

- **src/overlay/panels/settings.ts**（修复上游遗留 bug）
  - applySettingsData()：goalMaxIterations 缺失时不再报错拦截，改为沿用当前存储值（默认 50）。
    原因：壳页面设置页不提供该字段，上游却强制校验，导致壳页面保存任何设置都被拦截。
  - 上游 0.8.10 已自行修复此 bug（goalMax: number | null，缺失时保留原值）。
    ✅ 合并 0.8.10 时已接受上游版本，本定制点不再需要，后续冲突直接取上游即可。

- **src/ui/shell/partials/pages/token.html**
  - "自动压缩"开关（ck-switch）→ "上下文策略"三选一单选（ck-radio-group）

- **src/ui/shell/scripts/pages/token.ts**
  - loadAutoCompact / 保存逻辑改为读写 mode（name="tk-context-mode" 的 radio）
  - 保存 new-chat 成功后弹窗反馈文件夹路径，并说明"发布任务后 AI 会自动维护进度文件"

- **src/ui/shell/styles/pages.css**
  - 新增 .ck-radio-group / .ck-radio-item 样式

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

- **src/ui/shell/partials/pages/about.html**
  - github 链接 wangyongpeng90 → paker5200

- **src/ui/shell/scripts/pages/about.ts**
  - github 链接 wangyongpeng90 → paker5200

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

    # 4. 【关键】源码合并完后，重新生成 shell.html
    node scripts/build-shell.mjs

    # 5. 验证
    npm run typecheck
    npx vitest run

    # 6. 提交并推送
    git add -A
    git commit -m "merge: 合并上游 X.X.X 到 flash-dev"
    git push origin flash-dev

---

## 五、冲突处理原则（重要）

遇到冲突时，按下面的优先级判断：

1. **功能保留**：你的"自动开启新对话"和"项目进度"相关改动（events.ts、project-progress.ts、session.ts 的 handler、token 页）一律保留。
2. **改名保留**：Flash 的名字、appId、SESSION_DIR、publish 指向 paker5200，一律保留。
3. **上游新功能**：上游新增的功能代码，尽量接受。
4. **version**：取上游的新版本号，不要卡在 0.8.7。
5. **shell.html**：不对抗，合并后重新生成。

不确定时，把冲突片段和本文件一起给 AI，让 AI 判断"这段是你的定制还是上游的更新"。

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
