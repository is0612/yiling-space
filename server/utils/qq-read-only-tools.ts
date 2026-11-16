import type { MemoryAssistantCandidate } from "./memory-assistant";
import type { ConversationKnowledgeItem } from "./chat-reply";

/** QQ tool results expose bounded evidence, never routing or authorization metadata. */
const safeText = (value: string | undefined, limit: number): string => (value ?? "")
  .replace(/\b\d{5,12}\b/gu, "[账号已隐藏]").slice(0, limit);
export function qqReadOnlyTaskRequested(message: string): boolean {
  return /https?:\/\/\S+|查找|查询|搜索|搜一下|查一下|查一查|找一下|找找|读一下|读取|看一下|看看|记得|还记不记得|之前.{0,20}(说|聊|答应|约定)|上次|第一次|哪天|什么时候/u.test(message);
}
export function projectToolMemories(rows: MemoryAssistantCandidate[], group: boolean) {
  return rows.filter(row => !group || row.scope === "character").slice(0, 6).map(row => ({
    sourceType: row.sourceType,
    content: safeText(row.content ?? row.detail ?? row.summary, 800),
    ...(row.title ? { title: safeText(row.title, 120) } : {}),
    ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
  }));
}
export function projectToolKnowledge(rows: ConversationKnowledgeItem[]) {
  return rows.slice(0, 6).map(row => ({ title: safeText(row.title, 120), content: safeText(row.content, 800) }));
}
