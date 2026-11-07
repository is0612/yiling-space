import { createError, getQuery } from "h3";
import { requireAdminActor } from "../../utils/auth";
import { isMemoryJobLeaseExpired, MEMORY_JOB_LEASE_MS } from "../../utils/memory-job-lease";
import { buildPage, readPageQuery } from "../../utils/pagination";
import { getPrisma } from "../../utils/prisma";

const statuses = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "RETRY_WAIT", "CANCELLED"] as const;
type JobStatus = (typeof statuses)[number];

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const statusValue = typeof query.status === "string" ? query.status.toUpperCase() : "";
  if (statusValue && statusValue !== "ISSUES" && !(statuses as readonly string[]).includes(statusValue)) {
    throw createError({ statusCode: 400, statusMessage: "任务状态筛选值无效。" });
  }
  // 任务表只增不减，分页口径和其它列表接口一致（旧的 `?limit=` 仍当 pageSize 用）。
  const searchValue = typeof query.q === "string" ? query.q.trim() : "";
  if (searchValue.length > 100) throw createError({ statusCode: 400, statusMessage: "搜索内容不能超过 100 个字符。" });

  const { page, pageSize, skip } = readPageQuery(query, {
    defaultPageSize: 20,
    maxPageSize: 100,
    legacySizeKey: "limit",
  });

  const prisma = getPrisma();
  const now = new Date();
  // 任务监控是管理员的全局运维台：统计和列表覆盖所有角色，不按管理员账号筛选。
  const statusWhere = statusValue === "ISSUES"
    ? { status: { in: ["FAILED", "RETRY_WAIT"] as JobStatus[] } }
    : statusValue ? { status: statusValue as JobStatus } : {};
  const typeByLabel: Record<string, string> = {
    "生成阶段总结": "GENERATE_SNAPSHOT",
    "重新生成总结": "REGENERATE_SNAPSHOT",
    "长期记忆更新": "UPDATE_LONG_TERM_MEMORY",
    "清理过期消息": "CLEAN_EXPIRED_MESSAGES",
    "整理忆泡": "EXTRACT_EVENTS",
    "生成日记/手账": "GENERATE_JOURNAL",
  };
  const typeByCode: Record<string, string> = {
    GENERATE_SNAPSHOT: "GENERATE_SNAPSHOT",
    REGENERATE_SNAPSHOT: "REGENERATE_SNAPSHOT",
    UPDATE_LONG_TERM_MEMORY: "UPDATE_LONG_TERM_MEMORY",
    CLEAN_EXPIRED_MESSAGES: "CLEAN_EXPIRED_MESSAGES",
    EXTRACT_EVENTS: "EXTRACT_EVENTS",
    GENERATE_JOURNAL: "GENERATE_JOURNAL",
  };
  const normalizedSearch = searchValue.toUpperCase();
  const matchedTypes = statuses.length
    ? Object.entries({ ...typeByLabel, ...typeByCode })
      .filter(([label, type]) => label.toUpperCase().includes(normalizedSearch) || type.includes(normalizedSearch))
      .map(([, type]) => type)
    : [];
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(searchValue);
  // 列表展示 UUID 前 8 位，支持把可见短编号粘回搜索框（带不带连字符都认）。
  // PostgreSQL 的 UUID 列不能直接 LIKE，用参数化 SQL 转文本、去掉连字符再比前缀。
  // 不加 LIMIT：8 位十六进制前缀在真实 UUID 上几乎唯一，而截断会让 total 静默少报。
  const hexSearch = searchValue.replace(/-/g, "");
  const isUuidPrefix = !isUuid
    && hexSearch.length >= 8
    && hexSearch.length <= 32
    && /^[0-9a-f]+$/i.test(hexSearch)
    && /^[0-9a-f-]+$/i.test(searchValue);
  const matchingJobIds = isUuidPrefix
    ? await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM memory_jobs
        WHERE replace(id::text, '-', '') ILIKE ${hexSearch + "%"}
      `
    : [];
  // 角色名走 Prisma 的 `contains`，它原样拼进 LIKE —— 不转义的话搜「%」会命中全表。
  const nameNeedle = searchValue.replace(/[\\%_]/g, (char) => "\\" + char);
  const searchWhere = searchValue ? {
    OR: [
      ...(isUuid ? [{ id: searchValue }, { memoryScopeId: searchValue }, { memoryScope: { characterId: searchValue } }] : []),
      ...(matchingJobIds.length ? [{ id: { in: matchingJobIds.map((row) => row.id) } }] : []),
      { memoryScope: { character: { name: { contains: nameNeedle, mode: "insensitive" as const } } } },
      ...(matchedTypes.length > 0 ? [{ type: { in: [...new Set(matchedTypes)] as ("GENERATE_SNAPSHOT" | "REGENERATE_SNAPSHOT" | "UPDATE_LONG_TERM_MEMORY" | "CLEAN_EXPIRED_MESSAGES" | "EXTRACT_EVENTS" | "GENERATE_JOURNAL")[] } }] : []),
    ],
  } : {};
  const where = { ...statusWhere, ...searchWhere };
  const leaseExpiredBefore = new Date(now.getTime() - MEMORY_JOB_LEASE_MS);
  const stuckWhere = {
    status: "RUNNING" as const,
    OR: [{ lockedAt: null }, { lockedAt: { lt: leaseExpiredBefore } }],
  };
  const [jobs, total, allTotal, statusGroups, stuckCount, oldestStuck] = await Promise.all([
    prisma.memoryJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip,
      take: pageSize,
      select: {
        id: true,
        type: true,
        status: true,
        attemptCount: true,
        maxAttempts: true,
        runAt: true,
        periodStart: true,
        periodEnd: true,
        lastError: true,
        startedAt: true,
        lockedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        memoryScope: { select: { id: true, character: { select: { id: true, name: true } } } },
      },
    }),
    prisma.memoryJob.count({ where }),
    prisma.memoryJob.count(),
    prisma.memoryJob.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.memoryJob.count({ where: stuckWhere }),
    prisma.memoryJob.findFirst({
      where: stuckWhere,
      orderBy: [{ lockedAt: "asc" }, { createdAt: "asc" }],
      select: { lockedAt: true },
    }),
  ]);

  const cleanupJobs = jobs.filter((job) => job.type === "CLEAN_EXPIRED_MESSAGES");
  const cleanupJobIds = new Set(cleanupJobs.map((job) => job.id));
  const cleanupAudits = cleanupJobs.length > 0
    ? await prisma.auditLog.findMany({
      where: {
        action: "message.retention_cleanup",
        entityType: "MemoryScope",
        OR: cleanupJobs.map((job) => ({
          entityId: job.memoryScope.id,
          details: { path: ["jobId"], equals: job.id },
        })),
      },
      orderBy: { createdAt: "desc" },
      select: { details: true, createdAt: true },
    })
    : [];
  const cleanupResultByJobId = new Map<string, {
    deletedMessageCount: number | null;
    cutoff: string | null;
    recordedAt: string;
  }>();
  for (const audit of cleanupAudits) {
    const details = audit.details && typeof audit.details === "object" && !Array.isArray(audit.details)
      ? audit.details as Record<string, unknown>
      : null;
    const jobId = typeof details?.jobId === "string" ? details.jobId : null;
    if (!jobId || !cleanupJobIds.has(jobId) || cleanupResultByJobId.has(jobId)) continue;
    cleanupResultByJobId.set(jobId, {
      deletedMessageCount: typeof details?.deletedMessages === "number" ? details.deletedMessages : null,
      cutoff: typeof details?.cutoff === "string" ? details.cutoff : null,
      recordedAt: audit.createdAt.toISOString(),
    });
  }

  return {
    ...buildPage(
      jobs.map((job) => ({
        id: job.id,
        type: job.type,
        status: job.status,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        runAt: job.runAt.toISOString(),
        periodStart: job.periodStart?.toISOString() ?? null,
        periodEnd: job.periodEnd?.toISOString() ?? null,
        lastError: job.lastError,
        startedAt: job.startedAt?.toISOString() ?? null,
        lockedAt: job.lockedAt?.toISOString() ?? null,
        // 运行中 + 租约过期 = 领走它的进程已经不在了，没人会回收它。
        leaseExpired: job.status === "RUNNING" && isMemoryJobLeaseExpired(job.lockedAt, now),
        completedAt: job.completedAt?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
        characterId: job.memoryScope.character.id,
        characterName: job.memoryScope.character.name,
        cleanupResult: cleanupResultByJobId.get(job.id) ?? null,
      })),
      total,
      page,
      pageSize,
    ),
    stuckCount,
    allTotal,
    oldestStuckAt: oldestStuck?.lockedAt?.toISOString() ?? null,
    statusCounts: {
      QUEUED: statusGroups.find((group) => group.status === "QUEUED")?._count._all ?? 0,
      RUNNING: statusGroups.find((group) => group.status === "RUNNING")?._count._all ?? 0,
      SUCCEEDED: statusGroups.find((group) => group.status === "SUCCEEDED")?._count._all ?? 0,
      FAILED: statusGroups.find((group) => group.status === "FAILED")?._count._all ?? 0,
      RETRY_WAIT: statusGroups.find((group) => group.status === "RETRY_WAIT")?._count._all ?? 0,
      SKIPPED: statusGroups.find((group) => group.status === "SKIPPED")?._count._all ?? 0,
      CANCELLED: statusGroups.find((group) => group.status === "CANCELLED")?._count._all ?? 0,
    },
  };
});
