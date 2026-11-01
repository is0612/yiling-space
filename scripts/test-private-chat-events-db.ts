/**
 * 私聊忆泡（事件层）端到端回归：造数据 → 排「昨天收口」任务 → 真跑 worker → 查忆泡。
 *
 * 为什么要单独一个测试：按天任务的范围是「角色全局 + 角色主人的私人范围」，
 * 而桌面对话和群聊**共用同一个全局范围**。私聊要验证的三件事在别处都不覆盖：
 *
 * 1. **覆盖**：桌面对话（`channelBindingId = null`）与主人 QQ 私聊（`USER_PRIVATE`）
 *    都要被按天任务整理；群友私聊（`EXTERNAL_IDENTITY`）按设计不排。
 * 2. **参与者引用**：私聊忆泡只该有 `self` + 对方（桌面 = `owner`，主人 QQ = `owner`），
 *    不能出现群成员。模型偶尔会把跨会话的消息写成一条事件，这里用假模型故意造一条，
 *    验证写入侧按「最早证据所在会话」收口。
 * 3. **群聊规则不误伤**：模型造一条证据只来自桌面私聊的事件，它必须照常落库。
 *
 * 模型用本机假服务（不花钱、不依赖 .env 的 Key）。跑完把临时角色与数据删干净。
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { getPrisma } from "../server/utils/prisma";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { buildUserPrivateScopeKey } from "../server/utils/memory-scope-access";
import { resolveDailyEventWindow } from "../server/utils/memory-event-time";
import { processNextMemoryJob } from "../server/utils/memory-worker";

const prisma = getPrisma();
const NAME = "__私聊忆泡回归__";
const API_KEY = "ci-private-events-key";
let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    console.log("  ✅", name);
  } else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

/** 假模型：每个来源（origin）一条事件，另外故意加一条跨会话的坏事件。 */
function buildEvents(messages: Array<Record<string, unknown>>) {
  const byOrigin = new Map<string, { user: Array<Record<string, unknown>>; assistant: Array<Record<string, unknown>> }>();
  for (const message of messages) {
    if (!message || typeof message.id !== "string") continue;
    const origin = typeof message.origin === "string" ? message.origin : "未知来源";
    const bucket = byOrigin.get(origin) ?? { user: [], assistant: [] };
    if (message.role === "ASSISTANT") bucket.assistant.push(message);
    else bucket.user.push(message);
    byOrigin.set(origin, bucket);
  }
  const events = [];
  for (const [origin, bucket] of byOrigin) {
    const firstUser = bucket.user[0];
    if (!firstUser) continue;
    events.push({
      occurredAt: firstUser.occurredAt,
      title: "假模型事件：" + origin,
      detail: "证据只来自同一个会话。",
      keywords: ["回归", origin],
      participants: [origin],
      confidence: 0.9,
      evidenceMessageIds: [firstUser.id, ...(bucket.assistant[0] ? [bucket.assistant[0].id] : [])],
    });
  }
  // 跨会话证据：群里一个用户 + 桌面的一句回复。真实模型偶尔会这样合并两段对话。
  const groupUser = messages.find((message) => message?.role !== "ASSISTANT" && String(message?.origin ?? "").startsWith("QQ群"));
  const desktopAssistant = messages.find((message) => message?.role === "ASSISTANT" && message?.origin === "本地对话");
  if (groupUser && desktopAssistant) {
    events.push({
      occurredAt: groupUser.occurredAt,
      title: "跨会话拼出来的事",
      detail: "故意让证据跨两个会话，验证参与者引用与来源按最早证据所在会话收口。",
      keywords: ["回归", "跨会话"],
      participants: ["群友甲", "本地对话"],
      confidence: 0.9,
      evidenceMessageIds: [groupUser.id, desktopAssistant.id],
    });
  }
  return events;
}

const server = http.createServer(async (request, response) => {
  if (request.headers.authorization !== "Bearer " + API_KEY) {
    response.writeHead(401).end(JSON.stringify({ error: { message: "bad key" } }));
    return;
  }
  let body = "";
  for await (const chunk of request) body += chunk;
  const payload = JSON.parse(body);
  const userMessage = Array.isArray(payload.messages)
    ? payload.messages.find((message: { role?: string }) => message?.role === "user")
    : undefined;
  const input = JSON.parse(userMessage?.content ?? "{}");
  const analysis = {
    summary: "假模型已整理这一段对话。",
    importantEvents: [],
    factAndPreferenceChanges: [],
    relationshipChanges: [],
    goalsAndCommitments: [],
    unresolvedTopics: [],
    differencesFromPrevious: [],
    memoryChanges: [],
    events: buildEvents(Array.isArray(input.messages) ? input.messages : []),
  };
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ message: { role: "assistant", content: JSON.stringify(analysis) } }],
    usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
  }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

let characterId = "";

/** 删掉一个临时角色的全部数据（按外键顺序；别人留下的同名残留也走这里）。 */
async function purgeCharacter(id: string) {
  await prisma.memoryJob.deleteMany({ where: { memoryScope: { characterId: id } } }).catch(() => undefined);
  await prisma.memoryEvent.deleteMany({ where: { memoryScope: { characterId: id } } }).catch(() => undefined);
  await prisma.memoryEventDay.deleteMany({ where: { memoryScope: { characterId: id } } }).catch(() => undefined);
  await prisma.message.deleteMany({ where: { conversation: { characterId: id } } }).catch(() => undefined);
  await prisma.conversation.deleteMany({ where: { characterId: id } }).catch(() => undefined);
  await prisma.memoryScope.deleteMany({ where: { characterId: id } }).catch(() => undefined);
  await prisma.modelUsage.deleteMany({ where: { characterId: id } }).catch(() => undefined);
  await prisma.auditLog.deleteMany({ where: { characterId: id } }).catch(() => undefined);
  await prisma.character.delete({ where: { id } }).catch(() => undefined);
}

try {
  const owner = await prisma.user.findFirstOrThrow({ select: { id: true } });
  const existing = await prisma.character.findFirst({ where: { name: NAME }, select: { id: true } });
  if (existing) await purgeCharacter(existing.id);

  const character = await prisma.character.create({
    data: {
      ownerId: owner.id,
      name: NAME,
      basePrompt: "回归测试用角色。",
      modelConfig: {
        chatModel: "ci-private-events",
        chatApiBaseUrl: `http://127.0.0.1:${port}/v1`,
        chatApiKeyEncrypted: await encryptApiKey(API_KEY),
      },
      memorySetting: {
        create: {
          timezone: "Asia/Shanghai",
          autoSnapshotEnabled: true,
          anchorAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          nextSnapshotAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      },
    },
    select: { id: true },
  });
  characterId = character.id;

  const globalScope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
    select: { id: true },
  });
  const ownerScope = await prisma.memoryScope.create({
    data: {
      characterId,
      scopeType: "USER_PRIVATE",
      scopeKey: buildUserPrivateScopeKey(characterId, owner.id),
      userId: owner.id,
    },
    select: { id: true },
  });
  const strangerScope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "EXTERNAL_IDENTITY", scopeKey: `character:${characterId}:external:qq-onebot:90002` },
    select: { id: true },
  });

  const yesterday = resolveDailyEventWindow(new Date(), "Asia/Shanghai");
  const at = (hours: number, minutes = 0) =>
    new Date(yesterday.start.getTime() + hours * 3_600_000 + minutes * 60_000);

  async function seedConversation(input: {
    scopeId: string;
    externalConversationId: string | null;
    title: string;
    metadata: Record<string, unknown>;
    messages: Array<{ role: "USER" | "ASSISTANT"; content: string; occurredAt: Date; metadata?: Record<string, unknown> }>;
  }) {
    const conversation = await prisma.conversation.create({
      data: {
        characterId,
        memoryScopeId: input.scopeId,
        externalConversationId: input.externalConversationId,
        title: input.title,
        metadata: input.metadata,
      },
      select: { id: true },
    });
    for (const [index, message] of input.messages.entries()) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          externalMessageId: `private-events-${input.externalConversationId ?? "desktop"}-${index}`,
          role: message.role,
          content: message.content,
          occurredAt: message.occurredAt,
          metadata: message.metadata ?? {},
        },
      });
    }
    return conversation.id;
  }

  // 桌面私聊：没有渠道绑定、没有外部会话 id，挂全局范围。
  const desktopConversationId = await seedConversation({
    scopeId: globalScope.id,
    externalConversationId: null,
    title: "桌面对话",
    metadata: { createdFrom: "yiling-chat-ui" },
    messages: [
      { role: "USER", content: "今晚不想做饭", occurredAt: at(1), metadata: { source: "yiling-chat-ui" } },
      { role: "ASSISTANT", content: "那点个外卖吧", occurredAt: at(1, 1), metadata: { source: "yiling-chat-ui" } },
    ],
  });

  // 主人 QQ 私聊：挂主人专属私人范围。
  await seedConversation({
    scopeId: ownerScope.id,
    externalConversationId: "c:10001",
    title: "主人私聊",
    metadata: { platform: "qq-onebot", kind: "private" },
    messages: [
      { role: "USER", content: "明天要去看牙", occurredAt: at(2), metadata: { source: "channel", platform: "qq-onebot", authorOpenId: "10001", isOwner: true } },
      { role: "ASSISTANT", content: "我陪你去", occurredAt: at(2, 1), metadata: { source: "channel", platform: "qq-onebot" } },
    ],
  });

  // 群聊：和桌面对话同一个全局范围。
  const groupConversationId = await seedConversation({
    scopeId: globalScope.id,
    externalConversationId: "g:123456",
    title: "QQ群 123456",
    metadata: { platform: "qq-onebot", kind: "group", groupId: "123456" },
    messages: [
      { role: "USER", content: "@她 在吗", occurredAt: at(3), metadata: { source: "channel", platform: "qq-onebot", authorOpenId: "10002", mentionTargets: ["self"] } },
      { role: "ASSISTANT", content: "在呀", occurredAt: at(3, 1), metadata: { source: "channel", platform: "qq-onebot" } },
    ],
  });

  // 群友私聊：EXTERNAL_IDENTITY，按设计不排按天任务。
  await seedConversation({
    scopeId: strangerScope.id,
    externalConversationId: "c:90002",
    title: "群友私聊",
    metadata: { platform: "qq-onebot", kind: "private" },
    messages: [
      { role: "USER", content: "你好", occurredAt: at(4), metadata: { source: "channel", platform: "qq-onebot", authorOpenId: "90002" } },
      { role: "ASSISTANT", content: "你好呀", occurredAt: at(4, 1), metadata: { source: "channel", platform: "qq-onebot" } },
    ],
  });

  // 和调度器相同的幂等键；runAt 放到很早，保证别的新任务不会插队。
  // 三个范围都要排：群友私聊也是她这一天的记忆。
  for (const scopeId of [globalScope.id, ownerScope.id, strangerScope.id]) {
    await prisma.memoryJob.create({
      data: {
        memoryScopeId: scopeId,
        type: "EXTRACT_EVENTS",
        idempotencyKey: `events-final:${scopeId}:${yesterday.dayKey}`,
        periodStart: yesterday.start,
        periodEnd: yesterday.end,
        status: "QUEUED",
        runAt: new Date(0),
      },
    });
  }

  console.log("\n[1] 跑三段按天任务（全局 / 主人私聊 / 群友私聊）");
  const results = [];
  for (let index = 0; index < 3; index += 1) {
    results.push(await processNextMemoryJob(prisma, { ownerId: owner.id, workerId: "private-events-test" }));
  }
  check("三段都 SUCCEEDED", results.every((result) => result.processed && result.status === "SUCCEEDED"), results);

  const events = await prisma.memoryEvent.findMany({
    where: { memoryScope: { characterId } },
    orderBy: { occurredAt: "asc" },
    select: {
      id: true, title: true, state: true, participantRefs: true, sourceMessageIds: true, memoryScopeId: true,
      memoryScope: { select: { scopeType: true } },
    },
  });
  const refsOf = (event: (typeof events)[number] | undefined) =>
    (event?.participantRefs ?? []) as Array<Record<string, unknown>>;
  const hasRef = (event: (typeof events)[number] | undefined, kind: string) =>
    refsOf(event).some((ref) => ref.kind === kind);
  const eventInScope = (scopeId: string, title: string) =>
    events.find((event) => event.memoryScopeId === scopeId && event.title === title);

  console.log("\n[2] 覆盖：桌面 / 主人私聊 / 群友私聊都产出，群聊照常");
  const desktopEvent = eventInScope(globalScope.id, "假模型事件：本地对话");
  const groupEvent = eventInScope(globalScope.id, "假模型事件：QQ群 123456");
  const ownerEvent = eventInScope(ownerScope.id, "假模型事件：私聊");
  const strangerEvent = eventInScope(strangerScope.id, "假模型事件：私聊");
  check("桌面私聊产出忆泡", Boolean(desktopEvent), events.map((event) => event.title));
  check("主人 QQ 私聊产出忆泡", Boolean(ownerEvent), events.map((event) => event.title));
  check("群友私聊产出忆泡（私聊也算她这一天的记忆）", Boolean(strangerEvent), events.map((event) => event.title));
  check("群聊产出忆泡", Boolean(groupEvent), events.map((event) => event.title));
  check("忆泡全部是 FINAL", events.length > 0 && events.every((event) => event.state === "FINAL"), events.map((event) => event.state));

  console.log("\n[3] participantRefs：私聊只有 self + 对方");
  check("桌面私聊有 self", hasRef(desktopEvent, "self"), refsOf(desktopEvent));
  check("桌面私聊的对方推成 owner（没有渠道账号也得有对方）",
    hasRef(desktopEvent, "owner"), refsOf(desktopEvent));
  check("桌面私聊没有外部（群成员）引用",
    !refsOf(desktopEvent).some((ref) => ref.kind === "external"), refsOf(desktopEvent));
  check("主人私聊有 self + owner",
    hasRef(ownerEvent, "self") && hasRef(ownerEvent, "owner"), refsOf(ownerEvent));
  check("主人私聊没有群成员引用",
    !refsOf(ownerEvent).some((ref) => ref.kind === "external"), refsOf(ownerEvent));
  check("群友私聊有 self + 对方账号",
    hasRef(strangerEvent, "self") && hasRef(strangerEvent, "external"), refsOf(strangerEvent));
  check("群友私聊没有混进别人",
    refsOf(strangerEvent).filter((ref) => ref.kind === "external").length === 1, refsOf(strangerEvent));
  check("群聊忆泡照常带群成员引用",
    hasRef(groupEvent, "external"), refsOf(groupEvent));

  console.log("\n[4] 跨会话证据按「最早证据所在会话」收口");
  const mixedEvent = eventInScope(globalScope.id, "跨会话拼出来的事");
  check("跨会话事件仍然落库（不因守卫漏记）", Boolean(mixedEvent), events.map((event) => event.title));
  check("跨会话事件不混入群成员",
    Boolean(mixedEvent) && !(mixedEvent!.participantRefs as Array<Record<string, unknown>>).some((ref) => ref.kind === "external"),
    mixedEvent?.participantRefs);
  check("跨会话事件的来源只保留最早所在会话",
    Boolean(mixedEvent) && mixedEvent!.sourceMessageIds.length === 1,
    mixedEvent?.sourceMessageIds);
  const mixedSource = mixedEvent
    ? await prisma.message.findFirst({ where: { id: mixedEvent.sourceMessageIds[0]! }, select: { conversationId: true } })
    : null;
  check("跨会话事件的来源确实落在桌面会话",
    mixedSource?.conversationId === desktopConversationId, { mixedSource, desktopConversationId, groupConversationId });

  console.log("\n[5] 当天进度落 FINAL");
  const days = await prisma.memoryEventDay.findMany({
    where: { memoryScopeId: { in: [globalScope.id, ownerScope.id, strangerScope.id] } },
    select: { memoryScopeId: true, dayKey: true, state: true, eventCount: true },
  });
  check("三个范围各有一行当天进度", days.length === 3, days);
  check("进度都是 FINAL", days.every((day) => day.state === "FINAL"), days);
  check("全局段的条数与实际忆泡一致",
    days.find((day) => day.memoryScopeId === globalScope.id)?.eventCount ===
      events.filter((event) => event.memoryScope.scopeType === "CHARACTER_GLOBAL").length,
    days);
} catch (error) {
  failures += 1;
  console.log("  ❌ 运行异常", error instanceof Error ? error.message : String(error));
} finally {
  console.log("\n[6] 清理");
  if (characterId) {
    await purgeCharacter(characterId);
    check("临时角色与忆泡清理干净",
      (await prisma.character.count({ where: { id: characterId } })) === 0,
      characterId);
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}

console.log(failures === 0
  ? "\n私聊忆泡回归通过：桌面 / 主人 / 群友私聊覆盖、参与者引用、跨会话收口、FINAL 进度、清理。"
  : `\n私聊忆泡回归有 ${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
