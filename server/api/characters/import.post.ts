import { createError, getHeader, getQuery, readBody } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { CHARACTER_BUNDLE_MAX_BYTES } from "../../utils/character-portable";
import { importCharacterCard } from "../../utils/character-transfer";
import { requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

/**
 * 导入一张角色卡。
 *
 * 默认**新建角色**（不合并、不覆盖）。带上 `?target=<角色 id>` 时改为把卡并进那个角色，
 * 前提是卡片同步根 ID（`origin.characterId`）与目标角色的同步根一致，规则见
 * `server/utils/character-transfer.ts` 的 `mergeCharacterCard`。
 *
 * 包被当成不可信输入：字段逐个校验、数量上限、模型参数走白名单、任何密钥字段都不读。
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

  const targetParam = String(getQuery(event).target ?? "").trim();
  const targetCharacterId = targetParam ? requireUuid(targetParam, "合并目标角色") : null;

  const raw = await readBody<unknown>(event);
  const result = await importCharacterCard({ raw, ownerId, targetCharacterId });

  const current = await getPrisma().character.findUniqueOrThrow({
    where: { id: result.characterId },
    include: characterInclude,
  });

  setResponseStatus(event, result.mode === "merge" ? 200 : 201);
  return {
    character: toCharacterDto(current),
    mode: result.mode,
    counts: result.counts,
    added: result.added,
    warnings: result.warnings,
  };
});
