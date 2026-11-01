import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { QqCustomFaceError } from "../../../../utils/qq-custom-face";
import { syncStickersWithQq } from "../../../../utils/qq-sticker-sync";

/**
 * 跟 QQ 收藏夹对一次账：缺的导下来、多的推上去、QQ 删了的本地进回收站。
 *
 * 为什么是一个「点一下」的动作而不是定时任务：一次可能搬几十张图（下载 + 缩图 + 上传），
 * 放到后台悄悄跑，用户看到表情库自己变样只会更迷惑。手动触发，结果当场报清楚。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  try {
    return await syncStickersWithQq({ characterId: id });
  } catch (error) {
    // QqCustomFaceError 的 message 是写给用户看的（连不上 / 网关不支持 / 删除失败），
    // 别的异常一律不把内部信息透出去。
    if (error instanceof QqCustomFaceError) {
      throw createError({ statusCode: 400, statusMessage: error.message });
    }
    throw createError({ statusCode: 500, statusMessage: "同步出错了，稍后再试。" });
  }
});
