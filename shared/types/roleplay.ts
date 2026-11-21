/**
 * 角色扮演（独立对话）的前后端共享契约。
 *
 * 凭据边界：`RoleplaySettings` 只回 `hasApiKey` 布尔，**不回明文**；
 * 明文只在 `RoleplaySettingsInput` 里单向传入（`apiKey`），`clearApiKey` 用来清空。
 * 不要为了「读写对称」把 key 加进 `RoleplaySettings`。
 */

export type RoleplaySettings = {
  apiBaseUrl: string;
  model: string;
  thinking: boolean;
  temperature: number;
  maxTokens: number;
  contextWindowTokens: number;
  contextBudgetTokens: number;
  recentMessageLimit: number;
  hasApiKey: boolean;
};

/** 保存设置（**请求**）：apiKey 只写不读；clearApiKey 显式清空。 */
export type RoleplaySettingsInput = Omit<RoleplaySettings, "hasApiKey"> & { apiKey?: string; clearApiKey?: boolean };

export type RoleplayPersona = { id: string; name: string; prompt: string; opening: string; createdAt: string; updatedAt: string };
export type RoleplayPersonaInput = Pick<RoleplayPersona, "name" | "prompt" | "opening">;

export type RoleplaySession = {
  id: string;
  personaId: string | null;
  title: string;
  groupBindingId: string | null;
  groupConversationId: string | null;
  /** 开场时的人设快照：人设后来改了，旧会话仍按当时的样子。 */
  personaSnapshot: RoleplayPersonaInput;
  summary: string;
  summaryThrough: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type RoleplayMessage = {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  requestId: string | null;
  source: string;
  createdAt: string;
};

export type RoleplayDetail = RoleplaySession & { messages: RoleplayMessage[] };

export type RoleplaySendResult = {
  session: RoleplaySession;
  userMessage: RoleplayMessage;
  assistantMessage: RoleplayMessage;
  /** true = 幂等命中，没有真的再调一次模型。 */
  replayed: boolean;
};
