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
 * 默认**新建角色**（不合并、不覆盖）。带上 `?target=<角色 id>` 时改为写进那个角色：
 *   - 默认 `mode=merge`：本地保留、导入的按内容去重后追加。
 *   - `mode=replace`：以卡为准 —— 先清空本机这个角色随卡走的内容，再整包写入。
 *
 * 两种写进已有角色的方式都要求卡片同步根 ID（`origin.characterId`）与目标角色一致，
 * 规则见 `server/utils/character-transfer.ts`。
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

  const query = getQuery(event);
  const targetParam = String(query.target ?? "").trim();
  const targetCharacterId = targetParam ? requireUuid(targetParam, "目标角色") : null;

  const modeParam = String(query.mode ?? "").trim();
  if (modeParam && modeParam !== "merge" && modeParam !== "replace") {
    throw createError({ statusCode: 400, statusMessage: "不认识的导入方式，只支持合并或替换。" });
  }
  if (modeParam && !targetCharacterId) {
    throw createError({ statusCode: 400, statusMessage: "合并或替换都要先指定写进哪个角色。" });
  }
  const mode = targetCharacterId ? (modeParam === "replace" ? "replace" : "merge") : undefined;

  const raw = await readBody<unknown>(event);
  const result = await importCharacterCard({
    raw,
    ownerId,
    targetCharacterId,
    ...(mode ? { mode } : {}),
  });

  const current = await getPrisma().character.findUniqueOrThrow({
    where: { id: result.characterId },
    include: characterInclude,
  });

  setResponseStatus(event, result.mode === "new" ? 201 : 200);
  return {
    character: toCharacterDto(current),
    mode: result.mode,
    counts: result.counts,
    added: result.added,
    ...(result.removed ? { removed: result.removed } : {}),
    warnings: result.warnings,
  };
});
