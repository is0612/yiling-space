/**
 * QQ 渠道（OneBot 小号）的前后端共享契约。
 *
 * 这一域有两处**秘密**，处理方式不同，都是既有设计、不要为了「读写对称」去改：
 *
 * 1. `QqConnection.credentials` —— 默认 **null**。只有 `GET /admin/channels?withCredentials=1`
 *    才解密回传，且该接口要求管理员。注释写得很直白：首屏 SSR 若带上 token，
 *    查看页面源代码就能看到，那就不算「只有管理员可见」。
 *
 * 2. `PanelPasswordInfo.password` —— 独立接口、管理员、只在打开页面与「一键启动」
 *    接管后各取一次。它不塞进 runtime 轮询（每几秒一次），也不跟着列表走。
 *    那串密码是系统替 SnowLuma 生成的，用户从没手抄过，不显示就没有别的途径知道。
 *
 * 所以契约里 `credentials` 是「可选且可空」，别把它改成必填 —— 那不是字段缺失。
 */

export type GroupChatSettings = {
  mode: "mention" | "ambient" | "all";
  batchWindowSeconds: number;
  mentionWindowSeconds: number;
  minGapSeconds: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  ambientChance: number;
  aliases: string[];
};

export type ChannelBinding = {
  id: string;
  characterId: string;
  characterName: string;
  routingKey: string | null;
  /** 群聊限流窗口（分钟）与窗口内上限；上限 0 = 不限。 */
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  /** 群聊是否仅被 @ 时才回复（后端已回退到连接默认值）。 */
  replyOnlyWhenMentioned: boolean;
  /** 群聊怎么回：模式 + 攒批/闸门参数，后端已解析好默认值。 */
  groupChat: GroupChatSettings;
  /** 按群覆盖的模式：`{ "<群号>": 档位 }`；没在这张表里的群沿 groupChat.mode。 */
  groupChatModes?: Record<string, GroupChatSettings["mode"]>;
};

/**
 * 连接凭据（**秘密**）：只在显式 `withCredentials=1` 且管理员时回传，解不开时为 null。
 *
 * 写：`POST /admin/channels` 接受这些字段；
 * 读：默认不给，要单独要、并且得是管理员。
 */
export type QqCredentials = {
  wsUrl?: string;
  httpUrl?: string;
  /** 秘密：OneBot 访问令牌。 */
  accessToken?: string;
  /** 秘密：HTTP 令牌。 */
  httpToken?: string;
  /** 秘密：SnowLuma 面板密码，用来「一键启动」后自动登录配节点。 */
  snowlumaPassword?: string;
};

export type QqConnection = {
  id: string;
  platform: string;
  displayName: string;
  appId: string | null;
  status: string;
  lastEventAt: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
  /** 默认 null（见文件头）。只有显式要、且是管理员，才有值。 */
  credentials?: QqCredentials | null;
  bindings: ChannelBinding[];
};

export type SnowlumaStatus = {
  home: string;
  /** 目录从哪来：saved=页面上填过 env=环境变量 process/scan=自动找到 default=没找到，用的默认值 */
  source: "saved" | "env" | "process" | "scan" | "default";
  /** start.bat 在不在 */
  installed: boolean;
  running: boolean;
  panelPort: number;
};

export type AccountGateway = {
  wsUrl: string;
  host: string;
  port: number;
  reachable: boolean;
  connectionId?: string;
  accountState?: "waiting_login" | "ready" | "unknown";
};

export type RuntimeStatus = {
  selectedConnectionId?: string | null;
  gateways?: AccountGateway[];
  adapter: { running: boolean; pid?: number; startedAt?: string };
  snowluma: SnowlumaStatus;
  /** 适配器要连的那个端口通不通；读不到连接配置时为 null */
  gateway: AccountGateway | null;
  /** 人点过「停止」后自动补起会一直关着，直到再点启动/重连 */
  autostart: { paused: boolean; at?: string };
};

/** 面板密码（**秘密**，独立接口）：null = 还没有连接，或那份凭据解不开。 */
export type PanelPasswordInfo = {
  password: string | null;
  accountQq: string;
  panelPort: number;
  panelUrl: string;
  snowlumaRunning: boolean;
};

export type QuotaRow = {
  id: string;
  name: string;
  /** 0 = 没设上限（不限额） */
  limit: number;
  used: number;
  remaining: number | null;
  exceeded: boolean;
};

export type ProvisionResponse = {
  ok: boolean;
  reason?: "no-password" | "unreachable" | "bad-password" | "totp" | "rate-limited" | "error" | "account-not-logged-in";
  action?: "waiting-login";
  message: string;
  changes: string[];
  warnings: string[];
  uin?: string;
  ports?: { ws: number; http: number };
};

export type HookResponse = {
  ok: boolean;
  /** already=本来就在听；attached=这次挂上了；failed=没挂上 */
  action: "already" | "attached" | "failed" | "waiting-login";
  message: string;
  /**
   * 失败分类，服务端给的。页面靠它决定「要不要顺手把面板开给用户」：
   * 密码类（no-password / bad-password / totp / rate-limited）和「面板拒绝挂载」，
   * 人只能进面板解决；no-process 开面板也没用（该去 QQ 客户端）。
   */
  reason?: string;
  uin?: string;
  wsPort?: number | null;
  reachable?: boolean;
};

export type EnsureStackResponse = {
  action: string;
  message: string;
  steps: string[];
};

/** 新建连接（**请求**）：字段都是明文入参，服务端加密后只存密文。 */
export type CreateConnectionReq = {
  platform: string;
  qqNumber: string;
  displayName: string;
  wsUrl: string;
  httpUrl: string;
  accessToken: string;
  httpToken: string;
  snowlumaPassword: string;
  groupAnnouncementEnabled: boolean;
  ownerQq: string;
  ownerName: string;
};

/** 给角色绑定连接（**请求**）：不传的字段保留已有配置。 */
export type BindCharacterReq = {
  characterId: string;
  routingKey: string;
  replyWindowMinutes?: number;
  replyLimitPerWindow?: number;
  groupChatMode?: GroupChatSettings["mode"];
  groupChatModes?: Record<string, GroupChatSettings["mode"]>;
  minGapSeconds?: number;
  dailyMax?: number;
  ambientChance?: number;
  quietStart?: string;
  quietEnd?: string;
  groupAliases?: string;
};
