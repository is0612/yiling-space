import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { auditLocalObserve, LocalObserveError, localObserveRoot, validateLocalRootPath } from "../../../utils/local-observe";
import { getPrisma } from "../../../utils/prisma";

const MAX_ROOTS = 20;

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const body = await readBody<{ path?: unknown; label?: unknown }>(event).catch(() => null);
  try {
    const path = validateLocalRootPath(body?.path);
    if (path.toLowerCase() === localObserveRoot().toLowerCase()) {
      throw new LocalObserveError(400, "项目目录已经是内置授权目录，不需要重复添加。");
    }
    const labelInput = typeof body?.label === "string" ? body.label.trim() : "";
    const label = (labelInput || path.split(/[\\/]/).filter(Boolean).pop() || path).slice(0, 100);
    const count = await getPrisma().localAccessRoot.count();
    if (count >= MAX_ROOTS) throw new LocalObserveError(400, `最多添加 ${MAX_ROOTS} 个授权目录。`);
    const root = await getPrisma().localAccessRoot.create({
      data: { path, label, mode: "READ_ONLY" },
    });
    auditLocalObserve(actor.user.id, "root.add", { rootId: root.id, path, label });
    return { root };
  } catch (error) {
    if (error instanceof LocalObserveError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    if ((error as { code?: string })?.code === "P2002") {
      throw createError({ statusCode: 409, statusMessage: "这个目录已经在授权列表里。" });
    }
    throw error;
  }
});
