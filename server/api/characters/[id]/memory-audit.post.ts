import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { scanStaleMemories } from "../../../utils/stale-memory-audit";
import type { StaleKind } from "../../../utils/stale-memory-parse";

/**
 * 记忆体检：让模型提名「已经失效」的长期记忆 / 忆泡。
 *
 * 只读：不写任何状态。真正的清理走 `/memory-audit/apply`，必须由人勾选后提交。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event).catch(() => ({} as Record<string, unknown>));

  const rawScopes = Array.isArray(body?.scopes) ? body.scopes : ["MEMORY", "EVENT"];
  const scopes = [...new Set(rawScopes
    .filter((value): value is string => typeof value === "string")
    .map(value => value.toUpperCase())
    .filter((value): value is StaleKind => value === "MEMORY" || value === "EVENT"))];
  if (!scopes.length) throw createError({ statusCode: 400, statusMessage: "请选择要检查的范围。" });

  const dayKey = typeof body?.dayKey === "string" ? body.dayKey.trim() : "";
  if (dayKey && !/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) throw createError({ statusCode: 400, statusMessage: "日期格式应为 YYYY-MM-DD。" });
  const rangeDays = typeof body?.rangeDays === "number" && Number.isFinite(body.rangeDays)
    ? Math.min(90, Math.max(1, Math.round(body.rangeDays)))
    : undefined;

  return scanStaleMemories(getPrisma(), {
    ownerId,
    characterId,
    scopes,
    ...(dayKey ? { dayKey } : {}),
    ...(rangeDays ? { rangeDays } : {}),
  });
});
