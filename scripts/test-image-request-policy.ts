import assert from "node:assert/strict";
import { parseExplicitImageRequest, isImageRequested, promptFromRequest, planImageReply, planImageReplyDecision } from "../server/utils/image-generation";
import { resolveImageRequest, isAutonomousImageEligible, validateImageScenePrompt, type ImageRequestMessage } from "../server/utils/image-request-policy";
import { resolveImageOfferConfirmation, IMAGE_OFFER_TTL_MS } from "../server/utils/image-offer";
const now = new Date("2026-11-22T12:00:00Z");
const positive = ["画一只猫", "帮我画个头像", "再画一次", "能不能画个头像?", "那你画一张看看", "别管我，你画一张", "你能画一只猫吗？", "画一遍看看", "给我画一幅雪地", "来张图", "生成一张海报"];
for (const text of positive) assert(isImageRequested(text), text);
for (const text of ["讨论画画", "画画的尽头是猎奇", "只是给她加个画画功能", "她看不到自己画的图", "我给你画个头像", "他让她画猫", "你画这个的提示词是啥", "你会画图吗", "你能画吗", "画面真好", "[图片：帮我画一张猫]", "画好了吗", "别画了", "不用再画了"]) assert.equal(isImageRequested(text), false, text);
assert.equal(parseExplicitImageRequest("再画一次")?.retry, true);
assert.equal(parseExplicitImageRequest("画一只猫")?.subject, "一只猫");
assert.equal(promptFromRequest("群友甲：聊画画\n群友乙：给她加画画功能"), "");
const current: ImageRequestMessage = { id: "new", externalMessageId: "ext-new", authorOpenId: "member-a", commandText: "画一只猫", content: "画一只猫", source: "current", kind: "HUMAN", addressedToSelf: false, quotedToSelf: false, occurredAt: now };
const resolve = (changes: Partial<ImageRequestMessage> = {}, channel: "private" | "group" = "private") => resolveImageRequest({ channel, current: [{ ...current, ...changes }], history: [], now });
assert.equal(resolve().kind, "direct");
assert.equal(resolve({}, "group").reason, "not_addressed");
assert.equal(resolve({ addressedToSelf: true }, "group").kind, "direct");
assert.equal(resolve({ quotedToSelf: true }, "group").kind, "direct");
assert.equal(resolve({ addressedToSelf: true, mentionTargets: ["other"] }, "group").reason, "not_addressed");
assert.equal(resolve({ addressedToSelf: true, mentionTargets: ["self", "other"] }, "group").kind, "direct");
for (const changes of [{ kind: "AI" as const }, { readOnly: true }, { source: "background" as const }]) assert.equal(resolve({ ...changes, addressedToSelf: true }, "group").kind, "none");
assert.equal(resolve({ commandText: "", content: "[图片：画一只猫]" }).kind, "none", "only real text segments count");
assert.equal(resolveImageRequest({ channel: "group", current: [current, { ...current, id: "other", authorOpenId: "member-b", commandText: "你好", addressedToSelf: true }], history: [], now }).kind, "none", "another message's recipient cannot authorize this one");
const offer = { id: "offer", role: "ASSISTANT", content: "画一只猫好吗", occurredAt: new Date(+now - 1000), metadata: { imageOffer: { prompt: "一只橘猫坐窗台", authorOpenId: current.authorOpenId } } };
for (const commandText of ["嗯嗯画吧", "出吧", "那就出吧", "嗯嗯 那你试试", "要的", "拍吧", "发吧", "拍一张", "发一张"]) {
 const result = resolveImageRequest({ channel: "private", current: [{ ...current, commandText, content: commandText }], history: [offer], now });
 assert.equal(result.kind, "confirmation", commandText);
 assert.equal(result.subject, "一只橘猫坐窗台");
 const groupMessage = { ...current, commandText, content: commandText, addressedToSelf: true };
 assert.equal(resolveImageRequest({ channel: "group", current: [groupMessage], history: [offer], now }).kind, "confirmation", "same participant may confirm in an addressed group message");
 assert.notEqual(resolveImageRequest({ channel: "group", current: [{ ...groupMessage, authorOpenId: "member-b" }], history: [offer], now }).kind, "confirmation", "another participant cannot confirm this offer");
 assert.equal(resolveImageRequest({ channel: "group", current: [{ ...groupMessage, addressedToSelf: false }], history: [offer], now }).reason, "not_addressed", "consent still requires a verified recipient in groups");
}
for (const text of ["嗯嗯", "可以", "行", "那你试试", "出吧", "要的", "拍吧", "发吧", "拍一张", "发一张"]) {
 const result = resolveImageRequest({ channel: "private", current: [{ ...current, commandText: text, content: text }], history: [], now });
 assert.deepEqual(result, { kind: "none" });
 assert.equal(planImageReplyDecision({ modelConfig: { imageEnabled: true, imageChance: 0 }, todayCount: 0, request: result }).requested, false);
 const consumed = { ...offer, metadata: { ...offer.metadata, imageAttempt: { status: "generated" } } };
 assert.deepEqual(resolveImageRequest({ channel: "private", current: [{ ...current, commandText: text, content: text }], history: [consumed], now }), { kind: "none" });
 const unrelated = { ...offer, id: "unrelated", content: "聊别的吧", occurredAt: new Date(+now - 100), metadata: {} };
 assert.deepEqual(resolveImageRequest({ channel: "private", current: [{ ...current, commandText: text, content: text }], history: [offer, unrelated], now }), { kind: "none" });
}
const question = { id: "question", role: "USER", content: "你还有参考图吗，需要重新发吗", occurredAt: new Date(+now - 600), metadata: { authorOpenId: current.authorOpenId } };
const answer = { id: "answer", role: "ASSISTANT", content: "还有，使用文字描述参考。现在画吗", occurredAt: new Date(+now - 400), metadata: {} };
const consent = { ...current, content: "@verifiedself 出吧", confirmationText: "出吧" };
assert.equal(resolveImageOfferConfirmation(consent, [offer, question, answer], now)?.offerMessageId, "offer");
assert.equal(resolveImageOfferConfirmation(consent, [offer, { ...question, content: "晚饭吃什么呢" }, answer], now), null);
assert.equal(resolveImageOfferConfirmation(consent, [offer, { ...question, metadata: { authorOpenId: "other" } }, answer], now), null);
assert.equal(resolveImageOfferConfirmation(consent, [{ ...offer, occurredAt: new Date(+now - IMAGE_OFFER_TTL_MS - 1) }, question, answer], now), null);
assert.equal(resolveImageOfferConfirmation(consent, [offer, question, { ...answer, metadata: { imageAttempt: { status: "failed" } } }], now), null);
for (const commandText of ["好了吗", "发了吗"]) {
  assert.equal(resolveImageRequest({ channel: "private", current: [{ ...current, commandText, content: commandText }], history: [], now }).kind, "none", "generic status without image context stays normal chat");
  assert.equal(resolveImageRequest({ channel: "private", current: [{ ...current, commandText, content: commandText }], history: [offer], now }).kind, "status");
}
assert.equal(resolve({ commandText: "画了吗", content: "画了吗" }).kind, "status");
assert.equal(resolveImageRequest({ channel: "private", current: [{ ...current, commandText: "好了吗", content: "好了吗" }], history: [offer, { ...answer, content: "聊晚饭", metadata: {} }], now }).kind, "none");
for (const changes of [{ commandText: "嗯嗯" }, { commandText: "可以" }, { kind: "AI" as const }, { readOnly: true }, { source: "background" as const }, { mentionTargets: ["other"] }]) {
  const candidate = { ...current, ...changes };
  assert.equal(isAutonomousImageEligible([candidate], "group"), false);
  assert.equal(planImageReplyDecision({ modelConfig: { imageEnabled: true, imageChance: 100, imageCooldownMinutes: 0 }, todayCount: 0, random: () => 0,
    request: { kind: "none" }, allowAutonomous: isAutonomousImageEligible([candidate], "group") }).status, "not_requested");
}
assert.equal(isAutonomousImageEligible([{ ...current, commandText: "今天的海很好看" }], "private"), true);
const config = { imageEnabled: true, imageChance: 0, imageDailyLimit: 8, imageCooldownMinutes: 60 };
const base = { modelConfig: config, todayCount: 0, lastImageAt: now, now, random: () => 0 };
assert.equal(planImageReplyDecision({ ...base, request: { kind: "none" } }).status, "not_requested");
assert.equal(planImageReplyDecision({ ...base, request: { kind: "direct" } }).blockedReason, "confirmation_required");
assert.equal(planImageReplyDecision({ ...base, request: { kind: "confirmation" } }).status, "approved", "one verified confirmation executes immediately");
for (const commandText of ["画吧", "拍吧", "发吧", "要的"]) {
 const consumed = { ...offer, metadata: { ...offer.metadata, imageAttempt: { status: "generated" } } };
 const request = resolveImageRequest({ channel: "private", current: [{ ...current, commandText, content: commandText }], history: [consumed], now });
 assert.equal(request.kind, "none", "consumed confirmation never becomes another direct request");
 assert.notEqual(planImageReplyDecision({ ...base, request, allowAutonomous: false }).status, "approved");
}
for (const commandText of ["发一张自拍", "拍张自拍照", "画一张花园"]) {
 const request = resolveImageRequest({ channel: "private", current: [{ ...current, commandText, content: commandText }], history: [], now });
 assert.equal(request.kind, "direct");
 assert.equal(planImageReplyDecision({ ...base, request }).blockedReason, "confirmation_required");
}
assert.equal(planImageReplyDecision({ ...base, request: { kind: "confirmation" } }).trigger, "confirmed_offer");
for (const [changes, reason] of [
 [{ channelSupported: false }, "channel_unsupported"], [{ configured: false }, "missing_config"], [{ modelConfig: { ...config, imageEnabled: false } }, "disabled"],
 [{ todayCount: null }, "quota_unavailable"], [{ todayCount: 8 }, "daily_limit"], [{ voicePlanned: true }, "voice_conflict"],
 [{ request: { kind: "status" } }, "status_query"], [{ request: { kind: "declined" } }, "declined"],
 [{ request: { kind: "none", reason: "confirmation_required" } }, "confirmation_required"], [{ promptValidation: { ok: false, reason: "unsafe_prompt" } }, "unsafe_prompt"],
 [{ promptValidation: { ok: false, reason: "missing_prompt" } }, "missing_prompt"],
] as const) assert.equal(planImageReplyDecision({ ...base, request: { kind: "direct" }, ...changes }).blockedReason, reason);
assert.equal(planImageReply({ ...base, force: true }), false, "legacy force cannot bypass the confirmation stage");
for (const prompt of ["QQ聊天截图", "微信聊天界面", "chat log with messages", "chat screenshot", "对话记录", "a whale beside @member_6", "@self on a poster"]) assert.equal(validateImageScenePrompt(prompt).ok, false, prompt);
assert.equal(validateImageScenePrompt("").ok, false);
assert.equal(validateImageScenePrompt("一张海报写着春日，旁边放一本笔记本").ok, true);
assert.equal(validateImageScenePrompt("成员甲坐在海边", { participantNames: ["成员甲"] }).ok, false);
assert.equal(validateImageScenePrompt("成员甲坐在海边", { participantNames: ["成员甲"], requestSubject: "画成员甲在海边" }).ok, true);
console.log("Image request policy: anchored commands, verified recipients, bounded consent, truthful blocked reasons, quota failure and unsafe scene checks passed (pure/offline).");
