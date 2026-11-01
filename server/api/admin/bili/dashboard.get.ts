import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { loadBiliConnections } from "../../../utils/channel-adapter/bili/configure";
import { remainingQuota, toDayKey, dueWindow, type BiliWindowKey } from "../../../utils/channel-adapter/bili/duty-scheduler";

/**
 * B站工作台仪表盘数据。把 bili-desk 的「概览」页数据（今日刷了几条 / 配额 / 报告 /
 * 她今天看了什么 / 下次窗口）从数据库里聚合出来，供前端仪表盘展示。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const prisma = getPrisma();
  const today = toDayKey(new Date());

  const connections = await loadBiliConnections();

  const accounts = await Promise.all(
    connections.map(async (connection) => {
      // 该连接下所有活动绑定（通常一个 B站账号绑一个角色，也可能多角色）
      const bindings = await Promise.all(
        connection.bindings.map(async (binding) => {
          const character = await prisma.character.findUnique({
            where: { id: binding.characterId },
            select: { id: true, name: true },
          });

          const reports = await prisma.biliRoundReport.findMany({
            where: { bindingId: binding.id, day: today },
            orderBy: [{ roundIndex: "asc" }],
            select: { id: true, roundIndex: true, pickedCount: true, content: true, createdAt: true },
          });
          const resetAt = connection.duty.quotaResetAt ? new Date(connection.duty.quotaResetAt) : null;
          const pickedToday = reports
            .filter((report) => !resetAt || report.createdAt >= resetAt)
            .reduce((sum, report) => sum + report.pickedCount, 0);

          const seenToday = await prisma.biliSeenVideo.findMany({
            where: { bindingId: binding.id, seenAt: { gte: new Date(`${today}T00:00:00+08:00`) } },
            orderBy: [{ seenAt: "desc" }],
            take: 50,
            select: { id: true, bvid: true, title: true, author: true, result: true, reason: true, score: true, seenAt: true },
          });

          const remaining = remainingQuota(connection.duty, { day: today, picked: pickedToday, windowsRun: [] });
          const now = new Date();
          const nextWindow = dueWindow(now, connection.duty, { day: today, picked: pickedToday, windowsRun: [] });

          return {
            bindingId: binding.id,
            characterId: binding.characterId,
            characterName: character?.name ?? "（角色已删除）",
            pickedToday,
            remaining,
            perDay: connection.duty.perDay,
            reports: reports.map((r) => ({
              id: r.id,
              roundIndex: r.roundIndex,
              pickedCount: r.pickedCount,
              content: r.content,
              createdAt: r.createdAt.toISOString(),
            })),
            seenToday: seenToday.map((v) => ({
              bvid: v.bvid,
              title: v.title,
              author: v.author,
              result: v.result,
              reason: v.reason,
              score: v.score,
              seenAt: v.seenAt.toISOString(),
            })),
          };
        }),
      );

      return {
        connectionId: connection.id,
        displayName: connection.dataHome || "B站账号",
        dataHome: connection.dataHome,
        biliBin: connection.biliBin,
        duty: connection.duty,
        nextWindow: null as BiliWindowKey | null,
        bindings,
      };
    }),
  );

  // 计算每个账号的下一个触发窗口（对所有绑定取第一个 due 的窗口）
  for (const account of accounts) {
    const now = new Date();
    for (const binding of account.bindings) {
      const window = dueWindow(now, account.duty, { day: today, picked: binding.pickedToday, windowsRun: [] });
      if (window) {
        account.nextWindow = window;
        break;
      }
    }
  }

  return {
    today,
    accounts,
  };
});
