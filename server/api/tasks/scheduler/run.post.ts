import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { enqueueDueMemorySnapshots } from "../../../utils/memory-scheduler";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  // 手动扫描是全局运维动作：扫描所有角色，不限定为管理员账号名下。
  const report = await enqueueDueMemorySnapshots(getPrisma());
  return {
    ...report,
    note: "调度器只负责把到期周期写入持久化队列；由独立 Worker 调用已配置的模型执行阶段总结生成。",
  };
});
