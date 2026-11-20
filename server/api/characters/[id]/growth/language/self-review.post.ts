import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { getPrisma } from "../../../../../utils/prisma";
import { requireUuid } from "../../../../../utils/local-api";
import { countSelfReviewedToday, runExpressionHabitSelfReview, SELF_REVIEW_DAILY_LIMIT } from "../../../../../utils/expression-habit-self-review";

/** Owner-triggered: she reviews her own pending language habits, bounded by a daily ceiling. */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();
  try {
    const result = await runExpressionHabitSelfReview(prisma, { ownerId, characterId });
    return { ...result, limit: SELF_REVIEW_DAILY_LIMIT, used: await countSelfReviewedToday(prisma, characterId) };
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    throw createError({ statusCode: 500, statusMessage: "自审失败。" });
  }
});
