/**
 * Shared types and protocol constants for the B站 (bili-cli) channel integration.
 *
 * Unlike the QQ channel (event-driven, passive replies), the bili channel is primarily
 * "active duty": the AI proactively browses the recommendation feed / hot rankings and
 * picks videos. The platform constant and message-event helpers here mirror the QQ module
 * so the reusable channel pipeline can treat both uniformly.
 */

export const BILI_PLATFORM = "bili";

export type BiliMessageEventType = "DM_MESSAGE_CREATE" | "COMMENT_CREATE" | "MENTION_CREATE";

export type BiliMessageEvent = {
  type: BiliMessageEventType;
  /** Stable external id: dm session id, comment rpid, or @ reply id. */
  id: string;
  /** Author uid on bilibili. */
  authorUid: string;
  /** Conversation key: "dm:<sessionId>" or "video:<bvid>". */
  conversationKey: string;
  content: string;
  timestamp: string;
};

/** The text content a bili event delivers. */
export function readBiliMessageText(eventType: BiliMessageEventType, data: unknown): string {
  const record = data as { content?: unknown } | null;
  return typeof record?.content === "string" ? record.content : "";
}

export function readBiliMessageId(data: unknown): string {
  const record = data as { id?: unknown } | null;
  return typeof record?.id === "string" ? record.id : "";
}

export function readBiliAuthorUid(data: unknown): string {
  const record = data as { authorUid?: unknown } | null;
  return typeof record?.authorUid === "string" ? record.authorUid : "";
}

/** The stable conversation key for a bili dm session or comment thread. */
export function biliConversationKey(eventType: BiliMessageEventType, data: unknown): string {
  const record = data as { conversationKey?: unknown } | null;
  return typeof record?.conversationKey === "string" ? record.conversationKey : "";
}
