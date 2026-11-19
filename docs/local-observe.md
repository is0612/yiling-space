# 本地只读观察（阶段三第一块）

> 状态：2026-11-20 第一版。只读、仅管理员、默认项目根目录；写文件/终端/Git 都还没接。

## 能做什么

- 列出项目根目录内的目录；
- 读取文本文件（≤256 KB）；
- 按文件名或内容搜索（最多 100 条结果）。

入口：系统管理 → 本地观察（`/local-observe`）。

## 边界

- 根目录默认是服务进程的 `process.cwd()`，可用 `YILING_LOCAL_ROOT` 指定；
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
- `GET /api/local/observe/list?path=`
- `GET /api/local/observe/read?path=`
- `GET /api/local/observe/search?q=&path=`

全部仅管理员可用；契约见 `docs/openapi.yaml` 的 `LocalObserve` 路径。

## 下一步

- 授权目录（用户手动添加根目录）；
- 写文件/终端/Git 前先做权限审批、独立验收和任务档案；
- 观察结果如何进入她的记忆，需要单独设计，不能把执行日志直接灌进长期记忆。
