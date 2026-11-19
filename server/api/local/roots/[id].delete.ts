import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { auditLocalObserve } from "../../../utils/local-observe";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少目录 ID。" });
  try {
    const root = await getPrisma().localAccessRoot.delete({ where: { id } });
    auditLocalObserve(actor.user.id, "root.delete", { rootId: root.id, path: root.path });
    return { ok: true, root };
  } catch (error) {
    if ((error as { code?: string })?.code === "P2025") {
      throw createError({ statusCode: 404, statusMessage: "授权目录不存在。" });
    }
    throw error;
  }
});
