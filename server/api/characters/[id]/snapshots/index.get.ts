import { createError, getQuery, getRouterParam } from "h3";
import type { Prisma } from "../../../../../src/generated/prisma/client";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import {
  buildSnapshotSequence,
  formatSnapshotDate,
  toMemorySnapshotSummaries,
} from "../../../../utils/memory-snapshot-dto";

/**
 * 阶段总结列表。
 *
 * 以前这个接口把每份总结的分析结果、每条来源消息原文一起返回，一页几十份就是几兆；
 * 现在只给列表行要显示的字段（计数、状态、待审核条数），点开某一版走
 * `GET /characters/{id}/snapshots/{snapshotId}`，「来源消息与原文」再走
 * `GET .../snapshots/{snapshotId}/sources` 分页取。
 *
 * 筛选、搜索、翻页都在服务端做：前端不再拉全量再自己 slice。
 */

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

function positiveInt(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const query = getQuery(event);
  const pageSize = positiveInt(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const requestedPage = positiveInt(query.page, 1);
  const keyword = String(query.q ?? "").trim().slice(0, 200);

  // 非法值当作「没传」：筛选器多打一个字不该整页 400。
  const statusRaw = String(query.status ?? "").trim().toUpperCase();
  const status = statusRaw === "CURRENT" || statusRaw === "SUPERSEDED" ? statusRaw : undefined;
  const kindRaw = String(query.kind ?? "").trim().toUpperCase();
  const kind = kindRaw === "AUTOMATIC" || kindRaw === "MANUAL" ? kindRaw : undefined;

  /**
   * 计数按「关键词」这一层算，不掺 kind / status：
   * 自动 / 手动两个数要一直是全量，否则收起手动存档时「手动存档 N」这个入口会消失；
   * 当前 / 已替代两个数再按 kind 收窄，跟着当前视图走。
   */
  const countWhere: Prisma.MemorySnapshotWhereInput = {
    memoryScope: { is: { characterId } },
    ...(keyword ? { summary: { contains: keyword, mode: "insensitive" as const } } : {}),
  };
  const where: Prisma.MemorySnapshotWhereInput = {
    ...countWhere,
    ...(kind ? { kind } : {}),
    ...(status ? { status } : {}),
  };

  const [grouped, snapshotKeys, latest, messages, automaticTotal, manualTotal] = await Promise.all([
    // 一次分组拿到四个计数：自动/手动、当前/已替代。
    prisma.memorySnapshot.groupBy({
      by: ["kind", "status"],
      where: countWhere,
      _count: { _all: true },
    }),
    // 「第 N 份」要按全量自动归档排，不能只看这一页。
    prisma.memorySnapshot.groupBy({
      by: ["snapshotKey"],
      where: { memoryScope: { is: { characterId } }, kind: "AUTOMATIC" },
      _min: { createdAt: true },
    }),
    prisma.memorySnapshot.findFirst({
      where: { memoryScope: { is: { characterId } } },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
      select: { createdAt: true },
    }),
    prisma.memorySnapshotSource.count({
      where: {
        sourceType: "MESSAGE",
        messageId: { not: null },
        snapshot: { is: { memoryScope: { is: { characterId } } } },
      },
    }),
    // 统计带上的「历史归档 / 另有 N 份手动存档」是全量口径：搜索和翻页时不该跟着变。
    prisma.memorySnapshot.count({ where: { memoryScope: { is: { characterId } }, kind: "AUTOMATIC" } }),
    prisma.memorySnapshot.count({ where: { memoryScope: { is: { characterId } }, kind: "MANUAL" } }),
  ]);

  const countOf = (predicate: (row: typeof grouped[number]) => boolean) => grouped
    .filter(predicate)
    .reduce((total, row) => total + row._count._all, 0);
  const inKind = (row: typeof grouped[number]) => !kind || row.kind === kind;
  const counts = {
    automatic: countOf((row) => row.kind === "AUTOMATIC"),
    manual: countOf((row) => row.kind === "MANUAL"),
    current: countOf((row) => row.status === "CURRENT" && inKind(row)),
    superseded: countOf((row) => row.status === "SUPERSEDED" && inKind(row)),
  };
  // 「全部」= 当前视图下能翻到的总数；状态之外的条件已经算进分组里了。
  const total = status
    ? counts[status === "CURRENT" ? "current" : "superseded"]
    : kind
      ? counts[kind === "AUTOMATIC" ? "automatic" : "manual"]
      : counts.automatic + counts.manual;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const rows = await prisma.memorySnapshot.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    skip: (page - 1) * pageSize,
    take: pageSize,
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

  const sequence = buildSnapshotSequence(
    snapshotKeys.map((row) => ({ snapshotKey: row.snapshotKey, createdAt: row._min.createdAt ?? new Date(0) })),
  );

  return {
    items: toMemorySnapshotSummaries(rows, timeZone, sequence),
    total,
    page,
    pageSize,
    totalPages,
    counts,
    stats: {
      messages,
      latestDate: latest ? formatSnapshotDate(latest.createdAt, timeZone, true) : null,
      automatic: automaticTotal,
      manual: manualTotal,
    },
  };
});
