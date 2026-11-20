import { createError, getQuery, setHeader } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { readGitDiff, readGitStatus } from "../../../utils/local-git";
import { auditLocalObserve, LocalObserveError, resolveObserveRoot } from "../../../utils/local-observe";

export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const { rootId, cwd = "", file, staged } = getQuery(event);
  if (typeof rootId !== "string" || !rootId || typeof cwd !== "string" || cwd.length > 500
    || (staged !== undefined && staged !== "0" && staged !== "1")
    || (file !== undefined && (typeof file !== "string" || !file || file.length > 500))) {
    throw createError({ statusCode: 400, statusMessage: "Git 查看参数无效。" });
  }
  setHeader(event, "Cache-Control", "no-store");
  try {
    const root = await resolveObserveRoot(rootId);
    const result = file === undefined ? readGitStatus(root.path, cwd) : readGitDiff(root.path, cwd, file, staged === "1");
    auditLocalObserve(actor.user.id, "git.inspect", { rootId, cwd, file, status: "ok" });
    return result;
  } catch (error) {
    auditLocalObserve(actor.user.id, "git.inspect", { rootId, cwd, file, status: "failed" });
    if (error instanceof LocalObserveError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
});
