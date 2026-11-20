import type { ApiRequest } from "../utils/request";

export type RoleplaySettings = {
  apiBaseUrl: string; model: string; thinking: boolean; temperature: number;
  maxTokens: number; contextWindowTokens: number; contextBudgetTokens: number;
  recentMessageLimit: number; hasApiKey: boolean;
};
export type RoleplaySettingsInput = Omit<RoleplaySettings, "hasApiKey"> & { apiKey?: string; clearApiKey?: boolean };
export type RoleplayPersona = { id: string; name: string; prompt: string; opening: string; createdAt: string; updatedAt: string };
export type RoleplayPersonaInput = Pick<RoleplayPersona, "name" | "prompt" | "opening">;
export type RoleplaySession = {
  id: string; personaId: string | null; title: string;
  personaSnapshot: RoleplayPersonaInput; summary: string; summaryThrough: number;
  messageCount: number; createdAt: string; updatedAt: string;
};
export type RoleplayMessage = {
  id: string; sequence: number; role: "user" | "assistant"; content: string;
  requestId: string | null; source: string; createdAt: string;
};
export type RoleplayDetail = RoleplaySession & { messages: RoleplayMessage[] };
export type RoleplaySendResult = {
  session: RoleplaySession; userMessage: RoleplayMessage; assistantMessage: RoleplayMessage; replayed: boolean;
};
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
    compress: (id: string) => request<RoleplaySession>({ url: `${sessionPath(id)}/compress`, method: "post", timeout: 240_000 }),
  };
}

export const ROLEPLAY_QQ_COMMANDS = [
  ["/扮演 列表", "查看可用人设"], ["/扮演 开始 人设编号", "新建独立对话"],
  ["/扮演 存档", "查看最近的对话存档"], ["/扮演 继续 存档编号", "继续已有存档"], ["/扮演 状态", "查看当前扮演状态"],
  ["/扮演 退出", "保留存档并回到日常聊天"],
] as const;
