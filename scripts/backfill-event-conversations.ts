/**
 * 回填忆泡的所属会话（`memory_events.conversationId`）。
 *
 * 迁移 `20261104170000_memory_event_conversation` 已经按「第一条证据消息」回填过一批；
 * 但导入的历史忆泡（2026-10-30 ~ 11-01）没有 `sourceMessageIds`，迁移补不了。
 * 这些忆泡仍然要能在「这个群」里查到，否则一问「前天群里发生了什么」就全丢。
 *
 * 回填顺序（严格，拿不准就留空）：
 * 1. 有证据消息 → 用第一条证据所在的会话（和写入侧同一口径）；
 * 2. 没有证据 → 用 participants 里的显示名去 `group_members` 找；**只有唯一一个会话**
 *    匹配上才写，多个群都有同名的人就跳过 —— 宁可这条忆泡在群里查不到，
 *    也不要把它挂到错误的群上。
 *
 * 用法：
 *   tsx scripts/backfill-event-conversations.ts           # 只看会改多少条
 *   tsx scripts/backfill-event-conversations.ts --apply   # 真正写库
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";

const prisma = getPrisma();
const apply = process.argv.includes("--apply");
const characterArg = process.argv.find((arg) => arg.startsWith("--character="))?.slice("--character=".length);

const characters = characterArg
  ? await prisma.character.findMany({ where: { id: characterArg }, select: { id: true, name: true } })
  : await prisma.character.findMany({ select: { id: true, name: true } });

for (const character of characters) {
  const events = await prisma.memoryEvent.findMany({
    where: { memoryScope: { characterId: character.id }, conversationId: null },
    select: { id: true, title: true, participants: true, sourceMessageIds: true },
  });
  if (events.length === 0) {
    console.log(`\n[${character.name}] 没有待回填的忆泡。`);
    continue;
  }

  const members = await prisma.groupMember.findMany({
    where: { characterId: character.id },
    select: { conversationId: true, displayName: true },
  });
  const byName = new Map<string, Set<string>>();
  for (const member of members) {
    const name = member.displayName?.trim();
    if (!name) continue;
    const set = byName.get(name) ?? new Set<string>();
    set.add(member.conversationId);
    byName.set(name, set);
  }

  let fromEvidence = 0;
  let fromParticipants = 0;
  let unresolved = 0;
  for (const event of events) {
    let conversationId: string | null = null;
    const firstSourceId = event.sourceMessageIds[0];
    if (firstSourceId) {
      const message = await prisma.message.findUnique({
        where: { id: firstSourceId },
        select: { conversationId: true },
      });
      conversationId = message?.conversationId ?? null;
      if (conversationId) fromEvidence += 1;
    }
    if (!conversationId) {
      const candidates = new Set<string>();
      for (const person of event.participants) {
        for (const id of byName.get(person.trim()) ?? []) candidates.add(id);
      }
      if (candidates.size === 1) {
        conversationId = [...candidates][0]!;
        fromParticipants += 1;
      }
    }
    if (!conversationId) {
      unresolved += 1;
      continue;
    }
    if (apply) {
      await prisma.memoryEvent.update({ where: { id: event.id }, data: { conversationId } });
    }
  }

  console.log(
    `\n[${character.name}] 待回填 ${events.length} 条：证据 ${fromEvidence}，参与人唯一命中 ${fromParticipants}，认不出 ${unresolved}`,
  );
  console.log(apply ? "已写入。" : "未写入（加 --apply 才会真正改库）。");
}

await prisma.$disconnect();
