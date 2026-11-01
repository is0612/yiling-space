import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const connectionId = requireUuid(getRouterParam(event, "id") ?? "", "渠道连接");

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { id: true },
  });
  if (!connection) throw createError({ statusCode: 404, statusMessage: "渠道连接不存在。" });

  await prisma.platformConnection.delete({ where: { id: connectionId } });
  return { deleted: true };
});
