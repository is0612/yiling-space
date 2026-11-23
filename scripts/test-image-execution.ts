import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { readOnebotCommandText, readOnebotAddressedCommandText, readOnebotMessageText } from "../server/utils/channel-adapter/onebot/types";
import { resolveImageRequest } from "../server/utils/image-request-policy";
import { planImageReplyDecision } from "../server/utils/image-generation";
import { imageDecisionReply, imageStatusReply, imageExecutionLimitForPrompt } from "../server/utils/image-execution";
import { createMediaVisionBudget, isExplicitMediaQuestion, isLatestGeneratedImageQuestion, isLatestGeneratedPromptQuestion } from "../server/utils/media-questions";
import { attachQuotedImageDescriptions } from "../server/utils/channel-adapter/quoted-image-observation";
import { buildStoredMessageMetadata, type ChannelTurnMessage } from "../server/utils/channel-adapter/pipeline";
import { mergeSuppressedAtDelivery } from "../server/utils/channel-adapter/reply-delivery";
import type { GeneratedImageFacts } from "../server/utils/image-facts";

const event = { message: [
  { type: "at", data: { qq: "123456789" } },
  { type: "image", data: { summary: "画一只猫", url: "https://media.invalid/private?rkey=secret" } },
  { type: "mface", data: { summary: "画一只猫" } },
  { type: "reply", data: { id: "101" } },
  { type: "text", data: { text: "只是给她加个画画功能而已" } },
] };
assert.equal(readOnebotCommandText(event), "只是给她加个画画功能而已");
assert.equal(readOnebotCommandText({ message: [{ type: "image", data: { summary: "画一只猫" } }] }), "");
assert.deepEqual(readOnebotAddressedCommandText({ message: [{ type: "text", data: { text: "测试角色，画一只猫" } }] }, ["测试角色"]), { commandText: "画一只猫", namedAddressed: true });
assert.equal(readOnebotAddressedCommandText({ message: [{ type: "text", data: { text: "画一只测试角色" } }] }, ["测试角色"]).namedAddressed, false);
const current = { externalMessageId: "current", authorOpenId: "synthetic-user", content: readOnebotMessageText(event), commandText: readOnebotCommandText(event), source: "current" as const,
  kind: "HUMAN" as const, mentionTargets: ["self"], addressedToSelf: true, quotedToSelf: false };
const none = resolveImageRequest({ channel: "group", current: [current], history: [] });
assert.equal(none.kind, "none");
assert.equal(planImageReplyDecision({ modelConfig: { imageEnabled: true, imageChance: 0 }, channelSupported: true, configured: true, request: none, todayCount: 0 }).status, "not_requested");
const denied = planImageReplyDecision({ modelConfig: { imageEnabled: true, imageDailyLimit: 8 }, channelSupported: true, configured: true, request: { kind: "direct" }, todayCount: 8 });
assert.equal(denied.blockedReason, "daily_limit");
// 不限张数时不能把 0 当上限发给模型：它会读成「额度用完」，然后自己编冷却和张数。
assert.deepEqual(imageExecutionLimitForPrompt(0), {}, "limit 0 是不限，不是上限 0 张。");
assert.deepEqual(imageExecutionLimitForPrompt(-1), {}, "非法值也不给数字。");
assert.deepEqual(imageExecutionLimitForPrompt(8), { dailyLimit: 8 }, "真有上限才给。");
assert.match(imageDecisionReply(denied)!, /没有开始.*额度/);
assert.equal(imageDecisionReply(planImageReplyDecision({ modelConfig: { imageEnabled: true, imageChance: 0 }, request: { kind: "none" }, todayCount: 0 })), null, "ordinary chat must not get a drawing failure response");
assert.match(imageStatusReply([{ role: "ASSISTANT", metadata: { imageAttempt: { status: "blocked", reason: "daily_limit", todayCount: 8, limit: 8 } } }]), /没有开始/);
assert(!imageStatusReply([]).includes("等等"));
assert(!imageStatusReply([{ role: "ASSISTANT", metadata: { imageOffer: { prompt: "an apple" } } }]).includes("排队"));
assert.match(imageStatusReply([{ role: "ASSISTANT", metadata: { replyDelivery: { image: { status: "sent" } } } }]), /确认发出/);
assert.equal(isExplicitMediaQuestion("这个什么意思", true), true);
assert.equal(isExplicitMediaQuestion("这表情真雷霆", true), false);
assert.equal(isLatestGeneratedImageQuestion("你刚才画的图什么样"), true);
assert.equal(isLatestGeneratedImageQuestion("你能看自己画的图吗"), false, "capability question does not consume vision");
assert.equal(isLatestGeneratedImageQuestion("你第一次画的图什么样"), false, "older ambiguous assets must not bind to latest");
for (const text of ["看看你刚画的", "你看看你自己画的图", "你看得见自己画的图吗", "看看刚才画的这张图", "你能看到你刚画的图吗"]) {
  assert.equal(isLatestGeneratedImageQuestion(text), true, text);
}
for (const text of ["你会看自己画的图吗", "你可以看自己画的图吗", "看看你以前画的图", "帮我画张图", "你看见别人画的图了吗"]) {
  assert.equal(isLatestGeneratedImageQuestion(text), false, text);
}
assert.equal(isLatestGeneratedPromptQuestion("你画这个的提示词是啥"), true);
assert.equal(isLatestGeneratedImageQuestion("你画这个的提示词是啥"), false, "prompt inspection must not incur a vision request");
assert.equal(isLatestGeneratedPromptQuestion("你第一次画的图提示词是什么"), false);

const combined = mergeSuppressedAtDelivery({ image: { status: "sent", sentAt: "2026-11-22T12:00:00Z", externalMessageId: "-123" } }, "old-at-target", "passive_policy");
assert.equal(combined.at?.status, "suppressed");
assert.equal(combined.image?.status, "sent");
assert.equal(combined.image?.externalMessageId, "-123", "passive @ policy must not erase the image binding");
const budget = createMediaVisionBudget(3);
assert.equal(budget.consume(2), true);
assert.equal(budget.remaining, 1);
assert.equal(budget.consume(2), false);
const scope = { characterId: "fixture-character", bindingId: "fixture-binding", externalConversationId: "c:fixture" };
const prisma = {} as PrismaClient;
const settings = { model: "mock", apiBaseUrl: "https://model.invalid/v1", apiKey: "test" };
const message: ChannelTurnMessage = { externalMessageId: "current", authorOpenId: "user", commandText: "这张图片是什么", content: "这张图片是什么", quotedMessage: {
  messageId: "101", isSelf: false, content: "字面[图片] [图片]", images: [{ url: "https://media.invalid/a?rkey=secret" }],
  imageTextParts: [{ type: "text", text: "字面[图片] " }, { type: "image", imageIndex: 0, mediaKind: "image" }],
} };
let describeCalls = 0;
const services = { find: async () => null, inspect: async () => { throw new Error("not a generated quote"); }, describe: async () => { describeCalls++; return ["一只猫"]; } };
const [quoted] = await attachQuotedImageDescriptions([message], { prisma, scope, settings, budget }, services);
assert.equal(describeCalls, 1);
assert.equal(budget.remaining, 0);
assert.equal(quoted?.quotedMessage?.content, "字面[图片] [图片：一只猫]");
assert(!JSON.stringify(quoted?.quotedMessage).includes("rkey"));
await attachQuotedImageDescriptions([message], { prisma, scope, settings, budget }, services);
assert.equal(describeCalls, 1, "quote cannot create a fourth vision call");
await attachQuotedImageDescriptions([message], { prisma, scope, settings: null, budget: createMediaVisionBudget() }, services);
assert.equal(describeCalls, 1, "disabled vision does not inspect a quote");
await attachQuotedImageDescriptions([{ ...message, kind: "AI", readOnly: true }], { prisma, scope, settings, budget: createMediaVisionBudget() }, services);
assert.equal(describeCalls, 1, "read-only AI cannot drive a new paid quote observation");

const facts: GeneratedImageFacts = { origin: "self_generated", mode: "text_to_image", requestedDescription: "一只猫", visual: { status: "not_requested" } };
let finds = 0; let inspections = 0;
const generatedServices = { find: async (_p: PrismaClient, incoming: typeof scope) => { finds++; assert.deepEqual(incoming, scope); return { messageId: "row", scope, path: "images/fixture-character/a.jpg", facts }; },
  inspect: async (_p: PrismaClient, _asset: unknown, _settings: unknown, consume: () => boolean) => { inspections++; assert(consume()); return { ...facts, visual: { status: "ok" as const, description: "实际成图是一只猫" } }; }, describe: services.describe };
const own = { ...message, quotedMessage: { ...message.quotedMessage!, isSelf: true } };
const deduped = await attachQuotedImageDescriptions([own, { ...own, externalMessageId: "second" }], { prisma, scope, settings, budget: createMediaVisionBudget() }, generatedServices);
assert.equal(finds, 1); assert.equal(inspections, 1);
assert.equal(deduped[0]?.quotedMessage?.image?.visual.status, "ok");
const idOnly = { ...message, commandText: "看看", quotedMessage: { messageId: "101", isSelf: true, content: "" } };
const [resolvedIdOnly] = await attachQuotedImageDescriptions([idOnly], { prisma, scope, settings, budget: createMediaVisionBudget() }, generatedServices);
assert.equal(resolvedIdOnly?.quotedMessage?.image?.visual.status, "ok", "self quote without gateway image segments still resolves the stored asset");
assert.equal(finds, 2);
assert.equal(inspections, 2);
await attachQuotedImageDescriptions([{ ...idOnly, kind: "AI", readOnly: true }], { prisma, scope, settings, budget: createMediaVisionBudget() }, generatedServices);
assert.equal(inspections, 2, "id-only AI quote must not trigger paid inspection");
const metadata = buildStoredMessageMetadata({ platform: "qq-onebot", storedReason: "recorded", message: { ...own, quotedMessage: { ...own.quotedMessage!, image: facts } } });
const storedQuote = metadata.quotedMessage as Record<string, unknown>;
assert.equal(storedQuote.images, undefined);
assert.equal(storedQuote.imageTextParts, undefined);
assert(!JSON.stringify(storedQuote).includes("rkey"));
assert(!JSON.stringify(storedQuote).includes("media.invalid"));
assert.equal((storedQuote.image as GeneratedImageFacts).requestedDescription, "一只猫");
console.log("Image execution integration: source-only commands, truthful blocking, shared quote budget, cache, metadata privacy and generated asset facts passed (offline).");
