import { shouldBlockFriendSpeaker, type FriendIdentityKind, type FriendChatPolicy } from "../friend-chat-policy";
import type { ConversationMessageMention } from "../conversation-message";
import type { ChannelReplyDelivery } from "./pipeline";

/** A suppressed reminder must never discard an image or any other confirmed delivery facts. */
export function mergeSuppressedAtDelivery(delivery: ChannelReplyDelivery, requestedMessageId: string, reason: "voice" | "passive_policy"): ChannelReplyDelivery {
  return { ...delivery, at: { requestedMessageId, status: "suppressed", reason } };
}

/** Stored platform identity is resolved against this round, never a previously stored member_n. */
export function readDeliveredAtTarget(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const delivery = (metadata as Record<string, unknown>).replyDelivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  const at = (delivery as Record<string, unknown>).at;
  if (!at || typeof at !== "object" || Array.isArray(at)) return null;
  const fact = at as Record<string, unknown>;
  return fact.status === "sent" && typeof fact.targetQq === "string" && /^\d+$/u.test(fact.targetQq) ? fact.targetQq : null;
}

export function readDeliveredAtMention(
  metadata: unknown,
  resolveMember?: (qq: string) => { member: string; speaker?: string } | null,
): ConversationMessageMention[] {
  if (!resolveMember || !metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const delivery = (metadata as Record<string, unknown>).replyDelivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return [];
  const at = (delivery as Record<string, unknown>).at;
  if (!at || typeof at !== "object" || Array.isArray(at)) return [];
  const fact = at as Record<string, unknown>;
  if (fact.status !== "sent" || typeof fact.targetQq !== "string" || !/^\d+$/u.test(fact.targetQq)) return [];
  const target = resolveMember(fact.targetQq);
  // A resolver is an internal boundary, but invalid/raw identities still fail closed.
  if (!target || !/^member_\d+$/u.test(target.member)) return [];
  return [{ target: "other", member: target.member,
    ...(target.speaker ? { speaker: target.speaker.slice(0, 80) } : {}) }];
}

/** Query failure hides only reminder facts; missing identities use the existing UNKNOWN/DEFAULT policy. */
export function blockedDeliveredAtTargets(
  targets: readonly string[],
  identities: readonly { platformUid: string; kind: FriendIdentityKind; memoryScopes: readonly { friendChatPolicy: FriendChatPolicy }[] }[] | null,
): Set<string> {
  if (identities === null) return new Set(targets);
  const byUid = new Map(identities.map(identity => [identity.platformUid, identity]));
  return new Set(targets.filter(uid => {
    const identity = byUid.get(uid);
    return shouldBlockFriendSpeaker(identity?.kind ?? "UNKNOWN", identity?.memoryScopes[0]?.friendChatPolicy ?? "DEFAULT");
  }));
}
