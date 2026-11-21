// 角色扮演的形状与后端共用（`shared/types/roleplay.ts`）。
import type { ApiRequest } from "../utils/request";
import type {
  RoleplayDetail, RoleplayMessage, RoleplayPersona, RoleplayPersonaInput, RoleplaySendResult,
  RoleplaySession, RoleplaySettings, RoleplaySettingsInput,
} from "#shared/types/roleplay";
export type * from "#shared/types/roleplay";

const personaPath = (id: string) => `/roleplay/personas/${encodeURIComponent(id)}`;
const sessionPath = (id: string) => `/roleplay/sessions/${encodeURIComponent(id)}`;

export function createRoleplayApi(request: ApiRequest) {
  return {
    getSettings: () => request<RoleplaySettings>({ url: "/roleplay/settings" }),
    saveSettings: (data: RoleplaySettingsInput) => request<RoleplaySettings>({ url: "/roleplay/settings", method: "put", data }),
    listPersonas: () => request<RoleplayPersona[]>({ url: "/roleplay/personas" }),
    createPersona: (data: RoleplayPersonaInput) => request<RoleplayPersona>({ url: "/roleplay/personas", method: "post", data }),
    updatePersona: (id: string, data: RoleplayPersonaInput) => request<RoleplayPersona>({ url: personaPath(id), method: "patch", data }),
    deletePersona: (id: string) => request<unknown>({ url: personaPath(id), method: "delete" }),
    listSessions: (personaId?: string) => request<RoleplaySession[]>({ url: "/roleplay/sessions", params: personaId ? { personaId } : undefined }),
    createSession: (data: { personaId: string; title?: string; hostCharacterId?: string }) => request<RoleplaySession>({ url: "/roleplay/sessions", method: "post", data }),
    getSession: (id: string) => request<RoleplayDetail>({ url: sessionPath(id) }),
    renameSession: (id: string, title: string) => request<RoleplaySession>({ url: sessionPath(id), method: "patch", data: { title } }),
    deleteSession: (id: string) => request<unknown>({ url: sessionPath(id), method: "delete" }),
    sendMessage: (id: string, data: { content: string; requestId: string }) => request<RoleplaySendResult>({ url: `${sessionPath(id)}/messages`, method: "post", data, timeout: 240_000 }),
    applyPersona: (id: string) => request<RoleplaySession>({ url: `${sessionPath(id)}/apply-persona`, method: "post" }),
    compress: (id: string, rebuild = false) => request<RoleplaySession>({ url: `${sessionPath(id)}/compress`, method: "post", data: { rebuild }, timeout: 240_000 }),
  };
}

export const ROLEPLAY_QQ_COMMANDS = [
  ["&扮演 列表", "查看可用人设"], ["&扮演 开始 人设编号", "新建独立对话"],
  ["&扮演 存档", "查看最近的对话存档"], ["&扮演 继续 存档编号", "继续已有存档"], ["&扮演 状态", "查看当前扮演状态"],
  ["&扮演 退出", "保留存档并回到日常聊天"],
] as const;
