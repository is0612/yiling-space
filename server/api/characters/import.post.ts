import { createError, getHeader, readBody } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { CHARACTER_BUNDLE_MAX_BYTES } from "../../utils/character-portable";
import { importCharacterCard } from "../../utils/character-transfer";
import { getPrisma } from "../../utils/prisma";

/**
 * 导入一张角色卡，**总是新建角色**（不合并、不覆盖）。
 *
 * 包被当成不可信输入：字段逐个校验、数量上限、模型参数走白名单、任何密钥字段都不读。
 * 具体校验与落库在 `server/utils/character-transfer.ts`。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);

  const declaredLength = Number(getHeader(event, "content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > CHARACTER_BUNDLE_MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `角色卡文件超过 ${Math.round(CHARACTER_BUNDLE_MAX_BYTES / 1024 / 1024)}MB，请确认选对了文件。`,
    });
  }

  const raw = await readBody<unknown>(event);
  const result = await importCharacterCard({ raw, ownerId });

  const created = await getPrisma().character.findUniqueOrThrow({
    where: { id: result.characterId },
    include: characterInclude,
  });

  setResponseStatus(event, 201);
  return {
    character: toCharacterDto(created),
    counts: result.counts,
  };
});
