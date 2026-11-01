import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { CATCHPHRASE_STATUS, invalidateCatchphraseCache, toCatchphraseDto } from "../../../../utils/catchphrases";

/**
 * 改台词、改场景，或临时关掉一条（记录留着）。
 *
 * 也负责「待确认」的裁决：`status: "ACTIVE"` = 入库，`status: "REJECTED"` = 不要。
 * 不接受把 status 改回 PENDING —— 没有哪个界面需要「重新变回待确认」，
 * 允许多一条路径只会多一种坏状态。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const catchphraseId = requireUuid(getRouterParam(event, "catchphraseId") ?? "", "梗");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();

  const existing = await prisma.characterCatchphrase.findFirst({
    where: { id: catchphraseId, characterId: id, character: { ownerId } },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "这条梗不存在。" });

  const data: { phrase?: string; usage?: string; enabled?: boolean; status?: string } = {};
  if (body.phrase !== undefined) data.phrase = readTrimmedString(body.phrase, "台词", 200, { required: true });
  if (body.usage !== undefined) data.usage = readTrimmedString(body.usage, "什么时候说", 300);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "enabled 必须是布尔值。" });
    data.enabled = body.enabled;
  }
  if (body.status !== undefined) {
    if (body.status !== CATCHPHRASE_STATUS.active && body.status !== CATCHPHRASE_STATUS.rejected) {
      throw createError({ statusCode: 400, statusMessage: "status 只能是 ACTIVE 或 REJECTED。" });
    }
    data.status = body.status;
    // 「入库」点下去的语义就是「现在开始用」，顺手把开关打开 ——
    // 不再让用户确认完还要回列表里多点一次开关。
    if (body.status === CATCHPHRASE_STATUS.active) data.enabled = true;
  }
  if (!Object.keys(data).length) throw createError({ statusCode: 400, statusMessage: "没有要更新的字段。" });

  // 改了台词也要查重：A 改成 B、而 B 早就存在时，两条会变成一模一样。
  if (data.phrase && data.phrase !== existing.phrase) {
    const duplicate = await prisma.characterCatchphrase.findFirst({
      where: { characterId: id, phrase: data.phrase, id: { not: catchphraseId } },
      select: { id: true },
    });
    if (duplicate) throw createError({ statusCode: 409, statusMessage: "这句已经在列表里了。" });
  }

  const row = await prisma.characterCatchphrase.update({ where: { id: catchphraseId }, data });
  invalidateCatchphraseCache(id);
  return toCatchphraseDto(row);
});
