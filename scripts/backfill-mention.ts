/**
 * 回填历史群消息的 `metadata.mentionTargets`。
 *
 * 新消息已经由适配器写入这个字段；19:45 之前落库的老消息没有，导致那几天的忆泡
 * 提炼看不出「这句话 @ 的是别人」。原始 `content` 保留了 `@数字`，规则确定：
 * 号码等于她自己的 QQ → self，否则 other，@all → all。
 *
 * 用法：`yarn backfill:mention`（只看数量，不写库）
 *      `yarn backfill:mention --apply`（真写）
 *
 * 可以重复跑：已有 `mentionTargets` 的消息会跳过，不覆盖适配器写入的值。
 */
import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";

const apply = process.argv.includes("--apply");
const prisma = getPrisma();

function readMeta(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
}

const connections = await prisma.platformConnection.findMany({
  where: { platform: "qq-onebot" },
  select: { id: true, platformAccountKey: true, metadata: true },
});

const bindings = await prisma.characterChannelBinding.findMany({
  select: { id: true, connectionId: true },
});

let scanned = 0;
let filled = 0;
let skipped = 0;
const perGroup = new Map<string, number>();

for (const connection of connections) {
  const meta = readMeta(connection.metadata);
  const selfQq = String(
    (typeof meta.qqNumber === "string" && meta.qqNumber.trim()) || connection.platformAccountKey || "",
  ).trim();
  if (!selfQq) {
    console.log(`连接 ${connection.id} 没有自己的 QQ 号，跳过。`);
    continue;
  }
  const bindingIds = bindings.filter((b) => b.connectionId === connection.id).map((b) => b.id);
  if (!bindingIds.length) continue;

  const conversations = await prisma.conversation.findMany({
    where: { channelBindingId: { in: bindingIds } },
    select: { id: true, externalConversationId: true },
  });

  for (const conversation of conversations) {
    if (!conversation.externalConversationId?.startsWith("g:")) continue;
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id, role: "USER", content: { contains: "@" } },
      select: { id: true, content: true, metadata: true },
    });
    for (const row of rows) {
      scanned += 1;
      const existing = readMeta(row.metadata);
      if (Array.isArray(existing.mentionTargets) && existing.mentionTargets.length) {
        skipped += 1;
        continue;
      }
      const targets = new Set<string>();
      for (const match of row.content.matchAll(/@(\d+)/g)) {
        const qq = match[1]!;
        targets.add(qq === selfQq ? "self" : "other");
      }
      if (row.content.includes("@全体成员") || row.content.includes("[CQ:at,qq=all]")) targets.add("all");
      if (!targets.size) {
        skipped += 1;
        continue;
      }
      filled += 1;
      perGroup.set(conversation.externalConversationId, (perGroup.get(conversation.externalConversationId) ?? 0) + 1);
      if (apply) {
        await prisma.message.update({
          where: { id: row.id },
          data: { metadata: { ...existing, mentionTargets: [...targets] } },
        });
      }
    }
  }
}

console.log(apply ? "已写入。" : "（预演，未写入；加 --apply 才写）");
console.log({ scanned, filled, skipped });
console.log("按群：", Object.fromEntries(perGroup));
