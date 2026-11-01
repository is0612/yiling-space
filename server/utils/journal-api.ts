import { createError, getRouterParam, type H3Event } from "h3";
import type { PrismaClient } from "../../src/generated/prisma/client";
import { getPrisma } from "./prisma";
import { requireActorUserId } from "./auth";
import { requireUuid } from "./local-api";
import { isJournalDayKey, type JournalGenerationOutcome } from "./journal-service";
import { toJournalRevisionDto } from "./journal-dto";

/** 日记/手账接口共用的「角色属于当前用户」校验。 */
export async function requireJournalCharacter(
  event: H3Event,
): Promise<{ ownerId: string; characterId: string; prisma: PrismaClient }> {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  return { ownerId, characterId, prisma };
}

/** 路径上的日期键（YYYY-MM-DD）。 */
export function readJournalDayKey(event: H3Event): string {
  const dayKey = String(getRouterParam(event, "dayKey") ?? "").trim();
  if (!isJournalDayKey(dayKey)) {
    throw createError({ statusCode: 400, statusMessage: "日期必须是 YYYY-MM-DD。" });
  }
  return dayKey;
}

/**
 * 把生成结果翻译成接口返回或错误。
 *
 * 「已经写过」用 409：页面上的「重写」是另一个按钮，混成成功响应会让人以为重写生效了。
 */
export function journalGenerationResponse(outcome: JournalGenerationOutcome): Record<string, unknown> {
  switch (outcome.status) {
    case "created":
      return {
        ok: true,
        status: "created",
        journalId: outcome.journalId,
        created: {
          ...(outcome.created?.DIARY
            ? { diary: toJournalRevisionDto(outcome.created.DIARY) }
            : {}),
          ...(outcome.created?.HANDBOOK
            ? { handbook: toJournalRevisionDto(outcome.created.HANDBOOK) }
            : {}),
        },
      };
    case "skipped":
      return { ok: true, status: "skipped", journalId: outcome.journalId, reason: outcome.reason };
    case "existing":
      throw createError({
        statusCode: 409,
        statusMessage: outcome.reason?.trim() || "这一天的日记/手账已经有了；要换一版请用「重写」。",
      });
    case "inactive":
      throw createError({ statusCode: 409, statusMessage: "角色已停用，暂时不能写日记/手账。" });
    case "not_configured":
      throw createError({ statusCode: 409, statusMessage: outcome.message ?? "角色还没有配置模型。" });
    case "quota_exceeded":
      throw createError({ statusCode: 429, statusMessage: outcome.message ?? "今日模型额度已用完。" });
  }
}
