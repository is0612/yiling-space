# 本地只读观察（阶段三第一块）

> 状态：2026-11-20 第一版。只读、仅管理员、默认项目根目录；写文件/终端/Git 都还没接。

## 能做什么

- 管理授权目录（添加 / 停用 / 移除；移除不删磁盘文件）；
- 列出授权目录内的目录；
- 读取文本文件（≤256 KB）；
- 按文件名或内容搜索（最多 100 条结果）。

入口：系统管理 → 本地观察（`/local-observe`）。

## 授权目录

- 内置「项目目录」永远存在，不能移除；
- 管理页可以添加任意**已存在的绝对目录**（最多 20 个）；
- 添加时会拒绝：盘符根、`C:\Windows` / `Program Files` / `ProgramData`、整个用户目录、`.data` 运行时目录；
- 停用的目录不参与观察，可以随时重新启用；
- 移除只删白名单记录，不删除磁盘文件。

## 写文件（需审批）

管理员可以把某个授权目录改成「可写」；即使可写，她也不能直接落盘：

1. 她在桌面聊天里调用 `propose_file_write`，提交 `root / path / content / reason`；
2. 服务端创建 `PENDING` 写请求，检查目录可写、路径在根内、敏感文件/忽略目录、内容 ≤32 KB；
3. 管理页「写审批」里显示路径、原因、将写入的内容；
4. 管理员批准后才真正写文件；拒绝则什么也不写；
5. 批准时还会校验文件在请求后有没有被改过（`baseHash`），改过就失败，避免覆盖别人的修改。

写请求表：`local_write_requests`。工具结果只返回 `PENDING_APPROVAL`，不会返回“已写入”。

## 任务档案与验收

一条任务按「目标 → 计划 → 写请求 → 验收证据」串起来：

1. `create_local_task`（桌面聊天，管理员）建立任务档案；
2. `propose_file_write` 可以带 `taskId`，写请求创建后任务变成「待审批」；
3. 写请求批准后任务变成「进行中」；
4. 管理页「任务档案」里可以记录 `PASS` / `FAIL` 验收证据，任务相应变成「已验收」/「验收失败」；
5. 任务也可以取消；已取消/已完成的任务不能再改验收结果。

当前验收证据是**人工记录**（例如“跑过 `test:local-write`，文件内容正确”），不是自动执行测试；终端接入后
才会由命令结果自动写证据。这条边界是为了避免把执行者自己的说法当成功。

## 边界

- 接口只接受相对路径，绝对路径、`..`、根外符号链接都会被拒绝；
- 以下目录不进入观察范围：`node_modules`、`.git`、`.nuxt`、`.output`、`.data`、`dist`、`backups` 等；
- `.env*`、`*.key`、`*.pem`、`credentials-encryption.key`、`onebot-*.json` 等敏感文件不可读、不可写；
- 二进制文件不预览；超过 256 KB 的文件不预览；
- 读工具只读；写文件必须经过审批，且只能覆盖已存在的授权目录内文件或新建文件；
- 没有删除、终端、Git 操作。

## 审计

每次列表/读取/搜索会追加一行到 `<data>/local-exec-audit.jsonl`，包含时间、管理员 ID、动作、路径
和结果摘要；不记录文件正文。这个文件不是长期记忆，也不会自动进入提示词。

## API

- `GET /api/local/observe/root`
- `GET /api/local/observe/roots`
- `GET /api/local/observe/list?rootId=&path=`
- `GET /api/local/observe/read?rootId=&path=`
- `GET /api/local/observe/search?rootId=&q=&path=`
- `GET/POST /api/local/roots`
- `PATCH/DELETE /api/local/roots/{id}`
- `GET /api/local/write-requests?status=PENDING`
- `POST /api/local/write-requests/{id}/approve`
- `POST /api/local/write-requests/{id}/reject`
- `GET/POST /api/local/tasks`
- `GET /api/local/tasks/{id}`
- `POST /api/local/tasks/{id}/evidence`
- `POST /api/local/tasks/{id}/cancel`

全部仅管理员可用；契约见 `docs/openapi.yaml` 的 `LocalObserve` 路径。

## 她能用吗

可以，但只在**桌面聊天**里，且只有管理员：

- 管理员在桌面聊天时，模型会拿到 `list_local_roots` / `list_local_directory` / `read_local_file` /
  `search_local_files` 四个只读工具；授权目录开启可写时还会拿到 `propose_file_write`（只提交审批，不直接写）；
- 工具只能访问「授权目录」里的内容，走的还是同一套根目录白名单、敏感文件过滤和审计；
- QQ / 群聊不启用本地文件工具，避免群里的人借她读本机文件；
- 写文件只能提交审批，不能直接写；QQ 也不启用写工具；
- 每次工具调用写 `<data>/local-exec-audit.jsonl`，`source: "chat"`。

## 下一步

- 授权目录（用户手动添加根目录）；
- 写文件/终端/Git 前先做权限审批、独立验收和任务档案；
- 观察结果如何进入她的记忆，需要单独设计，不能把执行日志直接灌进长期记忆。
