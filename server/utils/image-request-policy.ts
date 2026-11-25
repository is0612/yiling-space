import { parseExplicitImageRequest } from "./image-generation";
import { IMAGE_OFFER_TTL_MS, isImageOfferConfirmationText, isImageStatusQuestion, resolveImageOfferConfirmation, type ImageOfferHistoryMessage } from "./image-offer";

export type ImageRequestMessage = {
  id?: string; externalMessageId?: string; authorOpenId: string; occurredAt?: Date | string;
  commandText: string; content: string; source: "current" | "background";
  kind?: "AI" | "HUMAN" | "UNKNOWN"; readOnly?: boolean;
  mentionTargets?: readonly string[]; addressedToSelf: boolean; quotedToSelf: boolean;
};
export type ImageRequestResolution = {
  kind: "direct" | "confirmation" | "none" | "declined" | "status";
  sourceMessageId?: string; authorOpenId?: string; subject?: string; offerId?: string;
  reason?: "not_addressed" | "confirmation_required" | "offer_expired" | "ambiguous_request";
};
export type ImageBlockedReason = "channel_unsupported" | "disabled" | "missing_config" | "quota_unavailable" | "daily_limit" | "voice_conflict" | "declined" | "status_query" | "confirmation_required" | "offer_expired" | "not_addressed" | "cooldown" | "chance" | "ambiguous_request" | "unsafe_prompt" | "missing_prompt";

const statusRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Generic status words can refer to anything; only recent scoped image evidence gives them image meaning. */
function hasImageStatusContext(message: ImageRequestMessage, history: readonly ImageOfferHistoryMessage[], channel: "private" | "group", now: Date | number | undefined): boolean {
  if (resolveImageOfferConfirmation({ ...message, confirmationText: "可以" }, history, now)) return true;
  const nowMs = now instanceof Date ? now.getTime() : now ?? Date.now();
  const rows = history.filter(row => !(row.role === "USER" && row.content === message.content
    && statusRecord(row.metadata).authorOpenId === message.authorOpenId
    && ((message.id && row.id === message.id) || (message.externalMessageId && row.externalMessageId === message.externalMessageId))))
    .sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt));
  for (const row of rows) {
    const meta = statusRecord(row.metadata);
    if (row.role === "USER") {
      if (meta.authorOpenId !== message.authorOpenId || !isImageStatusQuestion(row.content)) return false;
      continue;
    }
    if (row.role !== "ASSISTANT") continue;
    const at = +new Date(row.occurredAt);
    if (!Number.isFinite(at) || at > nowMs || nowMs - at > IMAGE_OFFER_TTL_MS) return false;
    if (meta.generatedBy === "image-execution-status") continue;
    const offer = statusRecord(meta.imageOffer); const attempt = statusRecord(meta.imageAttempt);
    const hasTask = meta.image || meta.imageAttempt || meta.imageOffer || statusRecord(meta.replyDelivery).image;
    const owner = offer.authorOpenId ?? attempt.authorOpenId;
    return Boolean(hasTask) && (channel === "private" || owner === message.authorOpenId);
  }
  return false;
}

/** Only this event's verified recipient facts authorize an action, never a batch-level direct flag. */
export function resolveImageRequest(input: { channel: "private" | "group"; current: readonly ImageRequestMessage[]; history: readonly ImageOfferHistoryMessage[]; now?: Date | number }): ImageRequestResolution {
  const candidates: ImageRequestResolution[] = [];
  for (const message of input.current) {
    if (message.source !== "current" || message.readOnly || message.kind === "AI") continue;
    const text = message.commandText.trim();
    const direct = parseExplicitImageRequest(text);
    const confirmationText = isImageOfferConfirmationText(text);
    const status = isImageStatusQuestion(text) && (/(画|图)/u.test(text) || hasImageStatusContext(message, input.history, input.channel, input.now));
    const declined = /(?:^|[，,。；;！!？?])\s*(?:那|现在|你|请)*(?:别|不要|不用|不必|甭|停止)(?:再)?(?:画|绘制|生成|出图|生图)/u.test(text);
    if (!direct && !confirmationText && !status && !declined) continue;
    const reference = { sourceMessageId: message.externalMessageId ?? message.id, authorOpenId: message.authorOpenId };
    const otherOnly = message.mentionTargets?.includes("other") && !message.mentionTargets.includes("self");
    if (input.channel === "group" && (otherOnly || !(message.addressedToSelf || message.quotedToSelf))) {
      candidates.push({ kind: "none", ...reference, reason: "not_addressed" }); continue;
    }
    const confirmed = confirmationText && input.current.length === 1
      ? resolveImageOfferConfirmation({ ...message, confirmationText: text }, input.history, input.now) : null;
    if (confirmed) { candidates.push({ kind: "confirmation", ...reference, subject: confirmed.prompt, offerId: confirmed.offerMessageId }); continue; }
    // Consent never becomes a fresh request after the proposal was consumed or belongs to someone else.
    if (direct && !confirmationText) { candidates.push({ kind: "direct", ...reference, ...(direct.subject ? { subject: direct.subject } : {}) }); continue; }
    if (declined) { candidates.push({ kind: "declined", ...reference }); continue; }
    if (status) { candidates.push({ kind: "status", ...reference }); continue; }
    const offer = input.current.length === 1 ? resolveImageOfferConfirmation({ ...message, confirmationText: text }, input.history, input.now) : null;
    if (offer) candidates.push({ kind: "confirmation", ...reference, subject: offer.prompt, offerId: offer.offerMessageId });
    else {
      const now = input.now instanceof Date ? input.now.getTime() : input.now ?? Date.now();
      const latest = [...input.history].filter(row => row.role === "ASSISTANT").sort((a, b) => +new Date(b.occurredAt) - +new Date(a.occurredAt))[0];
      const meta = latest?.metadata as { imageOffer?: { authorOpenId?: string }; image?: unknown; imageAttempt?: unknown; replyDelivery?: { image?: unknown } } | null;
      const pending = Boolean(latest && meta?.imageOffer?.authorOpenId === message.authorOpenId
        && !meta.image && !meta.imageAttempt && !meta.replyDelivery?.image);
      const intervening = latest && input.history.some(row => row.role === "USER"
        && +new Date(row.occurredAt) > +new Date(latest.occurredAt)
        && !(row.externalMessageId && row.externalMessageId === message.externalMessageId
          && (row.metadata as { authorOpenId?: unknown } | null)?.authorOpenId === message.authorOpenId && row.content === message.content));
      const expired = pending && latest && now - +new Date(latest.occurredAt) > IMAGE_OFFER_TTL_MS;
      candidates.push(pending && !intervening
        ? { kind: "none", ...reference, reason: input.current.length > 1 ? "ambiguous_request" : expired ? "offer_expired" : "confirmation_required" }
        : { kind: "none" });
    }
  }
  const actions = candidates.filter(item => item.kind !== "none");
  if (actions.length > 1) return { kind: "none", reason: "ambiguous_request" };
  return actions[0] ?? candidates[0] ?? { kind: "none" };
}

/** Owner-enabled autonomous pictures still need fresh human text, not acknowledgements or AI/background material. */
export function isAutonomousImageEligible(current: readonly ImageRequestMessage[], channel: "private" | "group"): boolean {
  return current.some(message => message.source === "current" && !message.readOnly && message.kind !== "AI"
    && Boolean(message.commandText.trim()) && !isImageOfferConfirmationText(message.commandText) && !isImageStatusQuestion(message.commandText)
    && (channel !== "group" || !message.mentionTargets?.includes("other") || message.mentionTargets.includes("self")));
}

/** No conversation UI generation in this feature, including an explicitly requested screenshot. */
export function validateImageScenePrompt(raw: string, options: { requestSubject?: string; participantNames?: readonly string[] } = {}): { ok: true; prompt: string } | { ok: false; reason: "missing_prompt" | "unsafe_prompt" } {
  const prompt = raw.trim();
  if (!prompt) return { ok: false, reason: "missing_prompt" };
  if (/(?:聊天(?:记录|界面|截图|窗口)|对话(?:记录|界面|截图|窗口)|(?:QQ|微信|WeChat)\s*(?:聊天|界面|截图|窗口)|chat\s*(?:log|history|screenshot|window|interface)|messaging\s*(?:app|interface)|@(?:member_\d+|self)\b)/iu.test(prompt)) return { ok: false, reason: "unsafe_prompt" };
  if (options.participantNames?.some(name => name.trim().length > 1 && prompt.includes(name) && !options.requestSubject?.includes(name))) return { ok: false, reason: "unsafe_prompt" };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(prompt)) return { ok: false, reason: "unsafe_prompt" };
  return { ok: true, prompt };
}
