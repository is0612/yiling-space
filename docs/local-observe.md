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

## 边界

- 接口只接受相对路径，绝对路径、`..`、根外符号链接都会被拒绝；
- 以下目录不进入观察范围：`node_modules`、`.git`、`.nuxt`、`.output`、`.data`、`dist`、`backups` 等；
- `.env*`、`*.key`、`*.pem`、`credentials-encryption.key`、`onebot-*.json` 等敏感文件不可读；
- 二进制文件不预览；超过 256 KB 的文件不预览；
- 只读：没有写文件、删除、终端、Git 操作。

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

全部仅管理员可用；契约见 `docs/openapi.yaml` 的 `LocalObserve` 路径。

## 她能用吗

可以，但只在**桌面聊天**里，且只有管理员：

- 管理员在桌面聊天时，模型会拿到 `list_local_roots` / `list_local_directory` / `read_local_file` /
  `search_local_files` 四个只读工具；
- 工具只能访问「授权目录」里的内容，走的还是同一套根目录白名单、敏感文件过滤和审计；
- QQ / 群聊不启用本地文件工具，避免群里的人借她读本机文件；
- 每次工具调用写 `<data>/local-exec-audit.jsonl`，`source: "chat"`。

## 下一步

- 授权目录（用户手动添加根目录）；
- 写文件/终端/Git 前先做权限审批、独立验收和任务档案；
- 观察结果如何进入她的记忆，需要单独设计，不能把执行日志直接灌进长期记忆。
