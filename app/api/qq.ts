// QQ 渠道的形状与后端共用（`shared/types/qq.ts`）。
// 两处秘密（连接凭据、面板密码）的回传边界写在那份文件的文件头里。
import type {
  BindCharacterReq, ChannelBinding, CreateConnectionReq, EnsureStackResponse, GroupChatSettings,
  HookResponse, PanelPasswordInfo, ProvisionResponse, QqConnection, QqCredentials, QuotaRow,
  RuntimeStatus, SnowlumaStatus,
} from "#shared/types/qq";
export type * from "#shared/types/qq";

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
