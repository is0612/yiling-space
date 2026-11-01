import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

/**
 * Administrator readiness probe: database connectivity and task-queue state, so an operator (or a
 * monitoring check) can see the key background work without opening the task list page.
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const prisma = getPrisma();

  let database: "up" | "down" = "up";
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
  } catch {
    database = "down";
  }

  let jobs = { queued: 0, running: 0, failed: 0, succeeded: 0 };
  if (database === "up") {
    try {
      const groups = await prisma.memoryJob.groupBy({ by: ["status"], _count: { _all: true } });
      for (const group of groups) {
        const key = group.status.toLowerCase();
        if (key in jobs) jobs[key as keyof typeof jobs] = group._count._all;
      }
    } catch {
      // keep zeroed counts on a transient query failure
    }
  }

  return {
    ok: database === "up",
    database,
    jobs,
    time: new Date().toISOString(),
  };
});
