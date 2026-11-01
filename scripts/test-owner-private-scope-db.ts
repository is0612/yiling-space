/**
 * 主人 QQ 私聊「会话归位」回归：老会话原来挂在 EXTERNAL_IDENTITY，主人再开口时要迁到 USER_PRIVATE。
 *
 * 为什么必须单独测：会话按 `(binding, externalConversationId)` 唯一，找到就复用。
 * 「主人专属私人范围」是后加的功能，更早创建的会话还挂在这个 QQ 的外部身份范围上 ——
 * 只改创建分支的话，主人之后说的每一句仍旧落在外人范围里：不排忆泡、也进不了主人私人记忆，
 * 而且页面上完全看不出来（私聊照常回话）。
 *
 * 模型用本机假服务。跑完把临时角色、连接、身份、会话全部删掉。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getPrisma } from "../server/utils/prisma";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { ensureOwnerPrivateScope } from "../server/utils/memory-scope-access";
import { handleChannelMessage } from "../server/utils/channel-adapter/pipeline";

const prisma = getPrisma();
const NAME = "__主人私聊归位__";
const API_KEY = "ci-owner-private-key";
let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    console.log("  ✅", name);
  } else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer " + API_KEY) {
    response.writeHead(401).end(JSON.stringify({ error: { message: "bad key" } }));
    return;
  }
  for await (const _chunk of request) { /* 读掉请求体，避免连接挂住 */ }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: JSON.stringify({ reply: "自检回复", usedMemoryIds: [], usedSnapshotIds: [] }),
      },
    }],
    usage: { prompt_tokens: 60, completion_tokens: 20, total_tokens: 80 },
  }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

let characterId = "";
let connectionId = "";
let bindingId = "";
let conversationId = "";
let uid = "";

async function purge() {
  if (conversationId) {
    await prisma.message.deleteMany({ where: { conversationId } }).catch(() => undefined);
    await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => undefined);
  }
  if (bindingId) await prisma.characterChannelBinding.delete({ where: { id: bindingId } }).catch(() => undefined);
  if (connectionId) await prisma.platformConnection.delete({ where: { id: connectionId } }).catch(() => undefined);
  if (characterId) {
    await prisma.memoryScope.deleteMany({ where: { characterId } }).catch(() => undefined);
    await prisma.modelUsage.deleteMany({ where: { characterId } }).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { characterId } }).catch(() => undefined);
    await prisma.character.delete({ where: { id: characterId } }).catch(() => undefined);
  }
  if (uid) {
    await prisma.externalIdentity.deleteMany({ where: { platform: "qq-onebot", platformUid: uid } }).catch(() => undefined);
  }
}

try {
  const owner = await prisma.user.findFirstOrThrow({ select: { id: true } });
  const existing = await prisma.character.findFirst({ where: { name: NAME }, select: { id: true } });
  if (existing) {
    await prisma.conversation.deleteMany({ where: { characterId: existing.id } }).catch(() => undefined);
    await prisma.character.delete({ where: { id: existing.id } }).catch(() => undefined);
  }

  uid = "98" + Date.now().toString().slice(-8);
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name: NAME,
      basePrompt: "回归测试用角色。",
      modelConfig: {
        chatModel: "ci-owner-private",
        chatApiBaseUrl: `http://127.0.0.1:${port}/v1`,
        chatApiKeyEncrypted: await encryptApiKey(API_KEY),
      },
      memorySetting: { create: { timezone: "Asia/Shanghai" } },
    },
    select: { id: true },
  });
  characterId = character.id;
  await prisma.memoryScope.create({
    data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
  });
  const ownerScopeId = await ensureOwnerPrivateScope(characterId, owner.id);
  const externalScope = await prisma.memoryScope.create({
    data: {
      characterId,
      scopeType: "EXTERNAL_IDENTITY",
      scopeKey: `character:${characterId}:external:qq-onebot:${uid}`,
    },
    select: { id: true },
  });

  const connection = await prisma.platformConnection.create({
    data: { platform: "qq-onebot", displayName: "回归测试连接", status: "CONNECTED" },
    select: { id: true },
  });
  connectionId = connection.id;
  const binding = await prisma.characterChannelBinding.create({
    data: { characterId, connectionId, status: "ACTIVE", config: {} },
    select: { id: true },
  });
  bindingId = binding.id;
  const conversation = await prisma.conversation.create({
    data: {
      characterId,
      memoryScopeId: externalScope.id,
      channelBindingId: bindingId,
      externalConversationId: `c:${uid}`,
      title: "主人私聊（老会话）",
      metadata: { platform: "qq-onebot", kind: "private" },
    },
    select: { id: true },
  });
  conversationId = conversation.id;
  await prisma.message.create({
    data: {
      conversationId,
      externalMessageId: `owner-private-old-${uid}`,
      role: "USER",
      content: "以前说过的老消息",
      occurredAt: new Date(Date.now() - 3_600_000),
      metadata: { source: "channel", platform: "qq-onebot", authorOpenId: uid, isOwner: true },
    },
  });

  console.log("\n[1] 主人开口：老会话迁到 USER_PRIVATE");
  const replies: string[] = [];
  const result = await handleChannelMessage({
    platform: "qq-onebot",
    characterId,
    bindingId,
    eventType: "PRIVATE_MESSAGE",
    externalConversationId: `c:${uid}`,
    externalMessageId: `owner-private-new-${uid}`,
    authorOpenId: uid,
    authorPlatformUid: uid,
    content: "在吗",
    occurredAt: new Date(),
    speaker: { isOwner: true },
    sendReply: async (text) => { replies.push(text); },
  });
  const after = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { memoryScopeId: true },
  });
  check("正常回话", result.status === "replied" && replies.length === 1, { result, replies });
  check("会话迁到主人私人范围", after.memoryScopeId === ownerScopeId, { before: externalScope.id, ownerScopeId, after: after.memoryScopeId });
  const messageCount = await prisma.message.count({ where: { conversationId } });
  check("历史消息没有被丢（老 1 + 新 2）", messageCount === 3, messageCount);

  console.log("\n[2] 非主人发言：不往主人范围搬，也不搬回去");
  const second = await handleChannelMessage({
    platform: "qq-onebot",
    characterId,
    bindingId,
    eventType: "PRIVATE_MESSAGE",
    externalConversationId: `c:${uid}`,
    externalMessageId: `owner-private-second-${uid}`,
    authorOpenId: uid,
    authorPlatformUid: uid,
    content: "我再说一句",
    occurredAt: new Date(),
    speaker: { isOwner: false },
    sendReply: async () => undefined,
  });
  const afterSecond = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { memoryScopeId: true },
  });
  check("这一轮照常处理", second.status === "replied", second);
  check("会话仍留在主人范围（不因这一句不是主人就搬走）",
    afterSecond.memoryScopeId === ownerScopeId, afterSecond.memoryScopeId);

  console.log("\n[3] 模型不可用时，私聊也要先落库");
  // 清掉模型配置：下面的调用会在模型检查处 early return，但消息必须先写进会话。
  await prisma.character.update({ where: { id: characterId }, data: { modelConfig: {} } });
  const beforeOffline = await prisma.message.count({ where: { conversationId } });
  const offline = await handleChannelMessage({
    platform: "qq-onebot",
    characterId,
    bindingId,
    eventType: "PRIVATE_MESSAGE",
    externalConversationId: `c:${uid}`,
    externalMessageId: `owner-private-offline-${uid}`,
    authorOpenId: uid,
    authorPlatformUid: uid,
    content: "模型没配的时候，这句话也要留下",
    occurredAt: new Date(),
    speaker: { isOwner: true },
    sendReply: async () => undefined,
  });
  check("模型没配时这一轮不回（早退）", offline.status === "ignored", offline);
  const offlineStored = await prisma.message.findFirst({
    where: { conversationId, externalMessageId: `owner-private-offline-${uid}` },
    select: { content: true, metadata: true },
  });
  check("模型没配时私聊消息已经落库", Boolean(offlineStored), { beforeOffline, offlineStored });
  check("预落库的消息标成 recorded", (offlineStored?.metadata as Record<string, unknown> | null)?.storedReason === "recorded", offlineStored?.metadata);
  check("落库没有影响历史消息", (await prisma.message.count({ where: { conversationId } })) === beforeOffline + 1, {
    beforeOffline,
    after: await prisma.message.count({ where: { conversationId } }),
  });
} catch (error) {
  failures += 1;
  console.log("  ❌ 运行异常", error instanceof Error ? error.message : String(error));
} finally {
  console.log("\n[4] 清理");
  await purge();
  check("临时角色清理干净", characterId
    ? (await prisma.character.count({ where: { id: characterId } })) === 0
    : true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

console.log(failures === 0
  ? "\n主人私聊会话归位回归通过：迁移、历史保留、非主人不搬。"
  : `\n主人私聊会话归位回归有 ${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
