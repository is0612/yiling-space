import { createError } from "h3";
import { requireAdminActor } from "../../utils/auth";
import { deleteWorkflowTemplate } from "../../utils/comfy-workflow-template";

/**
 * 删掉模板，回到现拼模式。
 *
 * 删的是「当前生效的那一份」；环境变量指向别处时删的就是那个位置的文件。
 * 删完不需要重启：模板缓存按 mtime 失效，下一次出图就会重新判断。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const result = await deleteWorkflowTemplate();
  if (!result.ok) {
    throw createError({ statusCode: 500, statusMessage: `删除失败：${result.reason}` });
  }
  return { ok: true, removed: result.removed };
});
