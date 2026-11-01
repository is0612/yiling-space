/**
 * 回填忆泡的参与者引用（`participantRefs`）。
 *
 * 引用从「证据消息的作者」推导：ASSISTANT → self，isOwner → owner，
 * 其余带 authorOpenId 的 → external(platform, externalId)。老忆泡没有这个字段，
 * 用 sourceMessageIds（不足时退回 sourceMessageId）反查消息再推一遍。
 *
 * 用法：`yarn backfill:participants`（只看数量）
 *      `yarn backfill:participants --apply`（真写）
 *
 * 可以重复跑：已有 refs 的跳过；证据消息被清理过的跳过（宁缺勿编）。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { Prisma } from "../src/generated/prisma/client";
import { readMessageAuthor, readMessageIsOwner } from "../server/utils/conversation-message";
import { deriveParticipantRefs } from "../server/utils/memory-change-apply";
import type { ParticipantRef } from "../server/utils/memory-change-apply";

const apply = process.argv.includes("--apply");
const prisma = getPrisma();

const events = await prisma.memoryEvent.findMany({
  // JSON 列的「空」要用 DbNull 判断：`equals: null` 在这里匹配不到任何行。
  where: { participantRefs: { equals: Prisma.DbNull } },
  select: { id: true, sourceMessageId: true, sourceMessageIds: true },
});
console.log(`待回填忆泡：${events.length}`);

const messageIds = new Set<string>();
for (const event of events) {
  for (const id of event.sourceMessageIds) messageIds.add(id);
  if (event.sourceMessageId) messageIds.add(event.sourceMessageId);
}
const messages = await prisma.message.findMany({
  where: { id: { in: [...messageIds] } },
  select: { id: true, role: true, occurredAt: true, metadata: true },
});
const byId = new Map(messages.map((message) => [message.id, message]));

let filled = 0;
let skipped = 0;
for (const event of events) {
  const ids = event.sourceMessageIds.length
    ? event.sourceMessageIds
    : (event.sourceMessageId ? [event.sourceMessageId] : []);
  const evidence = ids
    .map((id) => byId.get(id))
    .filter((message): message is NonNullable<typeof message> => Boolean(message))
    .map((message) => ({
      id: message.id,
      occurredAt: message.occurredAt,
      role: message.role,
      isOwner: readMessageIsOwner(message.metadata),
      ...readMessageAuthor(message.metadata),
    }));
  if (!evidence.length) {
    skipped += 1;
    continue;
  }
  const refs: ParticipantRef[] = deriveParticipantRefs(evidence);
  if (!refs.length) {
    skipped += 1;
    continue;
  }
  filled += 1;
  if (apply) {
    await prisma.memoryEvent.update({
      where: { id: event.id },
      data: { participantRefs: refs as unknown as object },
    });
  }
}

console.log(apply ? "已写入。" : "（预演，未写入；加 --apply 才写）");
console.log({ filled, skipped });
