import { requireActorUserId } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { enqueueDueMemorySnapshots } from "../../../utils/memory-scheduler";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const report = await enqueueDueMemorySnapshots(getPrisma(), { ownerId });
  return {
    ...report,
    note: "调度器只负责把到期周期写入持久化队列；由独立 Worker 调用已配置的模型执行阶段总结生成。",
  };
});
