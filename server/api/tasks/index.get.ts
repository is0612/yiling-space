import { createError, getQuery } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { buildPage, readPageQuery } from "../../utils/pagination";
import { getPrisma } from "../../utils/prisma";

const statuses = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "RETRY_WAIT", "CANCELLED"] as const;
type JobStatus = (typeof statuses)[number];

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const query = getQuery(event);
  const statusValue = typeof query.status === "string" ? query.status.toUpperCase() : "";
  if (statusValue && !(statuses as readonly string[]).includes(statusValue)) {
    throw createError({ statusCode: 400, statusMessage: "任务状态筛选值无效。" });
  }
  // 任务表只增不减，分页口径和其它列表接口一致（旧的 `?limit=` 仍当 pageSize 用）。
  const { page, pageSize, skip } = readPageQuery(query, {
    defaultPageSize: 50,
    maxPageSize: 100,
    legacySizeKey: "limit",
  });

  const prisma = getPrisma();
  const where = {
    memoryScope: { is: { character: { is: { ownerId } } } },
    ...(statusValue ? { status: statusValue as JobStatus } : {}),
  };
  const [jobs, total, statusGroups] = await Promise.all([
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
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        memoryScope: { select: { id: true, character: { select: { id: true, name: true } } } },
      },
    }),
    prisma.memoryJob.count({ where }),
    prisma.memoryJob.groupBy({ by: ["status"], where: { memoryScope: { is: { character: { is: { ownerId } } } } }, _count: { _all: true } }),
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
