import type { ApiRequest } from "../utils/request";

export type ChatCharacter = {
  id: string;
  name: string;
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
  chatApiBaseUrl: string;
  chatApiKeyConfigured: boolean;
  chatApiKeySource: "character" | "environment" | "missing";
};

export type MemoryScopeOrigin = "character" | "private";

export type ChatMemorySource = {
  id: string;
  category: string;
  content: string;
  scope?: MemoryScopeOrigin;
};

export type ChatSnapshotSource = {
  id: string;
  summary: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  scope?: MemoryScopeOrigin;
};

export type ChatMessage = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  occurredAt: string;
  sources?: { memories: ChatMemorySource[]; snapshots: ChatSnapshotSource[] };
};

export type ConversationSummary = {
  id: string;
  title: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
};

export type ChatHistoryResponse = {
  character: ChatCharacter;
  modelConfigured: boolean;
  conversations: ConversationSummary[];
  selectedConversationId: string | null;
  messages: ChatMessage[];
};

export type ChatExportPage = {
  conversationId: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  page: number;
  pageSize: number;
  total: number;
  messages: ChatMessage[];
};

export type ChatSendResponse = {
  conversationId: string;
  title: string;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  model: { name: string; provider: string; promptTemplateVersion: string };
  retrieval: { memoriesAvailable: number; snapshotsAvailable: number; privateScopeActive?: boolean };
};

export type ConversationUpdateResult = {
  id: string;
  title: string;
  status: "ACTIVE" | "ARCHIVED";
  updatedAt: string;
};

export type DeleteConversationResult = {
  deletedMessages: number;
  retainedMemories: number;
  retainedSnapshotSources: number;
};

const characterPath = (characterId: string) => `/characters/${encodeURIComponent(characterId)}`;
const chatPath = (characterId: string) => `${characterPath(characterId)}/chat`;
const conversationPath = (characterId: string, conversationId: string) =>
  `${chatPath(characterId)}/${encodeURIComponent(conversationId)}`;

/**
 * 网页对话接口：角色对话头、会话历史、改名/归档、删除、导出分页与发送。
 *
 * 只拼路径、声明出入参；会话切换竞态、请求幂等键与提示文案留在页面里。
 */
export function createChatApi(request: ApiRequest) {
  function getCharacter(characterId: string): Promise<ChatCharacter> {
    return request<ChatCharacter>({ url: characterPath(characterId), method: "get" });
  }

  function listHistory(payload: {
    characterId: string;
    status: "ACTIVE" | "ARCHIVED";
    conversationId?: string | null;
    search?: string;
  }): Promise<ChatHistoryResponse> {
    return request<ChatHistoryResponse>({
      url: chatPath(payload.characterId),
      method: "get",
      params: {
        status: payload.status,
        conversationId: payload.conversationId ?? undefined,
        q: payload.search || undefined,
      },
    });
  }

  function updateConversation(payload: {
    characterId: string;
    conversationId: string;
    title?: string;
    status?: "ACTIVE" | "ARCHIVED";
  }): Promise<ConversationUpdateResult> {
    return request<ConversationUpdateResult>({
      url: conversationPath(payload.characterId, payload.conversationId),
      method: "patch",
      data: { title: payload.title, status: payload.status },
    });
  }

  function deleteConversation(payload: {
    characterId: string;
    conversationId: string;
  }): Promise<DeleteConversationResult> {
    return request<DeleteConversationResult>({
      url: conversationPath(payload.characterId, payload.conversationId),
      method: "delete",
    });
  }

  function listMessagePage(payload: {
    characterId: string;
    conversationId: string;
    page: number;
    pageSize: number;
  }): Promise<ChatExportPage> {
    return request<ChatExportPage>({
      url: conversationPath(payload.characterId, payload.conversationId),
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize },
    });
  }

  function sendMessage(payload: {
    characterId: string;
    requestKey: string;
    message: string;
    conversationId?: string | null;
    localTaskId?: string;
  }): Promise<ChatSendResponse> {
    return request<ChatSendResponse>({
      url: chatPath(payload.characterId),
      method: "post",
      data: { requestKey: payload.requestKey, message: payload.message, conversationId: payload.conversationId ?? undefined, ...(payload.localTaskId ? { localTaskId: payload.localTaskId } : {}) },
    });
  }

  return {
    getCharacter,
    listHistory,
    updateConversation,
    deleteConversation,
    listMessagePage,
    sendMessage,
  };
}

export type ChatApi = ReturnType<typeof createChatApi>;
