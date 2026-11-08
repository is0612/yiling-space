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

export type MessageMentionTarget = "self" | "other" | "all";
export type MessageMentionKind = "AI" | "HUMAN" | "UNKNOWN";

/**
 * 一条消息里被 @ 的对象（按 at 段出现顺序）。
 *
 * 和 `mentionTargets` 的分工：那个只是方向分类，够判断「是不是在叫她」；
 * 但判断「@ 的是谁」需要具体对象 —— 群里有好几个 bot，`other` 只是「不是她」，
 * 模型仍可能把对方认成她本人（2026-11-08 实际踩到：owner @ 另一个 AI「某个称呼」，
 * 忆泡写成「对 <被 @ 的 QQ>（当前角色）说」）。这里保留 QQ（认人用）、群成员代号、
 * 显示名与身份类型，昵称改了也仍按 QQ 对得上。
 */
export type ConversationMessageMention = {
  /** 原始平台账号。只用于把正文里的 @ 与对象对上，进角色/记忆/手账提示词前会剥掉。 */
  qq?: string;
  target: MessageMentionTarget;
  /** 群内稳定代号（`member_2`）：和 transcript 里的 @member_n 对应。 */
  member?: string;
  /** 被 @ 对象的显示名；网关没给、身份表也没有时为空。 */
  speaker?: string;
  /** 被 @ 对象的身份。UNKNOWN 是「不知道」，不是「她本人」。 */
  kind?: MessageMentionKind;
};

const MENTION_TARGETS = new Set<MessageMentionTarget>(["self", "other", "all"]);
const MENTION_KINDS = new Set<MessageMentionKind>(["AI", "HUMAN", "UNKNOWN"]);

function textField(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

/** 校验并收敛 @ 对象列表；坏字段跳过，不因为一条脏数据把整条消息的目标信息丢掉。 */
export function sanitizeMessageMentions(value: unknown): ConversationMessageMention[] {
  if (!Array.isArray(value)) return [];
  const out: ConversationMessageMention[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const target = typeof record.target === "string" && MENTION_TARGETS.has(record.target as MessageMentionTarget)
      ? record.target as MessageMentionTarget
      : null;
    if (!target) continue;
    const qq = textField(record.qq, 32);
    const member = textField(record.member, 40);
    const speaker = textField(record.speaker, 80);
    const rawKind = textField(record.kind, 16);
    const kind = MENTION_KINDS.has(rawKind as MessageMentionKind) ? rawKind as MessageMentionKind : undefined;
    // `other` 必须至少有一个能落地成具体对象的标识；否则这条 mention 只会让模型再猜一次。
    if (target === "other" && !qq && !member && !speaker) continue;
    const key = `${target}:${qq || member || speaker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      target,
      ...(qq ? { qq } : {}),
      ...(member ? { member } : {}),
      ...(speaker ? { speaker } : {}),
      ...(kind ? { kind } : {}),
    });
  }
  return out;
}

/** 从消息 metadata 里读 @ 对象详情；老消息没有这个字段时返回空数组。 */
export function readMessageMentions(metadata: unknown): ConversationMessageMention[] {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return sanitizeMessageMentions(record.mentions);
}

/**
 * 把正文里的 `@<qq>` 换成 `@self` / `@all` / `@member_n`。
 *
 * 记忆/手账的提示词不该出现真实账号；而要不要换、换成谁，只能由**结构化 mentions**
 * 决定 —— 正则猜不出这个号码是当前角色、别的 bot 还是人类。没有 mentions 的老消息
 * 原样返回，保持旧行为。
 */
export function formatMentionContent(
  content: string,
  mentions: readonly ConversationMessageMention[] | undefined,
): string {
  if (!mentions?.length || !content) return content;
  let out = content;
  for (const mention of mentions) {
    if (!mention.qq) continue;
    const label = mention.target === "self"
      ? "@self"
      : mention.target === "all"
        ? "@all"
        : mention.member
          ? `@${mention.member}`
          : "";
    if (!label) continue;
    out = out.split(`@${mention.qq}`).join(label);
    out = out.split(`[CQ:at,qq=${mention.qq}]`).join(label);
  }
  return out;
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
