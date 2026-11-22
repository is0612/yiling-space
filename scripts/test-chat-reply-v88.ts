import assert from "node:assert/strict";
import { generateConversationReply, type ConversationReplyInput } from "../server/utils/chat-reply";
import { analyzeGroupContext, CONTEXT_ASSISTANT_DEFAULTS } from "../server/utils/context-assistant";
import { shouldRepairRepeatedReply } from "../server/utils/repeated-reply";
const old = globalThis.fetch;
const repeated = "这是刚才那一整段比较长的回答，包含不应该再重复的判断。";
const base: ConversationReplyInput = { characterName: "测试角色", characterPrompt: "自然交流", model: "mock", apiKey: "not-exposed", apiBaseUrl: "https://mock.invalid/v1", currentMessage: "不是你听错了，是我说错了", memories: [], snapshots: [], recentMessages: [{ role: "ASSISTANT", content: repeated, occurredAt: "2026-01-01T00:00:00Z" }] };
let outputs: string[] = []; let bodies: Array<{ messages: Array<{role:string;content:string}> }> = [];
globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, choices: [{ message: { content: outputs.shift() ?? JSON.stringify({ reply: "收到" }) }, finish_reason: "stop" }] }); };
const reset = (...replies: string[]) => { outputs = replies.map(reply => JSON.stringify({ reply })); bodies = []; };
try {
  reset(repeated, "明白，是你更正了上一句话，我按这句理解。");
  const result = await generateConversationReply(base);
  assert.equal(bodies.length, 2); assert.notEqual(result.reply, repeated); assert.equal(result.usage?.totalTokens, 26);
  assert(bodies[1]!.messages[0]!.content.includes("previous candidate repeated"));
  assert(bodies[1]!.messages[1]!.content.includes(base.currentMessage));
  reset(repeated, repeated); const fallback = await generateConversationReply(base); assert.equal(bodies.length, 2); assert.notEqual(fallback.reply, repeated); assert.equal(fallback.imagePrompt, null); assert.equal(fallback.usage?.totalTokens, 26);
  reset(repeated, repeated); const silent = await generateConversationReply({ ...base, groupChat: true, allowSilent: true }); assert.equal(silent.action, "silent"); assert.equal(silent.reply, "");
  reset(repeated); assert.equal((await generateConversationReply({ ...base, currentMessage: "把上一句原样再说一遍" })).reply, repeated); assert.equal(bodies.length, 1);
  assert.equal(shouldRepairRepeatedReply(repeated, base.recentMessages, "你怎么又重复了"), true);
  assert.equal(shouldRepairRepeatedReply("知道了", [{role:"ASSISTANT",content:"知道了"}], "嗯嗯"), false);
  reset(repeated); outputs.unshift("broken output"); const afterMalformed = await generateConversationReply(base); assert.equal(bodies.length, 2); assert.notEqual(afterMalformed.reply, repeated); assert.equal(afterMalformed.usage?.totalTokens, 26);
  reset("收到");
  const facts = { origin: "self_generated" as const, mode: "text_to_image" as const, requestedDescription: "一只苹果", visual: { status: "not_requested" as const }, path: "/secret.png", url: "https://secret.invalid", qq: "123456789" };
  const execution = { plannedThisTurn:false, latestAssistant:"offered" as const, status:"blocked" as const, trigger:"direct" as const, requested:true, blockedReason:"daily_limit", todayCount:8, dailyLimit:8, path:"/secret.png" };
  await generateConversationReply({ ...base, currentMessage:"这张图呢[表情包：不应该复述的画面]", imageExecution:execution,
    imageCapabilities:{generation:"text_to_image",referenceInput:false,edit:false,selfInspection:"disabled",quotedImageInspection:true},
    quotedMessage:{messageId:"private-platform-id",content:"[图片]",image:facts}, recentMessages:[{...base.recentMessages[0]!,generatedImage:facts}] });
  const body = bodies[0]!; const payload = JSON.parse(body.messages[1]!.content); const system=body.messages[0]!.content;
  assert.equal(payload.imageExecution.blockedReason,"daily_limit"); assert.equal(payload.imageExecution.todayCount,8); assert.equal(payload.imageExecution.path,undefined);
  assert(system.includes("A retrieved ASSISTANT statement establishes only what you said"));
   assert.equal(payload.imageCapabilities.edit,false); assert(system.includes("NO task is queued or running")); assert(system.includes("folder permission suggestion cannot automatically"));
  assert.equal(payload.quotedMessage.image.requestedDescription,"一只苹果"); assert.equal(payload.quotedMessage.image.path,undefined); assert.equal(payload.recentMessages[0].generatedImage.url,undefined);
  assert(!JSON.stringify(payload).includes("123456789")); assert(!JSON.stringify(payload).includes("private-platform-id")); assert(!JSON.stringify(payload).includes("secret.invalid"));
  assert(payload.currentMessage.includes("[表情包]")); assert(!payload.currentMessage.includes("不应该复述"));
  reset("收到"); await generateConversationReply({...base,currentMessage:"这个表情包图里写了什么？[表情包：可见文字]",allowStickerDescription:true}); assert(bodies[0]!.messages[1]!.content.includes("可见文字"));
  reset("收到"); await generateConversationReply({...base,imageReply:true,imageEnabled:true}); assert(bodies[0]!.messages[0]!.content.includes("Never turn current or historical conversation"));
  reset("收到"); await generateConversationReply({ ...base, currentMessage:"你刚画的图什么样？", generatedImageContext:facts });
  const directImage=JSON.parse(bodies[0]!.messages[1]!.content);
  assert.equal(directImage.generatedImageContext.requestedDescription,"一只苹果");
  assert.equal(directImage.generatedImageContext.visual.status,"not_requested");
  assert.equal(directImage.quotedMessage,undefined);
  assert.equal(directImage.generatedImageContext.path,undefined);
  assert(!JSON.stringify(directImage).includes("secret.invalid"));
  assert(bodies[0]!.messages[0]!.content.includes("appearance is not currently observed"));
  reset("收到"); await generateConversationReply({ ...base, generatedImageContext:{ ...facts, visual:{status:"ok",description:"桌面上有一个绿色苹果"} } });
  assert.equal(JSON.parse(bodies[0]!.messages[1]!.content).generatedImageContext.visual.description,"桌面上有一个绿色苹果");
  outputs = [JSON.stringify({ summary: "这轮在问刚才的图片。", evidenceMessageIds: ["q"], participation: "observing" })]; bodies = [];
  await analyzeGroupContext({ model:"mock", apiBaseUrl:base.apiBaseUrl!, apiKey:"mock", ...CONTEXT_ASSISTANT_DEFAULTS }, { ...base, groupChat:true,
    transcript:[{id:"q",content:"这张呢",quoted:{id:"quoted",content:"[图片]",image:facts}}],
    recentMessages:[{...base.recentMessages[0]!,id:"generated",generatedImage:facts}] });
  const contextPayload=JSON.parse(bodies[0]!.messages[1]!.content);
  assert.equal(contextPayload.transcript[0].quoted.image.requestedDescription,"一只苹果");
  assert.equal(contextPayload.recentMessages[0].generatedImage.visual.status,"not_requested");
  assert(!JSON.stringify(contextPayload).includes("secret.invalid"));
  console.log("v88 chat: bounded repetition repair, total usage, execution/capability facts, safe image evidence and sticker normalization passed (mocked).");
} finally { globalThis.fetch = old; }
