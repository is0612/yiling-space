import { getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { readGrowthOverview, readGrowthOverviewDays } from "../../../../utils/growth-overview";
export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const days = readGrowthOverviewDays(getQuery(event).days);
  return readGrowthOverview(getPrisma(), { ownerId, characterId, days });
});
