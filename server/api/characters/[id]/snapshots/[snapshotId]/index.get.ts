import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import {
  buildSnapshotSequence,
  toMemorySnapshotDetail,
} from "../../../../../utils/memory-snapshot-dto";

/**
 * 一份阶段总结的详情：摘要 + AI 提炼结果 + 依据序号。
 *
 * 列表接口不带 analysis（一页十份的提炼结果能到兆级），点开某一版才取这里。
 * 来源消息原文也不在这里：那是 `.../sources` 的分页接口，展开「来源消息与原文」才请求。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const snapshotId = requireUuid(getRouterParam(event, "snapshotId") ?? "", "阶段总结");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const snapshot = await prisma.memorySnapshot.findFirst({
    where: { id: snapshotId, memoryScope: { is: { characterId } } },
    select: {
      id: true,
      snapshotKey: true,
      version: true,
      kind: true,
      periodStart: true,
      periodEnd: true,
      summary: true,
      structuredContent: true,
      status: true,
      createdAt: true,
      reviews: { select: { changeIndex: true, decision: true, memoryItemId: true, outcome: true } },
      // 已被清理的消息（messageId 置空）不计入条数：点开来源也看不到它
      sources: { where: { sourceType: "MESSAGE", messageId: { not: null } }, select: { sourceType: true } },
    },
  });
  if (!snapshot) {
    throw createError({ statusCode: 404, statusMessage: "阶段总结不存在。" });
  }

  const [sourceRows, snapshotKeys] = await Promise.all([
    // 与来源分页接口同一个排序：证据编号「#3」必须两处一致。
    prisma.memorySnapshotSource.findMany({
      where: { snapshotId, sourceType: "MESSAGE", messageId: { not: null } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { messageId: true },
    }),
    prisma.memorySnapshot.groupBy({
      by: ["snapshotKey"],
      where: { memoryScope: { is: { characterId } }, kind: "AUTOMATIC" },
      _min: { createdAt: true },
    }),
  ]);

  const sequence = buildSnapshotSequence(
    snapshotKeys.map((row) => ({ snapshotKey: row.snapshotKey, createdAt: row._min.createdAt ?? new Date(0) })),
  );
  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";

  return toMemorySnapshotDetail(snapshot, timeZone, {
    sequenceByKey: sequence,
    sourceMessageIds: sourceRows.flatMap((row) => (row.messageId ? [row.messageId] : [])),
  });
});
