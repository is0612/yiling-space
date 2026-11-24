# 测试入口与隔离运行约定

## 清单来源

- `package.json` 的 `test:*` 是对外入口。组合入口仍可以通过 `yarn run test:名字` 复用其他测试。
- `scripts/test-isolation-map.mjs` 明确列出 20 个外部子进程隔离运行器及其有序子测试。各父运行器和总跑批器读取同一份表；不再扫描测试源码猜测父子关系。
- `scripts/test-plan.mjs` 把 package 命令展开为具体 node/tsx 脚本，然后去除重复的顶层执行。父运行器自己负责的迁移、夹具、数据库环境和 finally 清理保持不变。

新增普通测试只需登记 `test:*`。新增隔离子测试时，把文件加入所属父运行器的共享数组；即使它没有独立 package 命令，也会进入父运行器的执行与总清单覆盖。新增外部子进程隔离父运行器必须登记到共享表，并调用 `isolatedTestFiles(import.meta.url)`。在本文件内直接执行数据库断言的隔离测试不用伪造子文件清单。

同一子测试若在多个父运行器中有不同夹具，仍在各父环境内分别执行。本批没有把这些不同上下文合并。“覆盖脚本数”不是断言数，也不是实际子进程启动总次数。

## 使用

```bash
# 只校验登记与文件存在，不执行测试
 yarn check:tests

# 看实际顶层脚本和隔离库内子测试
 yarn test:all --list --children

# 输出可检查的完整计划 JSON，不执行测试
 yarn test:all --list --json

# 本地与 CI 共用的总测试入口
 yarn test:all

# only 按入口名称选套件；skip 也会排除嵌套别名及顶层脚本
 yarn test:all --only=memory --bail
 yarn test:all --skip=onebot

# 数据库相关入口（-db、-isolated 及 test:isolated）
 yarn test:all --db --list
```

单条默认超时 300 秒，可用 `--timeout=<毫秒>` 调大；`--verbose` 展示成功脚本输出。未知命令形式、缺失引用、套件循环、缺失文件和非法超时都会明确失败。当前只接受 `node scripts/...`、`tsx scripts/...` 和组合中的 `yarn run test:*`，不猜测任意 shell 语义。

筛选一个已登记隔离子测试时，会调其安全父运行器，而非直接用普通 DATABASE_URL 执行子测试。历史 `--children` 的危险直接执行方式已移除，该参数只允许配合 `--list` 或 `--check`。`--skip` 不会拆开某个隔离父运行器内部的有序子测试；需要跳过这整组时应筛掉对应父入口。其他没有归入隔离运行器的数据库测试仍需要合适的开发/测试数据库；`--db` 仅按入口名筛选，不自动识别所有连库行为，也不会把所有数据库测试改造成隔离测试。

数据库服务器的会话时区必须是 UTC。Prisma 驱动适配器读原始 SQL 的 `timestamptz` 时按「本地墙上时间」处理，服务器时区跟着 Windows 走（东八区）会让 `$queryRaw` 的时间整体偏移 8 小时：日志状态回填取错版本、成长事件租约领取直接判空、群表达观察算不到候选。桌面内嵌集群已固定 `-c timezone=UTC`；自建开发库（Docker 或本机安装）跑全量前请先 `ALTER DATABASE ... SET timezone='UTC'` 或等价配置。另外，若测试库角色没有 `pg_signal_backend`，隔离测试清理阶段的 `pg_terminate_backend` 会以 `insufficient_privilege` 失败——那是权限问题，不是断言失败。

## 页面脚本测试的边界

共享 `scripts/lib/page-harness.ts` 只驱动抽取后的页面脚本，使用可控的 ref/computed/watch 替身，不验证真实 Vue 响应式调度或 DOM。角色切换必须匹配明确的角色来源与监听器，来源值必须跟随所选角色变化，不再兜底触发任意监听器。请求由独立集合跟踪，`take`/`takeMatching` 仅领取请求，必须 resolve/reject 后才算完成；`finish` 拒绝尚未完成的请求。工具自身回归入口为 `yarn test:page-harness`。

用户管理分页的倒序响应、旧请求错误与 loading 保护由 `yarn test:users-page-races` 验证。这些模拟脚本不替代浏览器与真实登录环境验收。

## CI 与本地全校验

CI 只保留一处 `yarn run test:all`，移除此前先逐项、再大套件、最后全部测试的重复执行。全新 clone 安装检查、Prisma 迁移一致性、PowerShell 数据恢复回归、API 冒烟、类型检查、隐私及样式门禁、lint、生产构建和 OpenAPI 校验仍独立保留。

`yarn verify:local` 先完成 Schema / Client / Nuxt 准备、SFC、类型、隐私、样式及测试清单检查，再执行同一个 `test:all`，最后 lint 和 build。历史 `test:unit-suite` 等组合入口仍保留，避免破坏现有调用；通过总跑批器选择它们时也会展开去重。

## 本批验证

`yarn test:runner` 验证别名展开与去重、没有 package 命令的隔离子文件仍被覆盖、筛选子测试转父运行器、不同父夹具上下文均保留、循环/缺失/非法配置失败，以及真实子进程退出失败、超时失败和 stdout/stderr 收尾。它还逐项比较 package 中的具体脚本、共享子表和最终计划，检查 CI 与本地只有一个总测试入口。

当前清单：202 个入口、421 次展开引用、223 个唯一顶层脚本、287 个覆盖脚本。相比整理前的可执行文件集合仅新增本批跑批器回归，未删去既有业务测试。未量测完整 CI 耗时，不能用引用减少比例宣称实际加速比例。

已实际通过：

- `yarn test:runner`、`yarn check:tests`，包括嵌套别名与内联脚本不能绕过 skip、筛选隔离子测试不会复活已跳过父入口的回归。
- `node scripts/test-all.mjs '--only=isolated|scoped-growth' --bail`：30/30 顶层脚本通过，用时约 7 分 24 秒，覆盖全部 20 个迁移后的外部子进程隔离运行器；各自迁移、夹具、子测试和清理按原路径执行。
- 通过最终 CLI 跑普通脚本与组合入口的抽样，确认 node/tsx 实际执行与去重后的计划一致。
- 用现有 js-yaml 解析 CI YAML，确认总测试步骤仅一处，fresh-clone 与独立恢复步骤仍保留。
- 定向 ESLint 与全仓 `yarn lint` 通过（0 error，存在未改 Vue 文件的 342 条格式 warning）。

本批仅改测试入口、清单、运行器及说明，没有改业务逻辑或依赖版本，没有调用真实模型或进行聊天验收。未重跑完整业务测试集合、应用类型检查、生产构建、恢复容器测试和 API 冒烟；这些步骤仍在 CI / 本地入口中保留，但本地清单与隔离执行通过不等于远端 GitHub Actions 已通过。
