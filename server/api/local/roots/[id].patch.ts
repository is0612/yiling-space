import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { auditLocalObserve, LocalObserveError } from "../../../utils/local-observe";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "缺少目录 ID。" });
  const body = await readBody<{ label?: unknown; enabled?: unknown }>(event).catch(() => null);
  const data: { label?: string; enabled?: boolean } = {};
  if (typeof body?.label === "string") {
    const label = body.label.trim();
    if (!label) throw createError({ statusCode: 400, statusMessage: "目录名称不能为空。" });
    data.label = label.slice(0, 100);
  }
  if (typeof body?.enabled === "boolean") data.enabled = body.enabled;
  if (!Object.keys(data).length) {
    throw createError({ statusCode: 400, statusMessage: "没有要修改的字段。" });
  }
  try {
    const root = await getPrisma().localAccessRoot.update({ where: { id }, data });
    auditLocalObserve(actor.user.id, "root.update", { rootId: root.id, ...data });
    return { root };
  } catch (error) {
    if ((error as { code?: string })?.code === "P2025") {
      throw createError({ statusCode: 404, statusMessage: "授权目录不存在。" });
    }
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
});
