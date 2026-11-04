/**
 * 会话归位时忆泡跟着走（`moveConversationEventsToScope`）的数据库回归。
 *
 * 背景：主人的老私聊会话可能还挂在 EXTERNAL_IDENTITY，归位只改会话的 `memoryScopeId`。
 * 已经写进旧范围的忆泡如果不跟着走：主人私聊读不到；归位后 USER_PRIVATE 的按天任务
 * 会重新提一遍同一天。搬家还必须只搬这条会话自己的事件（同范围里可能还有群聊），
 * 并重算两边的当天条数、把整理水位带过去。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { moveConversationEventsToScope } from "../server/utils/memory-event-move";

const prisma = getPrisma();
const NAME = "__忆泡归位搬家__";
let failures = 0;
function check(name: string, condition: boolean, extra?: unknown) {
  if (condition) {
    console.log("  ✅", name);
  } else {
    failures += 1;
    console.log("  ❌", name, extra === undefined ? "" : JSON.stringify(extra));
  }
}

let characterId = "";
let fromScopeId = "";
let toScopeId = "";
try {
  const owner = await prisma.user.findFirstOrThrow({ select: { id: true } });
  const existing = await prisma.character.findFirst({ where: { name: NAME }, select: { id: true } });
  if (existing) {
    await prisma.memoryEvent.deleteMany({ where: { memoryScope: { characterId: existing.id } } });
    await prisma.memoryEventDay.deleteMany({ where: { memoryScope: { characterId: existing.id } } });
    await prisma.message.deleteMany({ where: { conversation: { characterId: existing.id } } });
    await prisma.conversation.deleteMany({ where: { characterId: existing.id } });
    await prisma.memoryScope.deleteMany({ where: { characterId: existing.id } });
    await prisma.character.delete({ where: { id: existing.id } });
  }
  const character = await prisma.character.create({
    data: { ownerId: owner.id, name: NAME, basePrompt: "自检" },
    select: { id: true },
  });
  characterId = character.id;
  const fromScope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "EXTERNAL_IDENTITY", scopeKey: `move-test:${characterId}:from` },
    select: { id: true },
  });
  const toScope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "USER_PRIVATE", scopeKey: `move-test:${characterId}:to`, userId: owner.id },
    select: { id: true },
  });
  fromScopeId = fromScope.id;
  toScopeId = toScope.id;

  const privateConversation = await prisma.conversation.create({
    data: { characterId, memoryScopeId: fromScopeId, externalConversationId: "c:10001", title: "主人私聊" },
    select: { id: true },
  });
  const groupConversation = await prisma.conversation.create({
    data: { characterId, memoryScopeId: fromScopeId, externalConversationId: "g:123456", title: "同范围历史群聊" },
    select: { id: true },
  });
  const privateMessage = await prisma.message.create({
    data: { conversationId: privateConversation.id, role: "USER", content: "私聊里的话", occurredAt: new Date("2026-10-31T10:00:00Z") },
    select: { id: true },
  });
  const privateMessage2 = await prisma.message.create({
    data: { conversationId: privateConversation.id, role: "USER", content: "私聊里的第二句", occurredAt: new Date("2026-10-31T11:00:00Z") },
    select: { id: true },
  });
  const groupMessage = await prisma.message.create({
    data: { conversationId: groupConversation.id, role: "USER", content: "群里的话", occurredAt: new Date("2026-10-31T12:00:00Z") },
    select: { id: true },
  });

  const baseEvent = {
    memoryScopeId: fromScopeId,
    dayKey: "2026-10-31",
    occurredAt: new Date("2026-10-31T10:00:00Z"),
    title: "私聊事件",
    detail: "只属于这段私聊",
    dedupeKey: "ev:move-1",
  };
  const movingEvent = await prisma.memoryEvent.create({
    data: { ...baseEvent, sourceMessageId: privateMessage.id, sourceMessageIds: [privateMessage.id] },
    select: { id: true },
  });
  await prisma.memoryEvent.create({
    data: {
      ...baseEvent,
      title: "群里的事件",
      dedupeKey: "ev:stay-1",
      sourceMessageId: groupMessage.id,
      sourceMessageIds: [groupMessage.id],
    },
  });
  const day = await prisma.memoryEventDay.create({
    data: { memoryScopeId: fromScopeId, dayKey: "2026-10-31", state: "FINAL", eventCount: 2, extractedAt: new Date("2026-11-01T00:00:00Z") },
    select: { id: true },
  });

  console.log("\n[1] 搬家：只搬这条会话，群事件留在原范围");
  const first = await prisma.$transaction((tx) => moveConversationEventsToScope(tx, {
    conversationId: privateConversation.id,
    fromScopeId,
    toScopeId,
  }));
  check("搬走 1 条", first.moved === 1, first);
  const moved = await prisma.memoryEvent.findUniqueOrThrow({ where: { id: movingEvent.id }, select: { memoryScopeId: true } });
  check("私聊事件到了新范围", moved.memoryScopeId === toScopeId, moved);
  const stayed = await prisma.memoryEvent.findFirstOrThrow({ where: { dedupeKey: "ev:stay-1" }, select: { memoryScopeId: true } });
  check("同范围的群事件没有跟着走", stayed.memoryScopeId === fromScopeId, stayed);
  const oldDay = await prisma.memoryEventDay.findUniqueOrThrow({ where: { id: day.id }, select: { eventCount: true } });
  check("旧范围当天条数重算为 1", oldDay.eventCount === 1, oldDay);
  const newDay = await prisma.memoryEventDay.findFirstOrThrow({ where: { memoryScopeId: toScopeId, dayKey: "2026-10-31" }, select: { eventCount: true, state: true, extractedAt: true } });
  check("新范围当天条数为 1", newDay.eventCount === 1, newDay);
  check("新范围没有历史进度时保守重读，不能继承其他范围的水位", newDay.state === "DRAFT" && newDay.extractedAt === null, newDay);

  console.log("\n[2] 目标范围已有同一件事：旧条目按重复删掉");
  const duplicateSource = await prisma.memoryEvent.create({
    data: { ...baseEvent, title: "会撞车的私聊事件", dedupeKey: "ev:dup", sourceMessageId: privateMessage2.id, sourceMessageIds: [privateMessage2.id] },
    select: { id: true },
  });
  const targetDuplicate = await prisma.memoryEvent.create({
    data: { memoryScopeId: toScopeId, dayKey: "2026-10-31", occurredAt: new Date("2026-10-31T10:00:00Z"), title: "会撞车的私聊事件", detail: "目标范围已有", dedupeKey: "ev:dup" },
    select: { id: true },
  });
  const second = await prisma.$transaction((tx) => moveConversationEventsToScope(tx, {
    conversationId: privateConversation.id,
    fromScopeId,
    toScopeId,
  }));
  check("识别为合并 1 条", second.merged === 1, second);
  check("旧范围的重复条目被删", (await prisma.memoryEvent.count({ where: { id: duplicateSource.id } })) === 0);
  check("目标范围保留原条目", (await prisma.memoryEvent.count({ where: { id: targetDuplicate.id } })) === 1);
  const finalOldCount = await prisma.memoryEvent.count({ where: { memoryScopeId: fromScopeId, dayKey: "2026-10-31" } });
  const finalNewCount = await prisma.memoryEvent.count({ where: { memoryScopeId: toScopeId, dayKey: "2026-10-31" } });
  const finalOldDay = await prisma.memoryEventDay.findUniqueOrThrow({ where: { id: day.id }, select: { eventCount: true } });
  const finalNewDay = await prisma.memoryEventDay.findFirstOrThrow({ where: { memoryScopeId: toScopeId, dayKey: "2026-10-31" }, select: { eventCount: true } });
  check("重算后两边条数都等于真实事件数", finalOldDay.eventCount === finalOldCount && finalNewDay.eventCount === finalNewCount, { finalOldCount, finalNewCount, finalOldDay, finalNewDay });
} catch (error) {
  failures += 1;
  console.log("  ❌ 运行异常", error instanceof Error ? error.message : String(error));
} finally {
  console.log("\n[3] 清理");
  if (characterId) {
    await prisma.memoryEvent.deleteMany({ where: { memoryScope: { characterId } } });
    await prisma.memoryEventDay.deleteMany({ where: { memoryScope: { characterId } } });
    await prisma.message.deleteMany({ where: { conversation: { characterId } } });
    await prisma.conversation.deleteMany({ where: { characterId } });
    await prisma.memoryScope.deleteMany({ where: { characterId } });
    await prisma.character.delete({ where: { id: characterId } });
    check("临时角色清理干净", (await prisma.character.count({ where: { id: characterId } })) === 0);
  }
  await prisma.$disconnect();
}

console.log(failures === 0
  ? "\n忆泡归位搬家回归通过：只搬本会话、重算当天条数、继承水位、重复合并。"
  : `\n忆泡归位搬家回归有 ${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
