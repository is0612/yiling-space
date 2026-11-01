import { getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { buildPage, readPageQuery } from "../../../utils/pagination";
import { getPrisma } from "../../../utils/prisma";

/**
 * Account list for the administrator. Returns identity and activity counts only — never any
 * character, conversation or memory content. Admins manage who can log in, not what those users
 * talk about.
 *
 * Paged with `?page=1&pageSize=20`. The header counters (admin / disabled) are computed over the
 * whole table via groupBy, so they stay correct on page 3 — counting the current page only would
 * make the numbers shrink as you flip through.
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const { page, pageSize, skip } = readPageQuery(query, { defaultPageSize: 20, maxPageSize: 100 });

  const prisma = getPrisma();
  const [total, users, roleGroups, statusGroups] = await Promise.all([
    prisma.user.count(),
    prisma.user.findMany({
      // createdAt 同秒会撞车，补 id 保证翻页稳定。
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        role: true,
        status: true,
        createdAt: true,
        _count: { select: { ownedCharacters: true } },
      },
    }),
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  // 只查本页这些人的会话，不必把全站 session 按 userId 分组一遍。
  const activity = users.length
    ? await prisma.session.groupBy({
      by: ["userId"],
      where: { userId: { in: users.map((user) => user.id) } },
      _max: { lastUsedAt: true },
    })
    : [];
  const lastActiveByUser = new Map(activity.map((entry) => [entry.userId, entry._max.lastUsedAt]));

  return {
    ...buildPage(
      users.map((user) => ({
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        characterCount: user._count.ownedCharacters,
        lastActiveAt: lastActiveByUser.get(user.id)?.toISOString() ?? null,
      })),
      total,
      page,
      pageSize,
    ),
    stats: {
      total,
      adminCount: roleGroups.find((group) => group.role === "ADMIN")?._count._all ?? 0,
      disabledCount: statusGroups.find((group) => group.status === "DISABLED")?._count._all ?? 0,
    },
  };
});
