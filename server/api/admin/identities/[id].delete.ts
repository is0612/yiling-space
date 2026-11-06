import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { deleteFriendScope } from "../../../utils/friend-delete";

/**
 * 删掉「某个角色认识的某个人」这条关系，连同它名下的对话、忆泡、阶段总结和长期记忆。
 *
 * 删除顺序与口径见 `server/utils/friend-delete.ts`（那里写着哪些留、哪些走、为什么）。
 * 这里只做权限、参数校验和「找不到」的翻译。
 */
export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const scopeId = requireUuid(getRouterParam(event, "id") ?? "", "朋友关系");

  const outcome = await deleteFriendScope({ scopeId, actorId: actor.user.id });
  if (!outcome) throw createError({ statusCode: 404, statusMessage: "朋友关系不存在。" });

  return {
    ok: true,
    ...outcome,
    // 平台账号是共享的，显式表态「那边没动」，别让人靠猜。
    identityPreserved: true,
  };
});
