/** A short-lived, structured drawing proposal. This module never infers offers from prose. */
export const IMAGE_OFFER_TTL_MS = 5 * 60_000;
const MAX_OFFER_PROMPT_CHARS = 1200;

export type ImageOfferCurrentMessage = {
  id?: string;
  externalMessageId?: string;
  authorOpenId: string;
  content: string;
  confirmationText?: string;
  occurredAt?: Date | string;
};
export type ImageOfferHistoryMessage = {
  id: string;
  externalMessageId?: string | null;
  role: string;
  content: string;
  occurredAt: Date | string;
  metadata: unknown;
};
export type ImageOfferConfirmation = { prompt: string; offerMessageId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function timestamp(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** Exact consent phrases only: status checks, questions and additional tasks are not consent. */
export function isImageOfferConfirmationText(content: string): boolean {
  if (content.length > 32 || /[?？]/u.test(content)) return false;
  const compact = content.trim().replace(/[\s，,。.!！~～]+/gu, "");
  return /^(?:(?:嗯嗯|嗯|好啊|好呀|好的|好|可以|要的|行啊|行)(?:那|那就)?(?:你)?(?:试试|试试看|画吧|拍吧|发吧|拍一张|发一张|出吧|出一张|画一张看看)?|(?:那|那就)?(?:你)?(?:试试|试试看|画吧|拍吧|发吧|拍一张|发一张|出吧|出一张|画一张看看))$/u.test(compact);
}

/** Status questions must not turn into a fresh drawing through the random-image branch. */
export function isImageStatusQuestion(content: string): boolean {
  if (content.length > 32) return false;
  const compact = content.trim().replace(/[\s，,。.!！?？~～]+/gu, "");
  return /^(?:那|现在|所以)?(?:画了吗|画好了没|画好了吗|好了吗|发了吗|发出来了吗|图呢|图片呢|出图了吗)(?:呀|啊|呢)?$/u.test(compact);
}

/**
 * Resolve only the first reply to the latest assistant offer, within the same conversation.
 * Caller must supply history from this role/conversation, not cross-channel context.
 * Current rows pre-recorded in private chat are excluded only by exact identity and content.
 */
export function resolveImageOfferConfirmation(
  currentMessage: ImageOfferCurrentMessage | readonly ImageOfferCurrentMessage[],
  recentMessages: readonly ImageOfferHistoryMessage[],
  now: Date | number = new Date(),
): ImageOfferConfirmation | null {
  const currentMessages: readonly ImageOfferCurrentMessage[] = Array.isArray(currentMessage)
    ? currentMessage : [currentMessage as ImageOfferCurrentMessage];
  // Multiple messages are ambiguous even when they have the same author.
  if (currentMessages.length !== 1) return null;
  const current = currentMessages[0]!;
  const nowMs = now instanceof Date ? now.getTime() : now;
  const currentAt = current.occurredAt === undefined ? nowMs : timestamp(current.occurredAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(currentAt) || currentAt > nowMs
    || !current.authorOpenId || !isImageOfferConfirmationText(current.confirmationText ?? current.content)) return null;

  const rows = recentMessages.filter(row => {
    if (row.role !== "USER") return true;
    const sameId = Boolean(current.id && row.id === current.id)
      || Boolean(current.externalMessageId && row.externalMessageId === current.externalMessageId);
    if (!sameId) return true;
    const meta = record(row.metadata);
    // Do not hide a different user, a changed row, or a stale row reusing an identifier.
    return !(meta.authorOpenId === current.authorOpenId && row.content === current.content
      && (current.occurredAt === undefined || timestamp(row.occurredAt) === currentAt));
  }).filter(row => row.role === "USER" || row.role === "ASSISTANT");
  if (!rows.length || rows.some(row => !Number.isFinite(timestamp(row.occurredAt))
    || timestamp(row.occurredAt) > nowMs || timestamp(row.occurredAt) > currentAt)) return null;
  const ordered = [...rows].sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt));
  let offer = ordered[0]!;
  // Permit exactly one question/answer about the already offered image. No unrelated turn,
  // other participant, denial or execution may be crossed to recover an old proposal.
  if (ordered.length >= 3 && offer.role === "ASSISTANT" && !record(record(offer.metadata).imageOffer).prompt) {
    const answerMeta = record(offer.metadata);
    const question = ordered[1]!;
    const candidate = ordered[2]!;
    const compact = question.content.replace(/\s+/gu, "");
    const clarification = compact.length <= 80 && /(?:图|画|参考|形象|三视图)/u.test(compact)
      && /(?:吗|呢|什么|哪|需要|还有|是指|能否|可不可以|是不是|是否|看得见)/u.test(compact)
      && !/(?:别画|不要|不用|不必|停止|取消)/u.test(compact);
    if (question.role === "USER" && record(question.metadata).authorOpenId === current.authorOpenId
      && clarification && candidate.role === "ASSISTANT"
      && !["image", "imageAttempt"].some(key => Object.prototype.hasOwnProperty.call(answerMeta, key))
      && !Object.prototype.hasOwnProperty.call(record(answerMeta.replyDelivery), "image")) offer = candidate;
  }
  const offerAt = timestamp(offer.occurredAt);
  if (offer.role !== "ASSISTANT" || !offer.id || offerAt > nowMs || currentAt < offerAt
    || nowMs - offerAt > IMAGE_OFFER_TTL_MS || currentAt - offerAt > IMAGE_OFFER_TTL_MS) return null;
  // Equal timestamps do not establish a safe conversational order.
  if (ordered.slice(1).some(row => timestamp(row.occurredAt) === offerAt && row.id !== offer.id)) return null;
  const meta = record(offer.metadata);
  const proposal = record(meta.imageOffer);
  if (Object.prototype.hasOwnProperty.call(meta, "image")
    || Object.prototype.hasOwnProperty.call(meta, "imageAttempt")
    || Object.prototype.hasOwnProperty.call(record(meta.replyDelivery), "image")) return null;
  if (proposal.authorOpenId !== current.authorOpenId || typeof proposal.prompt !== "string") return null;
  const prompt = proposal.prompt.trim();
  if (!prompt || prompt.length > MAX_OFFER_PROMPT_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(prompt)) return null;
  return { prompt, offerMessageId: offer.id };
}
