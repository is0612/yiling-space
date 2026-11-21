// 对话页的形状与后端共用（`shared/types/chat.ts`）。
import type { ApiRequest } from "../utils/request";
import type {
  ChatCharacter, ChatExportPage, ChatHistoryResponse, ChatMessage, ChatMemorySource, ChatSendResponse,
  ChatSnapshotSource, ConversationSummary, ConversationUpdateResult, DeleteConversationResult, MemoryScopeOrigin,
} from "#shared/types/chat";
export type * from "#shared/types/chat";

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
