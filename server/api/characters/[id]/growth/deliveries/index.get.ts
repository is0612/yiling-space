import { createError, getQuery, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";
import { readPageQuery } from "../../../../../utils/pagination";
import { GROWTH_DELIVERY_STATUSES, listGrowthDeliveries, type GrowthDeliveryStatus } from "../../../../../utils/growth-delivery-monitor";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const query = getQuery(event);
  const rawStatus = query.status;
  if (rawStatus !== undefined && (typeof rawStatus !== "string" || (rawStatus !== "" && !GROWTH_DELIVERY_STATUSES.includes(rawStatus as GrowthDeliveryStatus)))) {
    throw createError({ statusCode: 400, statusMessage: "投递状态无效。" });
  }
  const { page, pageSize } = readPageQuery(query, { defaultPageSize: 20, maxPageSize: 100 });
  return listGrowthDeliveries(getPrisma(), { ownerId, characterId, page, pageSize, status: rawStatus ? rawStatus as GrowthDeliveryStatus : undefined });
});
