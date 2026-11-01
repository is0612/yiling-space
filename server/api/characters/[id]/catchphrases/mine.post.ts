import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { mineCatchphrases } from "../../../../utils/catchphrase-mine";

/**
 * 扫一遍最近的群聊，把反复出现的说法捡回来（落成待确认，不直接生效）。
 *
 * 这个接口会花一次模型调用，所以必须是用户主动点的 —— 不做成页面一打开就扫。
 * 失败要报清楚（没配模型 / 模型报错），不能静默返回 0：用户点了按钮什么都没发生，
 * 比看到一句「还没配模型」更让人困惑。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({ where: { id, ownerId }, select: { id: true } });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  try {
    return await mineCatchphrases({ characterId: id });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "扫描失败。";
    throw createError({
      statusCode: detail.startsWith("还没配置模型") ? 503 : 502,
      statusMessage: detail.slice(0, 500),
    });
  }
});
