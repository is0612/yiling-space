import { Prisma, type PrismaClient } from "../../src/generated/prisma/client";

export const JOURNAL_EVENT_SOURCE_LIMIT = 30;

/** 有界取材：每个范围、每个当地四小时时段轮流取一条，组内优先最新记录。 */
export async function collectJournalEventSources(
  prisma: Pick<PrismaClient, "$queryRaw">,
  input: { scopeIds: string[]; dayKey: string; timeZone: string },
): Promise<Array<{ id: string; occurredAt: Date; title: string; detail: string }>> {
  const scopes = [...new Set(input.scopeIds)];
  if (!scopes.length) return [];
  // 在数据库内分组排名，避免把整天忆泡拉回进程，也避免逐范围逐时段查询。
  // 同一时间以 ID 稳定排序；不足 30 条时全部保留，空闲时段的额度自动让给其他组。
  return prisma.$queryRaw`
    WITH ranked AS (
      SELECT id, "occurredAt", title, detail,
        floor(extract(hour FROM "occurredAt" AT TIME ZONE ${input.timeZone}) / 4) AS bucket,
        row_number() OVER (
          PARTITION BY "memoryScopeId", floor(extract(hour FROM "occurredAt" AT TIME ZONE ${input.timeZone}) / 4)
          ORDER BY "occurredAt" DESC, id DESC
        ) AS position
      FROM memory_events
      WHERE "memoryScopeId" IN (${Prisma.join(scopes.map(id => Prisma.sql`${id}::uuid`))})
        AND "dayKey" = ${input.dayKey} AND status = 'ACTIVE'
    ), picked AS (
      SELECT id, "occurredAt", title, detail FROM ranked
      ORDER BY position ASC, bucket DESC, "occurredAt" DESC, id DESC
      LIMIT ${JOURNAL_EVENT_SOURCE_LIMIT}
    )
    SELECT id, "occurredAt", title, detail FROM picked ORDER BY "occurredAt" ASC, id ASC
  `;
}
