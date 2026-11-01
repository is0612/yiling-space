/**
 * 用已落库的群消息回填 `group_activities`。
 *
 * 这张表由适配器进程在收到群消息时写（`group-activity.ts`），所以有两种情况会空：
 *   - 功能上线之前就存在的群 —— 那些消息发生时还没有记录器；
 *   - 改了记录逻辑但适配器没重启 —— tsx 不热重载，旧进程根本不知道要写。
 *
 * 表空 = 「立即试一次」永远报「没有可用的群」：候选完全来自这张表。
 * 回填只补**缺的行**，不覆盖已有数据（记录器里的值比历史消息更新），要覆盖加 `--force`。
 *
 * 用法：
 *   yarn tsx scripts/backfill-group-activities.ts --dry
 *   yarn tsx scripts/backfill-group-activities.ts
 */

import "dotenv/config";
import { bindingAcceptsGroup, loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { MAX_LINES, MAX_LINE_CHARS } from "../server/utils/group-activity";
import { getPrisma } from "../server/utils/prisma";

const MAX_AGE_DAYS = 30;
const dryRun = process.argv.includes("--dry");
const force = process.argv.includes("--force");

type Line = { speaker: string; text: string; at: number };

function clip(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

function readSpeaker(role: string, metadata: unknown, characterName: string): string {
  if (role === "ASSISTANT") return characterName;
  const meta = metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : {};
  const name = meta.authorDisplayName ?? meta.member;
  return typeof name === "string" && name.trim() ? name.trim() : "群友";
}

async function main() {
  const prisma = getPrisma();
  const now = new Date();
  const minAt = new Date(now.getTime() - MAX_AGE_DAYS * 86_400_000);

  const connections = await loadOnebotConnections();
  const byBinding = new Map<string, { bindingId: string; characterId: string; routingKey: string | null; characterName: string }>();
  for (const connection of connections) {
    for (const binding of connection.bindings) {
      byBinding.set(binding.id, {
        bindingId: binding.id,
        characterId: binding.characterId,
        routingKey: binding.routingKey,
        characterName: binding.characterName,
      });
    }
  }
  if (!byBinding.size) {
    console.log("没有读到任何启用中的绑定，先检查 QQ 渠道配置。");
    return;
  }

  const conversations = await prisma.conversation.findMany({
    where: {
      channelBindingId: { in: [...byBinding.keys()] },
      externalConversationId: { startsWith: "g:" },
    },
    select: { id: true, channelBindingId: true, externalConversationId: true, title: true },
  });

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const conversation of conversations) {
    const binding = conversation.channelBindingId ? byBinding.get(conversation.channelBindingId) : undefined;
    const externalId = conversation.externalConversationId ?? "";
    const groupId = externalId.replace(/^g:/, "");
    if (!binding || !groupId) continue;

    // 群号已经从 routingKey 里删掉的，别再给它建行 —— 建了也不会被选中（loadCandidates 会挡），
    // 但会让这张表看起来像还在管这个群。
    if (!bindingAcceptsGroup(binding.routingKey, groupId)) {
      console.log(`跳过 g:${groupId} —— 不在绑定的 routingKey 里`);
      skipped += 1;
      continue;
    }

    const [latest, spoke, tail] = await Promise.all([
      prisma.message.findFirst({
        where: { conversationId: conversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { occurredAt: true },
      }),
      prisma.message.findFirst({
        where: { conversationId: conversation.id, role: "ASSISTANT" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { occurredAt: true },
      }),
      prisma.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: MAX_LINES,
        select: { role: true, content: true, occurredAt: true, metadata: true },
      }),
    ]);

    if (!latest) {
      console.log(`跳过 g:${groupId} —— 没有可用的历史消息`);
      skipped += 1;
      continue;
    }
    if (latest.occurredAt < minAt) {
      console.log(`跳过 g:${groupId} —— 最后一条消息超过 ${MAX_AGE_DAYS} 天`);
      skipped += 1;
      continue;
    }

    const recentLines: Line[] = tail
      .slice()
      .reverse()
      .map((message) => ({
        speaker: readSpeaker(message.role, message.metadata, binding.characterName),
        text: clip(message.content),
        at: message.occurredAt.getTime(),
      }));

    const existing = await prisma.groupActivity.findUnique({
      where: {
        channelBindingId_externalConversationId: {
          channelBindingId: binding.bindingId,
          externalConversationId: externalId,
        },
      },
      select: { id: true, lastMessageAt: true },
    });

    const label = `${conversation.title ?? "未命名"} (g:${groupId}) 最后消息 ${latest.occurredAt.toISOString()}`;

    if (existing && !force) {
      console.log(`已存在，跳过 ${label}`);
      skipped += 1;
      continue;
    }
    if (existing && existing.lastMessageAt > latest.occurredAt) {
      // --force 也不该把更新的数据往回倒退。
      console.log(`库里记录比历史消息更新，跳过 ${label}`);
      skipped += 1;
      continue;
    }

    if (dryRun) {
      console.log(`${existing ? "将更新" : "将创建"} ${label}，素材 ${recentLines.length} 条`);
      continue;
    }

    await prisma.groupActivity.upsert({
      where: {
        channelBindingId_externalConversationId: {
          channelBindingId: binding.bindingId,
          externalConversationId: externalId,
        },
      },
      create: {
        channelBindingId: binding.bindingId,
        characterId: binding.characterId,
        externalConversationId: externalId,
        groupId,
        lastMessageAt: latest.occurredAt,
        lastSpokeAt: spoke?.occurredAt ?? null,
        recentLines,
      },
      update: {
        lastMessageAt: latest.occurredAt,
        ...(spoke ? { lastSpokeAt: spoke.occurredAt } : {}),
        recentLines,
      },
    });
    if (existing) updated += 1;
    else created += 1;
    console.log(`${existing ? "已更新" : "已创建"} ${label}，素材 ${recentLines.length} 条`);
  }

  console.log(
    `${dryRun ? "[试运行] " : ""}完成：新建 ${created}，更新 ${updated}，跳过 ${skipped}。`,
  );
}

main()
  .catch((error) => {
    console.error("回填失败：", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await getPrisma().$disconnect().catch(() => {});
  });
