/**
 * 网页对话的前后端共享契约。
 *
 * 注意 `ChatCharacter` **不是** `Character`：这是对话页需要的精简头部
 * （模型参数 + Key 是否可用），不带人设、记忆计数、渠道绑定那些。
 * 别图省事换成 `Character` —— 那会把几十个无关字段塞进每次打开对话的响应里。
 *
 * Key 只回 `chatApiKeyConfigured` / `chatApiKeySource`，不回明文。
 */

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

/** 这次回复参考到的记忆（只给摘要，不带来源消息）。 */
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

/** 删会话的结果：留痕说明哪些东西被保留了（记忆不跟着删）。 */
export type DeleteConversationResult = {
  deletedMessages: number;
  retainedMemories: number;
  retainedSnapshotSources: number;
};
