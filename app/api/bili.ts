import type { ApiRequest } from "../utils/request";
import type {
  BiliAdapterStatus,
  BiliCatalogGroup,
  BiliCliEnv,
  BiliMe,
  BiliOwner,
  BiliRunResult,
  DashboardData,
} from "../pages/bili/types";

export type BiliJournalEntry = { id: string; content: string; dedupeKey: string | null; updatedAt: string };

export type BiliAuthStatus = {
  ok: boolean;
  user: unknown;
  error: { code?: string; message?: string; hint?: string } | null;
};

export type BiliDutyInput = {
  perDay: number;
  peakValley: boolean;
  noon: boolean;
  night: boolean;
  keywords: string[];
  zone: string;
  frames: number;
  reportLevel: "full" | "brief" | "off";
  dmMode: "only" | "both" | "off";
  dmTargetUid: string;
  dmAllowNew: boolean;
  autoComment: boolean;
  commentPerRound: number;
  mentionName: string;
  taste: string;
  favMinScore: number;
  autoDynamic: boolean;
  dynamicMinScore: number;
  ownerFirst: boolean;
  ownerWatch: boolean;
  ownerLike: boolean;
  ownerFav: boolean;
  ownerComment: boolean;
  ownerCoinMinScore: number;
};

export type BiliOwnerResult = { ok: boolean; owner: BiliOwner | null; error?: string };

export type BiliRunRoundResult = {
  ok: boolean;
  seconds: number;
  picked: number;
  skipped: number;
  error?: string;
  notes?: string[];
};

export type BiliLaunchResult = { ok: boolean; pid?: number; message?: string };

const biliAdmin = "/admin/bili";
const channelPath = (connectionId: string) => `/admin/channels/${encodeURIComponent(connectionId)}`;
const journalPath = (entryId: string) => `${biliAdmin}/journal/${encodeURIComponent(entryId)}`;

/**
 * B站值班台接口：环境/适配器探测、登录扫码、概览、命令执行、值班设置、札记与账号绑定。
 *
 * 扫码登录的轮询由弹窗自己起定时器、自己停；这里只负责每次请求。
 */
export function createBiliApi(request: ApiRequest) {
  function getEnv(): Promise<BiliCliEnv> {
    return request<BiliCliEnv>({ url: `${biliAdmin}/env`, method: "get" });
  }

  function getAdapter(): Promise<BiliAdapterStatus> {
    return request<BiliAdapterStatus>({ url: `${biliAdmin}/adapter`, method: "get" });
  }

  function launchAdapter(): Promise<BiliLaunchResult> {
    return request<BiliLaunchResult>({ url: `${biliAdmin}/adapter/launch`, method: "post" });
  }

  function getMe(): Promise<{ ok: boolean; me: BiliMe | null }> {
    return request<{ ok: boolean; me: BiliMe | null }>({ url: `${biliAdmin}/me`, method: "get" });
  }

  function getCatalog(): Promise<{ groups: BiliCatalogGroup[] }> {
    return request<{ groups: BiliCatalogGroup[] }>({ url: `${biliAdmin}/catalog`, method: "get" });
  }

  function getDashboard(): Promise<DashboardData> {
    return request<DashboardData>({ url: `${biliAdmin}/dashboard`, method: "get" });
  }

  function getCover(bvid: string): Promise<{ bvid: string; pic: string | null }> {
    return request<{ bvid: string; pic: string | null }>({
      url: `${biliAdmin}/cover`,
      method: "get",
      params: { bvid },
    });
  }

  function runRound(payload: { connectionId: string; bindingId: string }): Promise<BiliRunRoundResult> {
    return request<BiliRunRoundResult>({
      url: `${biliAdmin}/run-round`,
      method: "post",
      data: { connectionId: payload.connectionId, bindingId: payload.bindingId },
    });
  }

  function runCommand(payload: { argv: string[]; itemId: string; allowWrite: boolean }): Promise<BiliRunResult> {
    return request<BiliRunResult>({
      url: `${biliAdmin}/run`,
      method: "post",
      data: payload,
    });
  }

  function getOwner(connectionId: string): Promise<BiliOwnerResult> {
    return request<BiliOwnerResult>({
      url: `${biliAdmin}/owner`,
      method: "get",
      params: { connectionId },
    });
  }

  function saveOwner(payload: { connectionId: string; uid: string }): Promise<BiliOwnerResult> {
    return request<BiliOwnerResult>({ url: `${biliAdmin}/owner`, method: "put", data: payload });
  }

  function saveDuty(payload: { connectionId: string; duty: BiliDutyInput }): Promise<unknown> {
    return request<unknown>({ url: `${biliAdmin}/duty`, method: "put", data: payload });
  }

  function resetDuty(connectionId: string): Promise<unknown> {
    return request<unknown>({
      url: `${biliAdmin}/duty/reset`,
      method: "post",
      data: { connectionId },
    });
  }

  function login(): Promise<{ ok: boolean; code: number | null; stderr: string }> {
    return request<{ ok: boolean; code: number | null; stderr: string }>({
      url: `${biliAdmin}/auth/login`,
      method: "post",
    });
  }

  function getLoginQr(): Promise<{ dataUrl: string }> {
    return request<{ dataUrl: string }>({ url: `${biliAdmin}/auth/qr`, method: "get" });
  }

  function getAuthStatus(): Promise<BiliAuthStatus> {
    return request<BiliAuthStatus>({ url: `${biliAdmin}/auth/status`, method: "get" });
  }

  function listJournal(payload: { connectionId: string; bindingId: string }): Promise<{ entries: BiliJournalEntry[] }> {
    return request<{ entries: BiliJournalEntry[] }>({
      url: `${biliAdmin}/journal`,
      method: "get",
      params: { connectionId: payload.connectionId, bindingId: payload.bindingId },
    });
  }

  function createJournal(payload: {
    connectionId: string;
    bindingId: string;
    content: string;
  }): Promise<unknown> {
    return request<unknown>({ url: `${biliAdmin}/journal`, method: "post", data: payload });
  }

  function updateJournal(payload: { entryId: string; content: string }): Promise<unknown> {
    return request<unknown>({
      url: journalPath(payload.entryId),
      method: "patch",
      data: { content: payload.content },
    });
  }

  function deleteJournal(entryId: string): Promise<unknown> {
    return request<unknown>({ url: journalPath(entryId), method: "delete" });
  }

  function createChannel(payload: {
    platform: "bili";
    displayName: string;
    dataHome: string;
    biliBin: string;
  }): Promise<unknown> {
    return request<unknown>({ url: "/admin/channels", method: "post", data: payload });
  }

  function deleteChannel(connectionId: string): Promise<unknown> {
    return request<unknown>({ url: channelPath(connectionId), method: "delete" });
  }

  function createBinding(payload: { connectionId: string; characterId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${channelPath(payload.connectionId)}/bindings`,
      method: "post",
      data: { characterId: payload.characterId },
    });
  }

  function deleteBinding(payload: { connectionId: string; bindingId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${channelPath(payload.connectionId)}/bindings/${encodeURIComponent(payload.bindingId)}`,
      method: "delete",
    });
  }

  return {
    getEnv,
    getAdapter,
    launchAdapter,
    getMe,
    getCatalog,
    getDashboard,
    getCover,
    runRound,
    runCommand,
    getOwner,
    saveOwner,
    saveDuty,
    resetDuty,
    login,
    getLoginQr,
    getAuthStatus,
    listJournal,
    createJournal,
    updateJournal,
    deleteJournal,
    createChannel,
    deleteChannel,
    createBinding,
    deleteBinding,
  };
}

export type BiliApi = ReturnType<typeof createBiliApi>;
