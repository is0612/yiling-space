import { randomUUID } from "node:crypto";
import { requireActorUserId } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { processNextMemoryJob } from "../../../utils/memory-worker";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  return processNextMemoryJob(getPrisma(), {
    ownerId,
    workerId: `local-ui-${process.pid}-${randomUUID()}`,
  });
});
