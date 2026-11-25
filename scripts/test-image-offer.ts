import assert from "node:assert/strict";
import { IMAGE_OFFER_TTL_MS, isImageOfferConfirmationText, isImageStatusQuestion, resolveImageOfferConfirmation,
  type ImageOfferCurrentMessage, type ImageOfferHistoryMessage } from "../server/utils/image-offer";

const T0 = Date.parse("2026-11-22T12:00:00Z");
const user = "synthetic-user";
const offer: ImageOfferHistoryMessage = { id: "offer", role: "ASSISTANT", content: "可以画一个苹果", occurredAt: new Date(T0),
  metadata: { imageOffer: { prompt: "一只红苹果放在木桌上，柔和侧光", authorOpenId: user } } };
const current: ImageOfferCurrentMessage = { id: "current", externalMessageId: "external-current", authorOpenId: user, content: "嗯嗯 那你试试", occurredAt: new Date(T0 + 1000) };
const expected = { prompt: "一只红苹果放在木桌上，柔和侧光", offerMessageId: "offer" };
const resolve = (rows: readonly ImageOfferHistoryMessage[] = [offer], message: ImageOfferCurrentMessage | readonly ImageOfferCurrentMessage[] = current, now = T0 + 1000) => resolveImageOfferConfirmation(message, rows, now);
assert.deepEqual(resolve(), expected);
for (const text of ["嗯嗯 那你试试", "好啊", "那试试", "可以", "试试看", "那就试试", "行", "画吧", "嗯嗯", "好啊，那你试试！", "要的", "拍吧", "发吧", "拍一张", "发一张", "嗯嗯，那你拍吧！"]) {
  assert.equal(isImageOfferConfirmationText(text), true, text);
  assert.deepEqual(resolve([offer], { ...current, content: text }), expected, text);
  assert.equal(resolve([], { ...current, content: text }), null, "consent without structured proposal is not a drawing request");
}
for (const text of ["画了吗", "好了吗", "发了吗", "画好了没", "可以吗", "嗯嗯？", "别画了", "不可以", "那你试试，顺便查一下天气", "我觉得可以，不过先等等", "嗯嗯那你试试".repeat(8), "画完发我"]) {
  assert.equal(isImageOfferConfirmationText(text), false, text);
  assert.equal(resolve([offer], { ...current, content: text }), null, text);
}
for (const text of ["画了吗", "画好了没", "画好了吗", "好了吗", "发了吗", "图呢", "图片呢", "出图了吗", "现在画好了吗？", "那图呢呀！"]) assert.equal(isImageStatusQuestion(text), true, text);
for (const text of ["画完发我", "画好再发", "画一只猫", "嗯嗯那你试试", "画好了没关系", "没画好吗？那再画一张", "你说的那个好了吗是指什么"]) assert.equal(isImageStatusQuestion(text), false, text);
assert.equal(resolve([offer], { ...current, authorOpenId: "another-user" }), null);
for (const content of ["要的", "拍吧", "发吧", "拍一张", "发一张"]) {
  assert.equal(resolve([offer], { ...current, content, authorOpenId: "another-user" }), null, "photo consent cannot consume another participant's proposal");
  assert.equal(resolve([{ ...offer, metadata: { ...(offer.metadata as object), imageAttempt: { status: "generated" } } }], { ...current, content }), null, "photo consent cannot reuse a consumed proposal");
  assert.equal(resolve([offer], { ...current, content }, T0 + IMAGE_OFFER_TTL_MS + 1), null, "photo consent cannot reuse an expired proposal");
}
assert.equal(resolve([offer], []), null);
assert.equal(resolve([offer], [current, { ...current, id: "another", authorOpenId: "another-user" }]), null);
assert.equal(resolve([offer], [current, { ...current, id: "second-same-author" }]), null, "multiple same-author messages are still ambiguous");
assert.equal(resolve([offer], current, T0 + IMAGE_OFFER_TTL_MS + 1), null);
assert.deepEqual(resolve([offer], { ...current, occurredAt: new Date(T0 + IMAGE_OFFER_TTL_MS) }, T0 + IMAGE_OFFER_TTL_MS), expected, "exact TTL is allowed");
assert.equal(resolve([{ ...offer, occurredAt: new Date(T0 + 2000) }]), null, "future offer");
assert.equal(resolve([offer], { ...current, occurredAt: new Date(T0 - 1) }), null, "confirmation predates offer");
assert.equal(resolve([offer], { ...current, occurredAt: new Date(T0 + 2000) }), null, "future confirmation");
assert.equal(resolve([{ ...offer, occurredAt: "invalid" }]), null);
assert.equal(resolve([offer], { ...current, occurredAt: "invalid" }), null);
assert.equal(resolve([offer], current, Number.NaN), null);
assert.deepEqual(resolve([offer], { ...current, occurredAt: undefined }), expected, "caller can use receive time when absent");
for (const metadata of [{}, { imageOffer: "an apple" }, { imageOffer: { prompt: "apple" } },
  { imageOffer: { prompt: "apple", authorOpenId: "self" } }, { imageOffer: { prompt: " ", authorOpenId: user } },
  { imageOffer: { prompt: "x".repeat(1201), authorOpenId: user } },
  { imageOffer: { prompt: "apple\u0000", authorOpenId: user } },
  { ...(offer.metadata as object), image: { path: "images/generated.jpg" } },
  { ...(offer.metadata as object), image: null },
  { ...(offer.metadata as object), imageAttempt: { status: "generation_failed" } },
  { ...(offer.metadata as object), imageAttempt: { status: "missing_prompt" } },
  ...["sent", "failed", "unknown"].map(status => ({ ...(offer.metadata as object), replyDelivery: { image: { status } } })),
]) assert.equal(resolve([{ ...offer, metadata }]), null);
assert.equal(resolve([{ ...offer, metadata: {}, content: "要不要我给你画一个苹果？" }]), null, "never infer offers from assistant prose");
for (const role of ["USER", "ASSISTANT"]) {
  const consumed = { id: "consumed", role, content: "别的话", occurredAt: new Date(T0 + 500), metadata: { authorOpenId: user } };
  assert.equal(resolve([offer, consumed]), null);
  assert.equal(resolve([consumed, offer]), null, "input ordering is irrelevant");
}
assert.equal(resolve([offer, { ...offer, id: "newer-assistant", occurredAt: new Date(T0 + 500), metadata: {} }]), null, "only newest assistant proposal can be used");
assert.equal(resolve([offer, { ...offer, id: "same-time", role: "USER", metadata: { authorOpenId: user } }]), null, "ambiguous timestamp order fails closed");
const prior = { id: "prior", role: "USER", content: "画什么呢", occurredAt: new Date(T0 - 1000), metadata: { authorOpenId: user } };
assert.deepEqual(resolve([prior, offer]), expected);
assert.deepEqual(resolve([offer, prior]), expected);
// A restarted process sees the private user's current row already persisted; exact id and identity exclude it.
const recorded = { id: current.id!, externalMessageId: current.externalMessageId, role: "USER", content: current.content,
  occurredAt: current.occurredAt!, metadata: { authorOpenId: user } };
assert.deepEqual(resolve([recorded, prior, offer]), expected);
assert.deepEqual(resolve([recorded, offer], { ...current, id: undefined }), expected, "external platform id may match stored row");
assert.equal(resolve([{ ...recorded, id: "other", externalMessageId: "different" }, offer]), null, "same text does not hide a different message");
assert.equal(resolve([{ ...recorded, metadata: { authorOpenId: "another-user" } }, offer]), null, "same id cannot hide another author");
assert.equal(resolve([{ ...recorded, content: "other content" }, offer]), null);
assert.equal(resolve([{ ...recorded, occurredAt: new Date(T0 + 500) }, offer]), null, "id reuse cannot hide different occurrence");
assert.equal(resolve([recorded, offer], { ...current, id: undefined, externalMessageId: undefined }), null, "no ids means no pre-record exclusion");
assert.deepEqual(resolve([{ ...offer, metadata: { ...(offer.metadata as object), isOwner: false } }]), expected, "scope follows proposal recipient, never owner status");
assert.deepEqual(resolve([offer], current, new Date(T0 + 1000).getTime()), expected);
console.log("Image offer confirmation: exact consent, scoped identity, TTL, consumed history, private pre-recording and status checks passed (synthetic; no model/QQ/database calls).");
