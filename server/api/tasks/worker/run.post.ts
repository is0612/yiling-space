import { randomUUID } from "node:crypto";
import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { processNextMemoryJob } from "../../../utils/memory-worker";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  // 手动运行 Worker 是全局运维动作：从所有角色的队列中领取下一条可执行任务。
  return processNextMemoryJob(getPrisma(), {
    workerId: `local-ui-${process.pid}-${randomUUID()}`,
  });
});
