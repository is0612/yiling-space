import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { reviewSocialRelationshipAssessment, type SocialRelationshipReviewDecision } from "../../../../../../utils/social-relationship-review";

function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const note = value.trim().slice(0, 1_000);
  return note || null;
}

export default defineEventHandler(async (event) => {
  const actorUserId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const assessmentId = requireUuid(getRouterParam(event, "assessmentId") ?? "", "评估记录");
  const body = await readBody<{ decision?: unknown; note?: unknown }>(event);
  const decision = body?.decision;
  if (decision !== "ACCEPTED" && decision !== "REJECTED" && decision !== "DEFERRED") {
    throw createError({ statusCode: 400, statusMessage: "处置决定无效。" });
  }
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId: actorUserId },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const result = await reviewSocialRelationshipAssessment(prisma, {
    characterId, assessmentId, actorUserId,
    decision: decision as SocialRelationshipReviewDecision,
    note: cleanNote(body?.note),
  });
  if ("stale" in result && result.stale) {
    throw createError({ statusCode: 409, statusMessage: "这条建议已过期，已标记为过期，没有修改关系。请等待新评估。" });
  }
  return result;
});
