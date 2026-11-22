# 安装版主人绑定与桌面免登录

## 当前切片

安装版建立了普通 Node 启动器 → supervisor → Nitro 与 Electron 主进程的私有认证通道。桌面窗口仍使用原 HTTP API 和 User/Session/ownerId 权限模型；没有新增匿名 local-enter 或兑换 Token 的 HTTP 路由，没有修改业务 schema、角色归属或 QQ 主人设置。

- **新空库**：只自动绑定本次启动确实从空库创建的首账号。服务端再检查整库恰好一个用户、账号 ID 精确匹配且为 ACTIVE ADMIN。不是“看到一个管理员就认作主人”。
- **已有库/恢复库**：即使只剩一个账号，也先正常登录，再点「登录并绑定本机」或用户区的「绑定当前账号为本机主人」。原生确认默认取消，用户确认后才保存本机信任。普通 ACTIVE USER 可以绑定自己，不会变成管理员。
- 绑定后，同一 Windows 用户从该安装的正常入口启动，Electron 在加载首个业务页面前获得普通服务端 Session Cookie。退出重开仍是同一账号。
- 文件菜单可「重新连接绑定的本机身份」和「取消本机免登录」。停用/删除账号、解绑、身份上下文不符或私有通道关闭都不能偷偷换成其它管理员。
- 网页/源码继续原登录与退出登录；安装版侧栏显示「退出应用」。源码不会因为这次功能被强制启用本机身份。

## 信任来源与凭据边界

启用标志不是认证凭证。链路还要求继承的 Node IPC 句柄、每次启动随机密钥和进程代号、带方向与序号的 MAC；初始化只接受一次，重复序号、篡改或跨启动包不能再次执行。每个父子连接有独立状态，不通过 stdout、参数、URL 或应用环境变量搬运启动密钥/Session Token。

Nitro 私有插件初始化时核对受保护数据目录、安装 ID、数据库实例 ID 和 PG system identifier。状态在 desktop-owner.json 内关联这些身份；目录及 owner 文件 ACL 限制为当前用户、SYSTEM 和本机 Administrators。它不抵御已控制当前系统用户或恶意管理员的程序，也不是权限提升机制。

服务端复用统一随机 Token、SHA-256 入库、TTL 边界和 ACTIVE 状态检查。签发会话时锁用户行，账号停用/删除不签发；绑定证明先正常密码登录，然后在事务中锁用户/会话并重新检查 Cookie 证明未过期、未撤销且哈希一致。密码哈希本身不当作绑定证明。

Token 只经私有链路交给主进程；主进程等待专用 persist Session 写 Cookie 并回读属性成功后才加载页面。保持 HttpOnly、Secure、SameSite=Strict：真实 Chromium 实验确认回环 HTTP 也支持此 Secure Cookie，不为省事放宽公网 Cookie 策略。渲染层只能拿到公开状态或 ok/cancelled，不拿 Token、Cookie 内容、任意 SQL/URL 或通用 IPC 请求能力。

preload 身份方法只接受已登记 origin 的主窗口主框架；子框架、其它窗口、跨 origin 拒绝。客户端能力标记只控制展示，HTTP 服务端仍逐请求验证会话、账号状态和数据归属。

## 会话撤销与恢复

owner 文件只持久化账号 ID、安装/数据库上下文、当前会话 ID/哈希/到期时间，不保存明文 Token。每次轮换先用 id+userId+tokenHash 核对并撤销自己的旧会话，失败则不再签发；不能靠可伪造的 User-Agent 猜哪些会话属于本安装。

正常退出、解绑只精准撤销本安装私有签发的会话，不撤同一用户的其它 Web 登录。用于证明当前账号的普通密码登录会话不被冒认作本安装会话，仍按原策略过期。强制结束进程来不及撤销时，旧桌面会话至多保留到正常到期或下次成功启动的轮换；本轮不宣称强杀能同步抹掉所有会话。

撤销一个 Session 不等于取消 Windows 本机绑定：绑定仍有效时用户可明确重连。要禁止以后本机重建会话，请取消本机绑定或停用账号。用户改密码不会自动修改角色归属或静默挑选另一主人。

账号停用/删除时显示 blocked；当前 OS 用户可以通过原生确认取消这个合法绑定，再用有效账号登录并明确重绑。上下文/ACL/文件损坏则失败关闭，不用恢复入口覆盖未知资料。没有新增绕过密码的账号重置接口。

desktop-owner.json 和 Electron Cookie/profile 不加入可迁移的已登记业务备份材料；恢复到新实例后应重新建立信任，不能复用旧的本机凭据。卸载复装保持原数据目录时则保留原绑定身份。

本切片仍保留新空库原有 first-run-admin.txt 作为手动网页登录/密码恢复材料；不会用关闭首次建号的开关来假装不需要密码。该文件私有，不应复制到可分享安装源或发送给别人。模型 Key 仍须自己配置。

## 实现位置

- scripts/desktop-auth-ipc.cjs：继承 IPC、启动代号/MAC/序号、错误脱敏。
- server/utils/auth.ts：统一桌面会话签发原语，保留密码重置并发校验。
- server/utils/desktop-identity.ts：受保护绑定、Cookie 证明、精确撤销与最佳努力审计。
- server/plugins/desktop-identity.ts：只注册私有进程处理器，不注册 HTTP 路由。
- desktop/identity.cjs：主框架校验、原生确认、Cookie 注入和固定结果。
- desktop/launch.cjs、desktop/main.cjs、desktop/preload.cjs、scripts/desktop-supervisor.mjs：正常入口与生命周期接线。
- app/composables/useDesktopIdentity.ts、app/pages/login.vue、app/components/AppShell.vue：安装态展示、明确绑定、重连与退出；SSR 状态使用 useState。

公共 OpenAPI 的 login/session/logout 请求与响应保持不变，故没有添加伪造的公开认证契约。私有方法不是 Web API。

## 验证与未验范围

已完成：私有握手/重放/跨启动拒绝、ACTIVE-only 会话与原密码并发守卫、目录及文件 ACL、旧单账号不猜、显式解绑恢复、Cookie 属性与注入顺序、渲染入口拒绝、撤销只匹配本安装、错误不带凭据等独立回归。

真实隔离 PG + 生产 Nitro + Electron 已验证：迁移/新空库精确绑定、匿名 HTTP 仍匿名、失效 Cookie 不回退、HttpOnly Secure 首屏登录、清 Cookie 后明确重连、账号停用拒绝重建、解绑保留独立 Web 会话、重启仍同一主人、删除测试 owner 标记后既有单账号不自动认领、普通日志/owner 文件无明文凭据。消费者与 QQ 在这项认证实验中明确关闭，没有调用真实模型或真实业务库。

正常安装入口也已单独通过：开发候选包使用包内 Node/Electron/PG，经过真实安装状态与普通 Node launcher 启动，首屏为绑定账号、Cookie 不可被页面读取；桥接退出后 launcher 返回成功、PG 停止、当前会话引用清空；再开同一账号无需密码。安装回归关闭快捷方式/HKCU 写入，仅使用独立测试目录。源码入口另用真实源码启动器/Electron配明确 Mock 后端验证开窗/退出成功，不启用安装态身份。独立实验的直接父进程没有被当成正常 launcher 全链路的替代品。

本轮类型检查、SFC 编译、完整 lint、隐私门禁、测试计划校验及隔离生产构建通过。未跑全量业务测试。开发候选来自已提交基线加本轮身份改动，metadata.sourceDirty=true，不能当作干净提交的正式发布包。没有替换当前源码桌面的 .output 或自动升级用户真实安装。

尚需人工验收：另一台 Windows 的已有库升级后「登录并绑定」、原生确认的真实点击、取消本机信任与不同 Windows 用户隔离。未做代码签名/杀软认证、云同步、跨 OS 凭据恢复或真实旧库自动迁移。
