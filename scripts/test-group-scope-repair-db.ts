/**
 * 群会话「归位到角色全局范围」回归：老群会话挂在 EXTERNAL_IDENTITY 上，下一轮群消息进来时
 * 要迁到 CHARACTER_GLOBAL，并把它自己的忆泡一起带走。
 *
 * 为什么必须单独测：群聊的检索范围是 `[global]`，按天忆泡也只排「全局 + 主人私人 + 有私聊
 * 会话的外部身份范围」。挂在外部身份范围下的群会话因此有两个症状，且都不会报错 ——
 * 群消息写进去了、记录页也看得见，只是永远不进忆泡、她在群里也查不到自己说过的话。
 * 会话按 `(binding, externalConversationId)` 唯一、找到就复用，只改创建分支修不到老会话。
 *
 * 模型用本机假服务。跑完把临时角色、连接、会话、忆泡全部删掉。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getPrisma } from "../server/utils/prisma";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { handleChannelMessage } from "../server/utils/channel-adapter/pipeline";

const prisma = getPrisma();
const NAME = "__群会话归位__";
const API_KEY = "ci-group-scope-key";
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
let eventId = "";
let uid = "";

async function purge() {
  if (eventId) await prisma.memoryEvent.delete({ where: { id: eventId } }).catch(() => undefined);
  if (conversationId) {
    await prisma.memoryEvent.deleteMany({ where: { conversationId } }).catch(() => undefined);
    await prisma.message.deleteMany({ where: { conversationId } }).catch(() => undefined);
    await prisma.groupMember.deleteMany({ where: { conversationId } }).catch(() => undefined);
    await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => undefined);
  }
  if (bindingId) await prisma.characterChannelBinding.delete({ where: { id: bindingId } }).catch(() => undefined);
  if (connectionId) await prisma.platformConnection.delete({ where: { id: connectionId } }).catch(() => undefined);
  if (characterId) {
    const scopeIds = (await prisma.memoryScope.findMany({ where: { characterId }, select: { id: true } }))
      .map((scope) => scope.id);
    if (scopeIds.length) {
      await prisma.memoryEventDay.deleteMany({ where: { memoryScopeId: { in: scopeIds } } }).catch(() => undefined);
      await prisma.memoryJob.deleteMany({ where: { memoryScopeId: { in: scopeIds } } }).catch(() => undefined);
      await prisma.memoryItem.deleteMany({ where: { memoryScopeId: { in: scopeIds } } }).catch(() => undefined);
    }
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

  uid = "97" + Date.now().toString().slice(-8);
  const groupId = "5" + Date.now().toString().slice(-8);
  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name: NAME,
      basePrompt: "回归测试用角色。",
      modelConfig: {
        chatModel: "ci-group-scope",
        chatApiBaseUrl: `http://127.0.0.1:${port}/v1`,
        chatApiKeyEncrypted: await encryptApiKey(API_KEY),
      },
      memorySetting: { create: { timezone: "Asia/Shanghai" } },
    },
    select: { id: true },
  });
  characterId = character.id;
  const globalScope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
    select: { id: true },
  });
  // 模拟历史数据：建这个群的时候，「群聊挂全局」这条规则还没定下来。
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

  const conversationKey = `g:${groupId}`;
  const conversation = await prisma.conversation.create({
    data: {
      characterId,
      memoryScopeId: externalScope.id,
      channelBindingId: bindingId,
      externalConversationId: conversationKey,
      title: `QQ群 ${groupId}`,
      metadata: { platform: "qq-onebot", kind: "group", groupId },
    },
    select: { id: true },
  });
  conversationId = conversation.id;

  const oldMessage = await prisma.message.create({
    data: {
      conversationId,
      externalMessageId: `group-scope-old-${uid}`,
      role: "USER",
      content: "以前在群里说过的话",
      occurredAt: new Date(Date.now() - 3_600_000),
      metadata: { source: "channel", platform: "qq-onebot", authorOpenId: uid },
    },
    select: { id: true },
  });
  // 旧范围里已经整理出的一条忆泡：归位时必须跟着会话走，否则新范围读不到。
  const oldEvent = await prisma.memoryEvent.create({
    data: {
      memoryScopeId: externalScope.id,
      conversationId,
      dayKey: "2026-10-31",
      occurredAt: new Date(Date.now() - 3_600_000),
      title: "群里聊过的一件旧事",
      detail: "旧范围里整理出来的忆泡。",
      dedupeKey: `group-scope-old-${uid}`,
      sourceMessageId: oldMessage.id,
      sourceMessageIds: [oldMessage.id],
    },
    select: { id: true },
  });
  eventId = oldEvent.id;

  console.log("\n[1] 群消息进来：老群会话迁到全局范围");
  const result = await handleChannelMessage({
    platform: "qq-onebot",
    characterId,
    bindingId,
    eventType: "GROUP_MESSAGE",
    externalConversationId: conversationKey,
    externalMessageId: `group-scope-new-${uid}`,
    authorOpenId: uid,
    authorPlatformUid: uid,
    authorDisplayName: "群友",
    content: "今天群里聊点什么",
    occurredAt: new Date(),
    sendReply: async () => undefined,
  });
  const after = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { memoryScopeId: true },
  });
  check("这一轮照常处理", result.status !== "ignored" || result.reason === "silent", result);
  check("会话迁到角色全局范围", after.memoryScopeId === globalScope.id,
    { before: externalScope.id, global: globalScope.id, after: after.memoryScopeId });

  const eventAfter = await prisma.memoryEvent.findUniqueOrThrow({
    where: { id: oldEvent.id },
    select: { memoryScopeId: true, title: true },
  });
  check("旧忆泡跟着会话搬进全局范围", eventAfter.memoryScopeId === globalScope.id, eventAfter);
  check("搬忆泡不是删了重建（内容还在）", eventAfter.title === "群里聊过的一件旧事", eventAfter);

  const stored = await prisma.message.findFirst({
    where: { conversationId, externalMessageId: `group-scope-new-${uid}` },
    select: { id: true },
  });
  check("新消息落进同一个会话", Boolean(stored));
  check("历史消息没有被丢",
    Boolean(await prisma.message.findUnique({ where: { id: oldMessage.id }, select: { id: true } })));

  console.log("\n[2] 再进来一条：已经在全局范围就不重复搬");
  const second = await handleChannelMessage({
    platform: "qq-onebot",
    characterId,
    bindingId,
    eventType: "GROUP_MESSAGE",
    externalConversationId: conversationKey,
    externalMessageId: `group-scope-second-${uid}`,
    authorOpenId: uid,
    authorPlatformUid: uid,
    authorDisplayName: "群友",
    content: "再说一句",
    occurredAt: new Date(),
    sendReply: async () => undefined,
  });
  const afterSecond = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { memoryScopeId: true },
  });
  check("第二轮照常处理", second.status !== "ignored" || second.reason === "silent", second);
  check("范围保持不变", afterSecond.memoryScopeId === globalScope.id, afterSecond.memoryScopeId);
  check("忆泡没有被搬出全局",
    (await prisma.memoryEvent.findUniqueOrThrow({ where: { id: oldEvent.id }, select: { memoryScopeId: true } }))
      .memoryScopeId === globalScope.id);
} catch (error) {
  failures += 1;
  console.log("  ❌ 运行异常", error instanceof Error ? error.message : String(error));
} finally {
  console.log("\n[3] 清理");
  await purge();
  check("临时角色清理干净", characterId
    ? (await prisma.character.count({ where: { id: characterId } })) === 0
    : true);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

console.log(failures === 0
  ? "\n群会话归位回归通过：迁到全局、忆泡跟随、不重复搬。"
  : `\n群会话归位回归有 ${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
