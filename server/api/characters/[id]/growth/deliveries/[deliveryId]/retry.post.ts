import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../../../utils/auth";
import { requireUuid } from "../../../../../../utils/local-api";
import { getPrisma } from "../../../../../../utils/prisma";
import { readGrowthDelivery } from "../../../../../../utils/growth-delivery-monitor";
import { retryFailedGrowthEventDelivery } from "../../../../../../utils/growth-event-delivery";

export default defineEventHandler(async event => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const deliveryId = requireUuid(getRouterParam(event, "deliveryId") ?? "", "投递");
  const prisma = getPrisma();
  await readGrowthDelivery(prisma, { ownerId, characterId, deliveryId });
  const result = await retryFailedGrowthEventDelivery(prisma, deliveryId, new Date(), { ownerId, characterId });
  if (!result) throw createError({ statusCode: 409, statusMessage: "仅可恢复失败投递，状态可能已发生变化，请刷新后重试。" });
  return result;
});
