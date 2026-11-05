/**
 * 记忆范围的人话名字。
 *
 * 快照 / 任务都按范围存，范围本身只有 `scopeType` 和形如
 * `character:<id>:external:qq-onebot:<QQ号>` 的 key —— 直接显示对用户没有意义。
 * 群会话和私聊都挂在外部身份范围下，只能从会话编号区分，所以优先看会话，
 * 再看 scopeKey 结尾的账号。
 */
export type ScopelikeConversation = {
  externalConversationId: string | null;
  title?: string | null;
};

export function describeMemoryScope(input: {
  scopeType: string;
  scopeKey?: string | null;
  conversations?: ScopelikeConversation[];
}): string {
  if (input.scopeType === "CHARACTER_GLOBAL") return "角色全局";
  if (input.scopeType === "USER_PRIVATE") return "主人私聊";

  const conversations = input.conversations ?? [];
  // 群聊优先：同一个范围里可能同时挂着群会话和私聊会话，群才是这个人「在什么地方」
  const group = conversations.find((item) => item.externalConversationId?.startsWith("g:"));
  if (group?.externalConversationId) return "QQ群 " + group.externalConversationId.slice(2);
  const privateChat = conversations.find((item) => item.externalConversationId?.startsWith("c:"));
  if (privateChat?.externalConversationId) return "QQ私聊 " + privateChat.externalConversationId.slice(2);

  const tail = input.scopeKey?.split(":").pop();
  return tail ? "外部身份 " + tail : "外部身份";
}
