import "dotenv/config";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { handleChannelMessage } from "../server/utils/channel-adapter/pipeline";
import { MODEL_FAILURE_FALLBACK_REPLY } from "../server/utils/chat-reply";

/**
 * 模型整轮失败时，私聊不能一个字都不回（2026-11-24 深夜两次「她没回复」）。
 *
 * 这条测的是真管道 + 真库 + 一个假模型服务：模型两次都返回空 content，走完
 * `LLM_INVALID_RESPONSE` → 重试 → 仍失败。断言的是**用户侧发生了什么**：
 * 收到了一句兜底话、数据库里那条 ASSISTANT 标成了服务端代发、而且是「回了一句」而不是「没回」。
 */
assert.match(new URL(process.env.DATABASE_URL ?? "").pathname, /^\/yiling_collaboration_test_[a-f0-9]{32}$/u,
  "Use the disposable collaboration database wrapper only.");
const db = getPrisma();
const requests: string[] = [];
const model = createServer(async (request, response) => {
  let body = ""; for await (const part of request) body += part;
  const payload = JSON.parse(body);
  requests.push(String(payload.messages.at(-1)?.content ?? ""));
  response.writeHead(200, { "content-type": "application/json" });
  // 模型「答应了」但什么都没写：这正是那两次事故的响应形状。
  response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "" } }],
    usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } }));
});
try {
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const owner = await db.user.create({ data: { username: `fallback-${randomUUID()}`, passwordHash: "fixture" } });
  const character = await db.character.create({ data: { ownerId: owner.id, name: "合成兜底角色", basePrompt: "测试",
    modelConfig: { chatModel: "fallback-fixture", chatApiKey: "fixture-key", chatApiBaseUrl: `http://127.0.0.1:${(model.address() as {port:number}).port}/v1`, contextAssistantEnabled: false, memoryAssistantEnabled: false },
    memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: randomUUID() } },
  } });
  const connection = await db.platformConnection.create({ data: { platform: "qq-onebot", platformAccountKey: randomUUID(), displayName: "合成连接", status: "DISABLED" } });
  const binding = await db.characterChannelBinding.create({ data: { characterId: character.id, connectionId: connection.id, status: "ACTIVE" } });

  const sent: Array<{ text: string; extra: unknown }> = [];
  const result = await handleChannelMessage({
    platform: "qq-onebot", characterId: character.id, bindingId: binding.id,
    eventType: "PRIVATE_MESSAGE", externalConversationId: `c:${randomUUID()}`,
    externalMessageId: `fallback-${randomUUID()}`, authorOpenId: "444", authorPlatformUid: "444",
    authorDisplayName: "合成联系人", speaker: { isOwner: false }, content: "你在吗",
    sendReply: async (text, options) => { sent.push({ text, extra: options ?? null }); return {}; },
  });

  assert.equal(result.status, "replied", `模型全空时私聊也要算「回过话」，实际 ${JSON.stringify(result)}`);
  assert.equal(requests.length, 2, "解析失败重试一次，仍然是两次空响应。");
  assert.equal(sent.length, 1, "只发一句，不要又发兜底又发别的。");
  assert.equal(sent[0]!.text, MODEL_FAILURE_FALLBACK_REPLY, "发出去的必须是那句兜底话。");
  const extra = sent[0]!.extra as { faces?: unknown; sticker?: unknown; image?: unknown; voice?: unknown; segments?: unknown } | null;
  assert.equal(extra?.faces, undefined, "兜底不配表情。");
  assert.equal(extra?.sticker, undefined, "兜底不配表情包。");
  assert.equal(extra?.image, undefined, "兜底不配图。");
  assert.equal(extra?.voice, undefined, "兜底不发语音条。");
  assert.equal(extra?.segments, undefined, "单句不拆条。");

  const stored = await db.message.findFirstOrThrow({
    where: { role: "ASSISTANT", conversation: { channelBindingId: binding.id } },
    select: { content: true, metadata: true },
  });
  assert.equal(stored.content, MODEL_FAILURE_FALLBACK_REPLY, "这条也要落库，下一轮她才知道自己说过这句。");
  const metadata = stored.metadata as { generatedBy?: unknown; modelFailure?: { reason?: unknown } };
  assert.equal(metadata.generatedBy, "model-failure-fallback", "正文不是模型写的，落库必须标出来。");
  assert.match(String(metadata.modelFailure?.reason ?? ""), /LLM_INVALID_RESPONSE/u, "失败原因要能对上模型那侧的错误。");

  const usage = await db.modelUsage.findMany({ where: { characterId: character.id, kind: "channel" }, select: { metadata: true } });
  assert.equal(usage.length, 1, "只能记一条失败用量，不能补记一条 success 把失败盖掉。");
  assert.equal((usage[0]!.metadata as { status?: unknown }).status, "failed");

  console.log("Model failure fallback (db) passed: empty model content still reaches the user as one honest line, with no faces, stickers, image or voice, and the stored reply is marked as a server-side fallback.");
} finally {
  if (model.listening) await new Promise<void>(resolve => model.close(() => resolve()));
  await db.$disconnect();
}
