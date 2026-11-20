# 本地观察与执行

> 状态：2026-11-20。仅管理员；所有会改变磁盘、进程或外部网站的动作都必须由你批准。

她可以在你授权的目录里查看文件，也可以提议写文件、跑命令、操作网页。她能做的只是**提交申请**：执行永远由管理员点头。入口在「系统管理 → 本地观察」（`/local-observe`）。

## 能力总览

| 能力 | 入口 | 是否需要批准 | 记录表 |
| --- | --- | --- | --- |
| 授权目录管理 | 本地观察 | 否（你自己的操作） | `local_access_roots` |
| 列目录 / 读文本 / 搜索 | 本地观察、桌面聊天 | 否 | 审计文件 |
| 写文件 | 桌面聊天提议 → 写审批 | 是 | `local_write_requests` |
| 终端命令、Git 新分支 | 桌面聊天提议 → 命令审批 | 是 | `local_command_requests` |
| 任务档案 / 步骤 / 验收 | 任务档案 | 验收由你判定 | `local_tasks`、`local_task_evidence` |
| 网页只读观察 | 本地观察、桌面聊天 | 否（只读） | 审计文件 |
| 网页操作（点击、填写、滚动） | 桌面聊天提议 → 网页操作 | 是 | `local_browser_requests` |
| 表单提交 | 二次确认 | 是（两次） | 同上 |

## 授权目录

- 内置「项目目录」永远存在、不可移除，且始终只读；
- 最多 20 个目录；必须是**已存在的绝对目录**；
- 拒绝：盘符根、`C:\Windows` / `Program Files` / `ProgramData`、整个用户目录、路径中含 `.data`；
- 目录有两种模式：`READ_ONLY`（默认）与 `READ_WRITE`；只有可写目录才能提议写文件、命令和网页操作以外的本地副作用；
- 停用后立即退出观察范围；移除只删白名单记录，不删磁盘文件。

## 只读查看

- 列目录最多 300 项；
- 读文本上限 256 KB，二进制与超限文件不预览；
- 搜索按文件名或内容，返回最多 100 条，搜索词最多 100 字符；
- 以下目录不进入观察范围：`node_modules`、`.git`、`.nuxt`、`.output`、`.data`、`dist`、`backups` 等；
- 敏感文件不可读也不可写：`.env*`、`*.key`、`*.pem`、`*.pfx`、`*.p12`、`credentials-encryption.key`、`onebot-*.json`；
- 接口只接受相对路径，绝对路径、`..`、指向根外的符号链接都会被拒绝。

## 写文件（需审批）

1. 她调用 `propose_file_write`，提交 `root / path / content / reason`；
2. 服务端创建 `PENDING` 请求，校验目录可写、路径在根内、敏感与忽略规则、内容 ≤32 KB、目标文件 ≤2 MB；
3. 在「写审批」里核对路径、原因与正文，批准后才落盘；拒绝则什么都不写；
4. 批准时校验文件自提议后有没有被改过（`baseHash`），改过就失败，避免覆盖别人的修改；
5. 落盘后从磁盘读回，与批准内容逐字节比对，结果显示在任务档案与聊天结果卡片。

工具结果只会返回「待审批」，不会返回“已写入”。

## 终端命令与 Git（需审批）

- 只接受白名单可执行文件：`node`、`python`、`python3`、`cargo`、`go`、`dotnet`；这是入口限制，不是系统级沙箱，批准前仍需核对参数；
- 不经过 shell，参数是数组，避免 `&`、管道和命令替换；
- 超时 120 秒，stdout/stderr 各截断 64 KB，超时杀掉整个进程树；
- 执行完追加一条 `COMMAND` 证据（退出码、输出），**不会**替你判定任务通过。

Git：「本地观察」选目录后点「Git」，可看当前分支、工作区与暂存区改动清单，以及单个文件的工作区或暂存差异（最多 100 条）。仓库需有实体 `.git` 目录，不支持链接工作树或子模块。新建分支走命令审批：提议时固定当前提交，HEAD 变了要重新提议；批准只建分支，不切换、不提交、不推送。

## 任务档案

一条任务按「目标 → 计划 → 步骤 → 审批 → 验收证据」串起来：

- 写请求带 `taskId` 时任务变「待审批」，批准后变「进行中」；
- 待审批或正在执行的请求没处理完，不能提交最终验收；
- 已完成、失败或取消的任务不能再改验收结论；
- 取消任务会撤销关联的待批请求；已在执行的等它结束；取消不回滚已执行的操作；
- 验收证据分三类：`WRITE_READBACK`（磁盘读回）、`COMMAND`（退出码与输出）、`BROWSER`（页面操作），以及你手动记录的结论。系统证据只陈述事实，最终 PASS/FAIL 由你确认。

步骤一次建立、最多 20 项，必须按顺序推进；步骤可以关联本任务内的写文件、命令或网页审批，状态跟着审批结果走。**关联步骤不会提交审批或执行操作**，审批仍在各自面板完成。旧任务没有步骤时沿用原流程。

## 聊天里的她

只在**管理员桌面聊天**可用：

- 只读工具：`list_local_roots`、`list_local_directory`、`read_local_file`、`search_local_files`；
- 有可写目录时才加 `propose_file_write` 与 `propose_terminal_command`；
- `propose_browser_actions` 与网页操作不依赖本地目录，管理员聊天里始终可用；
- 浏览器：`observe_public_browser`（观察）只能读你本轮消息里出现的精确网址；
- 续办时额外给 `read_current_local_task`，且必须先读它才能提新申请；
- 单轮最多 4 次工具调用、最多 4 个回合，按实际调用数计算；
- QQ 与群聊不启用任何本地工具，避免群里的人借她读本机文件或操作网页。

**结果卡片**：聊天里显示「本次会话的本地任务」，每 5 秒刷新，只展示当前管理员、角色、会话关联的任务与网页操作。读回内容是系统证据，不冒充角色回复，也不写进聊天消息或长期记忆。

**手动续办**：卡片上的「继续下一步」发起原会话的一轮聊天，仍受同一套审批约束。输入框有未保存文字时不会覆盖。

**无人值守续办**（默认关闭）：任务详情可打开「自动继续」，审批完成且无待批请求时服务端自动发起下一轮。三重限制缺一不可：环境变量 `YILING_AUTO_CONTINUE=1`、任务开关、每任务轮次上限（默认 3、硬上限 5，先占用后发起）。碰到待批请求、待确认表单或任务结束立即停下并写 `task.auto` 审计。它仍然只能提交申请，不能自己执行。

## 浏览器

复用本机安装的 Chrome/Edge，但每次都是**全新的无登录会话**：不用你的浏览器窗口、用户资料或 Cookie，结束即关闭，截图不落库。

**只读观察**：输入网址，查看截图和渲染后文字。所有页面资源经 DNS 固定与公网校验的下载器转交；只放行指定来源的 GET，跨来源跳转、提交、WebSocket、弹窗、下载、嵌入子页面一律拦截。因此跨站图片/脚本不会加载，部分网页会不完整。单次最长 25 秒、最多 40 个请求，可见文字最多 6000 字符。

**网页操作**：步骤只有四种——按选择器点击、按文字点击、填写、滚动，每次最多 10 步；某步找不到元素就停下，不会带着错位页面继续。批准前可点「先看页面」只看当前页面，不执行任何步骤。执行时提交按钮、密码框、文件上传直接拒绝，响应头禁止表单提交，非 GET 与跨站请求照旧拦截。

**填表与提交（两阶段）**：表单动作末尾可加 `{"kind":"submit","selector":"…"}`，这一步被单独取出：

1. 第一次批准只填写，状态变 `FILLED`，申请里记录每个字段实际填了什么——那就是将要发出的内容，此时不发送任何数据；
2. 再点「确认提交」才重新打开页面、重放填写并点提交，把表单真正发给网站。

提交阶段只允许同源表单，表单 `action` 指向别的网站会被拒绝；发出前对目标地址再做一次公网校验，解析到本机或私网就中止。不确认就等于没提交，「不提交了」从 `FILLED` 直接转 `REJECTED`，失败会记 `FAILED` 并保留原因。

## 审计

每次列目录、读取、搜索、提案、批准、执行都会追加一行到 `<data>/local-exec-audit.jsonl`：时间、管理员 ID、动作、路径或来源、结果摘要。**不记录文件正文**，也不进长期记忆。

## 接口

全部仅管理员可用，契约见 `docs/openapi.yaml` 的 `LocalObserve` 路径。

- 观察：`GET /api/local/observe/{root|roots|list|read|search}`、`GET /api/local/observe/git`、`POST /api/local/observe/git-branch`
- 目录：`GET/POST /api/local/roots`、`PATCH/DELETE /api/local/roots/{id}`
- 写文件：`GET /api/local/write-requests`、`POST /api/local/write-requests/{id}/{approve|reject}`
- 命令：`GET /api/local/command-requests`、`POST /api/local/command-requests/{id}/{approve|reject}`
- 任务：`GET/POST /api/local/tasks`、`GET/PATCH /api/local/tasks/{id}`、`POST /api/local/tasks/{id}/{evidence|cancel|steps}`
- 网页：`POST /api/local/browser/observe`、`GET /api/local/browser-requests`、`POST /api/local/browser-requests/{id}/{approve|reject|submit}`

## 回归测试

- `yarn test:local-observe`、`test:local-write`、`test:local-command`、`test:local-git`
- `yarn test:local-task`、`test:local-chat-results`、`test:auto-continue`
- `yarn test:browser-observe`、`test:browser-actions`（真实 Chromium + 离线网络夹具，需本机装有 Chrome/Edge）
- `yarn test:readonly-tools`（工具白名单、参数校验、预算与聊天接线）

浏览器测试不访问真实 QQ 或付费模型。

## 已知限制

- 网页不支持登录态，需要登录的网站在观察和操作里都只能看到未登录视图；
- 跨站资源被拦，依赖第三方 CDN 的页面可能显示不全；
- 表单提交只支持同源；
- 没有桌面软件（窗口、外部应用）操作能力；
- 终端白名单只限制入口，不对脚本内部的系统调用做沙箱；
- 无人值守默认关闭，且永远只能提交申请，不会自动执行副作用。
