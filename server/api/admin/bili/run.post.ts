import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { runBili } from "../../../utils/channel-adapter/bili/runner";
import { findBiliCatalogItem } from "../../../utils/channel-adapter/bili/catalog";

/**
 * 执行一条 bili 命令（对应 bili-desk 的 /api/run）。前端已拼好 argv，这里负责：
 *   - 安全校验：拒绝空命令；写操作（write=true）强制只允许带 --dry-run，除非显式确认。
 *   - 调 runBili 执行，把 code/json/stdout/stderr/elapsed 原样返回。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<{ argv?: unknown; itemId?: unknown; allowWrite?: unknown }>(event);

  const argv = Array.isArray(body?.argv)
    ? body.argv.filter((a): a is string => typeof a === "string" && a.trim() !== "")
    : [];
  if (argv.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "空命令。" });
  }

  // 写操作防护：若命令是写操作且未显式确认，确保末尾带 --dry-run。
  const itemId = typeof body?.itemId === "string" ? body.itemId : null;
  const item = itemId ? findBiliCatalogItem(itemId) : null;
  const isWrite = Boolean(item?.write);
  const allowWrite = body?.allowWrite === true;
  if (isWrite && !allowWrite && !argv.includes("--dry-run")) {
    argv.push("--dry-run");
  }

  const result = await runBili(argv, { timeoutMs: 240_000 });
  return {
    code: result.code,
    json: result.json,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsed: result.elapsed,
    argv: result.argv,
    timedOut: result.timedOut,
  };
});
