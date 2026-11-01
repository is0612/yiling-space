import { createError } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { deleteCharacterCompletely } from "../../utils/character-delete";
import { requireUuid } from "../../utils/local-api";

/**
 * 删除一个角色及其全部关联数据。
 *
 * 真正的删除语义（级联范围、没有外键的表、磁盘上的表情包目录）
 * 都在 `server/utils/character-delete.ts` 里，这里只做鉴权、参数校验和错误映射。
 * 抽出去的原因：删除顺序错了会被外键挡住、漏了没有外键的表会留孤儿行，
 * 这些都得能被脚本测到，塞在 handler 里就只能起 Nuxt 再手点。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");

  const result = await deleteCharacterCompletely({ characterId: id, ownerId });
  if (!result) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  return {
    ok: true,
    id: result.id,
    name: result.name,
    // 让前端能如实说「连表情包目录一起删了」还是「本来就没有目录」。
    removedStickerDirs: result.removedStickerDirs,
    purged: result.purged,
  };
});
