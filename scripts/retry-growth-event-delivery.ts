import "dotenv/config";
import assert from "node:assert/strict";
import { getPrisma } from "../server/utils/prisma";
import { retryFailedGrowthEventDelivery } from "../server/utils/growth-event-delivery";

const deliveryId = (process.argv[2] ?? "").trim();
assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId),
  "用法：yarn growth:event:retry <FAILED 投递记录 UUID>");

const prisma = getPrisma();
try {
  const result = await retryFailedGrowthEventDelivery(prisma, deliveryId);
  if (!result) {
    console.error("没有恢复：投递记录不存在，或当前状态不是 FAILED。");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify({
      event: "growth-event-delivery-manually-requeued",
      ...result,
    }));
  }
} finally {
  await prisma.$disconnect();
}
