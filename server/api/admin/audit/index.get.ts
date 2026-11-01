import { getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { buildPage, readPageQuery } from "../../../utils/pagination";
import { getPrisma } from "../../../utils/prisma";

/**
 * Recent audit activity for the administrator. Defaults to authentication events (login, logout,
 * registration, password change, session revocation); an exact `action` may be supplied to filter.
 *
 * This table only ever grows, so it is paged server-side: `?page=1&pageSize=20`. The old `?limit=`
 * is still accepted as a pageSize alias so old bookmarks keep working.
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const { page, pageSize, skip } = readPageQuery(query, {
    defaultPageSize: 20,
    maxPageSize: 100,
    legacySizeKey: "limit",
  });
  const action = typeof query.action === "string" && query.action ? query.action : "";
  const where = action ? { action } : { action: { startsWith: "auth." } };

  const prisma = getPrisma();
  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      // createdAt 会撞车（同一秒内多条），补 id 才能保证翻页时不重不漏。
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        details: true,
        createdAt: true,
        actor: { select: { username: true, displayName: true } },
      },
    }),
  ]);

  return buildPage(
    logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      details: log.details,
      createdAt: log.createdAt.toISOString(),
      actor: log.actor ? (log.actor.displayName || log.actor.username) : null,
    })),
    total,
    page,
    pageSize,
  );
});
