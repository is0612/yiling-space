# 前端业务 API 调用约定

2026-11-17：先迁移日记模块，其他模块按需求逐个接入，不批量替换。这里管理浏览器/SSR到本项目业务接口的调用；服务端模型供应商调用另行治理。

## 分层

页面使用领域 API 工厂，例如 `createJournalApi(useApiRequest())`。`useApiRequest()` 必须在 setup 中同步调用、在首个 await 前捕获本次 SSR 的 `useRequestFetch()`；返回客户端在嵌套 await、事件回调中复用，不再调用 Nuxt composable。不能将带登录态的客户端放入模块全局变量，避免并发 SSR 串 Cookie。

领域 API 模块保存路径、请求/响应类型及具名函数，接受 `ApiRequest` 依赖，不自行获取 Nuxt 上下文。`createRequestClient(fetchJson)` 是可离线测试的纯传输工厂，统一 `/api` 前缀，路径只传内部绝对路径且不含 `/api`、查询串或片段；查询放 params，正文放 data，动态路径段用 encodeURIComponent。

## 行为

- 所有请求默认 `retry: 0`。写操作不能静默重试，读请求需要重试时在业务侧明确设计；重发写操作先有服务端幂等契约。
- 可传 signal 和 timeout；取消与超时不代表服务端写操作未发生，页面刷新状态后再决定重试。长时间生成不设置统一短超时。
- 请求层只传输、保留原始异常，不弹通知、不全局跳转、不吞异常。页面负责本场景提示、并发序号与过期结果保护。
- `readApiErrorMessage` 优先服务端正文 message，其次业务 statusMessage；过滤通用HTTP状态与ofetch包含方法/URL的包装。原始 Error.message 不作为用户提示。
- 服务端安全的人类说明写在 message 正文，statusMessage 保持HTTP标准文本；不能把模型输出、网络错误、数据库详情、凭据直接返回。日记上游失败为502、内部失败为500，已有HTTP业务错误保持原状态；OpenAPI同步维护。
- 当前统一入口只支持JSON。文件上传、二进制下载、流式响应、Cookie回写等先确定契约，再增加专门类型/入口，不强转为JSON或用任意options绕过边界。

## 验证与迁移

已接入日记列表、详情、生成、重写、编辑、版本与恢复；QQ 渠道已按同一工厂接入连接、运行时、绑定与删除。成长知识库已接入工作区读取、候选新增/网页导入/处理/采纳/忽略/删除、归档与回收站生命周期、编辑、版本历史、合并及关系处置；文件导入是 multipart，暂由页面单独发送。成长系统已接入愿望、偏好、表达习惯的列表/来源/建议/保存/修订历史与愿望进展，反思任务的发起/重试/审阅/删除，投递列表/详情/重试，关系评估记录/好友汇总/审阅，成长总览，长期指导与渠道行为的列表/处置/历史。B站值班台已接入环境/适配器探测与启动、扫码登录、概览与封面、命令目录与执行、单轮运行、值班设置与主人、札记与账号绑定；二维码轮询由弹窗自己起停定时器。角色管理已接入新建/复制、启停、深度思考开关与删除；导出角色卡要原始文件流，仍由页面用原生 `fetch`。角色设置已接入记忆周期读取/保存、角色资料更新与角色卡导入、梗语录列表/扫描/新增/状态/编辑/删除、表情包分页/改名/停用/重识别/QQ 同步/回收站、模型用量/模型清单/连通性测试；表情包上传是 multipart，仍由页面单独发送。系统管理已接入用户列表与审计分页、账号停用/密码重置、任务列表与筛选、周期扫描与 Worker 执行、任务重试/取消、登录设备与改密/撤销会话。记忆模块已接入长期记忆分页/详情/编辑/状态/回收站、对话录入、群聊与私聊游标、忆泡日历与当天原文、忆泡编辑/隐藏/重复候选/知识候选、阶段总结列表/详情/来源/审核/生成、忆泡整理预览与进度、互动经验列表与设置；`useMemoryProgress` 的客户端轮询保留 `$fetch`，因为它必须自己持有 AbortController 掐掉挂死请求。`yarn test:api-request` 验证注入客户端的并发/await隔离、编码、取消、无重试、错误提取与日记错误分类，并已接入 `test:journal`；QQ 页面脚本回归见 `yarn test:qq-chain`，知识库页面回归见 `test:knowledge-page-races`、`test:knowledge-batch-page`、`test:knowledge-governance-page`、`test:knowledge-lifecycle-page`；记忆页面回归见 `test:memory-page-races`、`test:snapshot-page-races`、`test:days-page-races`、`test:memory-progress-poll`、`test:memory-extraction-dialog`、`test:memory-knowledge-request-page`、`test:interaction-experiences-page`；成长系统页面回归见 `test:goals-page`、`test:preferences-page`、`test:expression-habits-page`、`test:reflection`、`test:growth-deliveries-page-races`、`test:growth-overview-page`、`test:social-assessment-history-page`，渠道行为与长期指导回归见 `test:channel-policies`、`test:interaction-guidance`。系统管理、角色管理与角色设置页面目前没有页面级 VM 测试，依赖 `test:api-request`、SFC 编译、类型检查、lint 与既有认证测试。纯工厂mock不等于真实浏览器/SSR登录验收；部署后还需确认有会话Cookie的首屏列表与详情都成功、两个账号并发不串数据。

每迁移一个领域，保留原有请求幂等、分页、SSR身份及页面竞态防护，核对OpenAPI与DTO；运行受影响专项、类型检查、lint、SFC编译、构建和隐私检查。暂不恢复网页聊天，不扩展模型调用框架。
