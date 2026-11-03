/**
 * 回填忆泡的参与者：结构化引用（`participantRefs`）+ 显示名（`participants` 里的泛称）。
 *
 * 两件事都从「证据消息的作者」推导，不经过模型：
 *   - 引用：ASSISTANT → self，isOwner → owner，其余带 authorOpenId 的 → external；
 *   - 名字：把「群友」「对方」这类泛称换成证据里真实发言人的昵称，并剔掉她自己 ——
 *     泛称留着比空着更糟：看起来像有信息，实际谁也对不上。
 *
 * 用法：`yarn backfill:participants`（预演，打印将变成什么）
 *      `yarn backfill:participants --apply`（真写）
 *
 * 可以重复跑：引用已补、名字里没有泛称的会跳过；证据消息被清理过的跳过（宁缺勿编）。
 *
 * 救不回来的部分：`sourceMessageIds` 为空的忆泡没有任何反查入口，只能跳过。
 * 那是早期版本没存来源列表留下的账，只能靠她在对话里重新提起。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { readMessageAuthor, readMessageIsOwner, readMessageSpeaker } from "../server/utils/conversation-message";
import { deriveParticipantRefs, resolveEventParticipants } from "../server/utils/memory-change-apply";
import type { ParticipantRef } from "../server/utils/memory-change-apply";

const apply = process.argv.includes("--apply");
const prisma = getPrisma();

/**
 * 全量扫，不按条件预筛。
 *
 * 需要修的三种情况跨表、无法用一条 where 表达：引用为空、「群友」这种泛称、
 * 以及**把她自己列进了相关人物**（角色名在 characters 表里，Postgres 的数组
 * 条件够不着）。目前忆泡总量几十到几百条，全量扫最省心；等真的上万条再按
 * dayKey 分批。
 */
const events = await prisma.memoryEvent.findMany({
  orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
  select: {
    id: true,
    title: true,
    participants: true,
    participantRefs: true,
    sourceMessageId: true,
    sourceMessageIds: true,
    memoryScope: { select: { character: { select: { name: true } } } },
  },
});
console.log(`扫到忆泡：${events.length}`);

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
let renamed = 0;
let skipped = 0;
const preview: Array<{ title: string; before: string[]; after: string[] }> = [];

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
      // 显示名：泛称要靠它换成具体的人。
      ...readMessageSpeaker(message.metadata),
    }));

  // 证据消息已经被清理：补引用、补名字都做不了（宁缺勿编），
  // 但「她自己不算相关人物」这一步不需要证据，下面照常执行。
  const data: { participantRefs?: ParticipantRef[]; participants?: string[] } = {};

  // 引用只补不改：已有引用带着当时的 displayName，重推会把它覆盖成现在的昵称。
  if (event.participantRefs === null && evidence.length) {
    const refs = deriveParticipantRefs(evidence);
    if (refs.length) data.participantRefs = refs;
  }

  const participants = resolveEventParticipants(
    event.participants,
    evidence,
    event.memoryScope.character.name,
  );
  if (participants.join("\u0000") !== event.participants.join("\u0000")) {
    data.participants = participants;
  }

  if (!Object.keys(data).length) {
    skipped += 1;
    continue;
  }

  if (data.participantRefs) filled += 1;
  if (data.participants) {
    renamed += 1;
    if (preview.length < 10) {
      preview.push({ title: event.title, before: event.participants, after: participants });
    }
  }

  if (apply) {
    await prisma.memoryEvent.update({
      where: { id: event.id },
      data: {
        ...(data.participantRefs ? { participantRefs: data.participantRefs as unknown as object } : {}),
        ...(data.participants ? { participants: data.participants } : {}),
      },
    });
  }
}

if (preview.length) {
  console.log("\n参与者名字变化（最多 10 条）：");
  for (const row of preview) {
    console.log(`  ${row.title}`);
    console.log(`    ${row.before.join("、") || "（空）"} → ${row.after.join("、") || "（空）"}`);
  }
}

console.log(apply ? "\n已写入。" : "\n（预演，未写入；加 --apply 才写）");
console.log({ 补引用: filled, 改名字: renamed, 跳过: skipped });
process.exit(0);
