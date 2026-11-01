import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { invalidateCatchphraseCache } from "../../../../utils/catchphrases";

/** 删一条梗。纯文本，没有附属文件要清理。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const catchphraseId = requireUuid(getRouterParam(event, "catchphraseId") ?? "", "梗");
  const prisma = getPrisma();

  const existing = await prisma.characterCatchphrase.findFirst({
    where: { id: catchphraseId, characterId: id, character: { ownerId } },
    select: { id: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "这条梗不存在。" });

  await prisma.characterCatchphrase.delete({ where: { id: catchphraseId } });
  invalidateCatchphraseCache(id);
  return { ok: true };
});
