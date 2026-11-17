import type { ApiRequest } from "../utils/request";

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
  /** 主人能否在群里触发刷一轮 B站（后端已回退到连接默认值）。 */
  groupBiliRunEnabled: boolean;
};

/** 接口回显的明文凭据（管理员页可见）；解不开时为 null。 */
export type QqCredentials = {
  wsUrl?: string;
  httpUrl?: string;
  accessToken?: string;
  httpToken?: string;
  /** SnowLuma 网页面板密码，用来在「一键启动」后自动登录配节点。 */
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
  qzoneEnabled: boolean;
  qzoneAutoAskEnabled: boolean;
  qzoneAutoAskTimes: string;
  qzoneAutoAskDailyMax: number;
  qzoneFriendQqs: string;
  ownerQq: string;
  ownerName: string;
};

export type BindCharacterReq = {
  characterId: string;
  routingKey: string;
  /** 绑定级行为：不传 = 保留已有配置（新绑定时沿用连接默认值）。 */
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
  groupBiliRunEnabled?: boolean;
};

const connectionPath = (connectionId: string) => `/admin/channels/${encodeURIComponent(connectionId)}`;

/**
 * QQ 渠道（OneBot 小号）接口。
 *
 * 只拼路径、声明出入参；轮询、竞态序号和提示文案留在页面里。
 */
export function createQqApi(request: ApiRequest) {
  function listConnections(payload: { withCredentials?: boolean } = {}): Promise<{ connections: QqConnection[] }> {
    return request<{ connections: QqConnection[] }>({
      url: "/admin/channels",
      method: "get",
      ...(payload.withCredentials ? { params: { withCredentials: 1 } } : {}),
    });
  }

  function getPanelPassword(): Promise<PanelPasswordInfo> {
    return request<PanelPasswordInfo>({
      url: "/admin/channels/onebot/runtime/panel-password",
      method: "get",
    });
  }

  function getRuntimeStatus(payload: { connectionId?: string } = {}): Promise<RuntimeStatus> {
    return request<RuntimeStatus>({
      url: "/admin/channels/onebot/runtime",
      method: "get",
      ...(payload.connectionId ? { params: { connectionId: payload.connectionId } } : {}),
    });
  }

  function getQuota(): Promise<{ characters: QuotaRow[] }> {
    return request<{ characters: QuotaRow[] }>({
      url: "/admin/channels/onebot/quota",
      method: "get",
    });
  }

  function startSnowluma(): Promise<{ message: string; panelPassword?: string | null }> {
    return request<{ message: string; panelPassword?: string | null }>({
      url: "/admin/channels/onebot/runtime/snowluma",
      method: "post",
    });
  }

  function saveSnowlumaHome(home: string): Promise<unknown> {
    return request<unknown>({
      url: "/admin/channels/onebot/runtime/snowluma",
      method: "put",
      data: { home },
    });
  }

  function startAdapter(): Promise<{ message: string }> {
    return request<{ message: string }>({
      url: "/admin/channels/onebot/runtime/adapter",
      method: "post",
    });
  }

  function provisionPanel(payload: { connectionId?: string } = {}): Promise<ProvisionResponse> {
    return request<ProvisionResponse>({
      url: "/admin/channels/onebot/runtime/provision",
      method: "post",
      ...(payload.connectionId ? { data: { connectionId: payload.connectionId } } : {}),
    });
  }

  function attachHook(payload: { connectionId?: string } = {}): Promise<HookResponse> {
    return request<HookResponse>({
      url: "/admin/channels/onebot/runtime/hook",
      method: "post",
      ...(payload.connectionId ? { data: { connectionId: payload.connectionId } } : {}),
    });
  }

  function ensureStack(): Promise<EnsureStackResponse> {
    return request<EnsureStackResponse>({
      url: "/admin/channels/onebot/runtime/ensure",
      method: "post",
    });
  }

  function stopRuntime(): Promise<{ stopped: boolean; message: string }> {
    return request<{ stopped: boolean; message: string }>({
      url: "/admin/channels/onebot/runtime/stop",
      method: "post",
    });
  }

  function reloadConnection(connectionId: string): Promise<unknown> {
    return request<unknown>({
      url: `${connectionPath(connectionId)}/reload`,
      method: "post",
    });
  }

  function createConnection(payload: CreateConnectionReq): Promise<{ id: string }> {
    return request<{ id: string }>({
      url: "/admin/channels",
      method: "post",
      data: payload,
    });
  }

  function bindCharacter(connectionId: string, payload: BindCharacterReq): Promise<unknown> {
    return request<unknown>({
      url: `${connectionPath(connectionId)}/bindings`,
      method: "post",
      data: payload,
    });
  }

  function unbindCharacter(connectionId: string, bindingId: string): Promise<unknown> {
    return request<unknown>({
      url: `${connectionPath(connectionId)}/bindings/${encodeURIComponent(bindingId)}`,
      method: "delete",
    });
  }

  function deleteConnection(connectionId: string): Promise<unknown> {
    return request<unknown>({
      url: connectionPath(connectionId),
      method: "delete",
    });
  }

  return {
    listConnections,
    getPanelPassword,
    getRuntimeStatus,
    getQuota,
    startSnowluma,
    saveSnowlumaHome,
    startAdapter,
    provisionPanel,
    attachHook,
    ensureStack,
    stopRuntime,
    reloadConnection,
    createConnection,
    bindCharacter,
    unbindCharacter,
    deleteConnection,
  };
}

export type QqApi = ReturnType<typeof createQqApi>;
