import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { writeStickerNameToQq } from "../../../../utils/qq-sticker-sync";
import { invalidateStickerCache, toStickerDto } from "../../../../utils/stickers";

/** 改名字、使用场景，或临时停用一张（图留着）。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });

  const data: { name?: string; usage?: string; enabled?: boolean } = {};
  if (body.name !== undefined) data.name = readTrimmedString(body.name, "表情包名字", 60, { required: true });
  if (body.usage !== undefined) data.usage = readTrimmedString(body.usage, "使用场景", 200);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "enabled 必须是布尔值。" });
    data.enabled = body.enabled;
  }
  if (!Object.keys(data).length) throw createError({ statusCode: 400, statusMessage: "没有要更新的字段。" });

  const row = await prisma.characterSticker.update({ where: { id: stickerId }, data });
  invalidateStickerCache(id);

  /**
   * 改了名字、而这张在 QQ 收藏夹里也有一份 → 把备注一起改掉。
   *
   * 不回写的话，用户在 QQ 里看到的还是旧名字，「两边同步」就只同步了一半。
   * 但**不能因为它失败就让改名字失败**：本地改名是主操作，QQ 那边连不上是次生问题，
   * 所以结果放进 `qqDesc` 让页面提示，下次同步也不会丢（名字以本地为准）。
   */
  const qqDesc =
    data.name !== undefined && row.qqEmojiId && data.name !== existing.name
      ? await writeStickerNameToQq(id, row.qqEmojiId, data.name)
      : null;

  return { ...toStickerDto(row), qqDesc };
});
