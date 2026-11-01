/**
 * 消息与会话的公共读法。记忆提炼、忆泡、手账三条链路都要用：
 * 「这条消息来自哪个会话」「是不是主人说的」「@ 的是谁」。
 *
 * 抽出来不是为了少写几行，而是防止三条链路各判各的 —— 群聊里「主人」和
 * 「@ 别人」这两件事一旦有一条链读错，写进记忆/手账的事实就反了。
 */

export type ConversationOriginRef = {
  /** `g:<群号>` / `c:<QQ号>` / null（桌面端本地对话）。 */
  externalConversationId: string | null;
};

/** 会话在提示词里的来源标签。群聊必须带群号，否则模型分不清是哪段关系在说话。 */
export function conversationOriginLabel(conversation: ConversationOriginRef): string {
  const key = conversation.externalConversationId ?? "";
  const group = /^g:(\d+)$/.exec(key);
  if (group?.[1]) return `QQ群 ${group[1]}`;
  if (key.startsWith("c:")) return "私聊";
  return "本地对话";
}

/** 这条是主人发的。群聊里主人和群友混在一起，要靠它让提炼/手账认得出主人。 */
export function readMessageIsOwner(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return record.isOwner === true;
}

/**
 * 提炼记忆 / 忆泡时，这条原始消息算不算「主人」说的。
 *
 * 渠道消息看 `metadata.isOwner`；桌面端本地对话没有渠道账号，**唯一能进这个会话的人
 * 就是角色主人**（`Character.ownerId`，接口按登录会话隔离），所以那里的 USER 消息一律算主人。
 *
 * 不标的话，桌面对话的忆泡推导不出「对方」：`deriveParticipantRefs` 只看作者账号，
 * 桌面消息既没有 `authorOpenId` 也没 `isOwner`，写出来的忆泡只剩一个 `self` ——
 * 读起来像「她自己跟自己发生了这件事」。
 */
export function readSourceMessageIsOwner(
  metadata: unknown,
  context: { origin: string; role: string },
): boolean {
  if (readMessageIsOwner(metadata)) return true;
  return context.origin === "本地对话" && context.role === "USER";
}

/** 这条消息 @ 了谁（self / other / all）。没标就是非群聊或没 @ 任何人。 */
export function readMessageMentionTargets(metadata: unknown): string[] {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const value = record.mentionTargets;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * 这条消息是谁发的（渠道账号）。忆泡的参与者引用靠它推导，而不是靠模型写名字。
 *
 * 只取「账号 + 平台」这两个稳定标识；`authorOpenId` 是本项目自己的平台账号 id，
 * 不是第三方 token，进库与检索都安全。
 */
export function readMessageAuthor(metadata: unknown): { authorOpenId?: string; platform?: string } {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const authorOpenId = typeof record.authorOpenId === "string" ? record.authorOpenId.trim() : "";
  const platform = typeof record.platform === "string" ? record.platform.trim() : "";
  return {
    ...(authorOpenId ? { authorOpenId: authorOpenId.slice(0, 80) } : {}),
    ...(platform ? { platform: platform.slice(0, 40) } : {}),
  };
}

/**
 * 这条消息是谁说的。
 *
 * 群聊里一条 USER 消息可能是主人、群友 A、群友 B，也可能是别的 bot —— 只给模型
 * `role: USER` 它会把这些人的经历和情绪全算到角色头上（2026-11-01 P1-3）。
 * `member` 是同一群里稳定的代号（`member_2`），昵称会改、代号不会。
 */
export function readMessageSpeaker(metadata: unknown): { speaker?: string; member?: string } {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const speaker = typeof record.authorDisplayName === "string" ? record.authorDisplayName.trim() : "";
  const member = typeof record.member === "string" ? record.member.trim() : "";
  return {
    ...(speaker ? { speaker: speaker.slice(0, 40) } : {}),
    ...(member ? { member: member.slice(0, 40) } : {}),
  };
}
