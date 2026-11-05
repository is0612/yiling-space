import { defineEventHandler } from "h3";
import { requireActorUserId } from "../utils/auth";
import { listMemoryProgress } from "../utils/memory-progress";
import { getPrisma } from "../utils/prisma";

/**
 * 正在跑的记忆任务（忆泡整理 / 阶段总结）。
 *
 * 只读、只算当前账号名下的任务。面板前端轮询这个接口，不依赖哪个页面发起的请求 ——
 * 请求被切走、页面刷新都不影响「任务在跑」这件事被看见。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const jobs = await listMemoryProgress(getPrisma(), { ownerId });
  return { jobs, checkedAt: new Date().toISOString() };
});
