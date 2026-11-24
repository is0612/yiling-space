import { createError, defineEventHandler, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { applyStaleMemories } from "../../../../utils/stale-memory-apply";
import { requireStaleFingerprint } from "../../../../utils/stale-memory-version";
import type { StaleKind } from "../../../../utils/stale-memory-parse";

const MAX_ITEMS = 200;

/**
 * 应用记忆体检结果：勾选的长期记忆标为失效，勾选的忆泡归档。
 *
 * 锁后复验 ACTIVE、可见范围与扫描指纹；任一候选已变化就整批拒绝，避免部分确认或覆盖新内容。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  if (!body || !Array.isArray(body.items)) throw createError({ statusCode: 400, statusMessage: "缺少要清理的条目。" });
  if (body.items.length > MAX_ITEMS) throw createError({ statusCode: 400, statusMessage: `一次最多清理 ${MAX_ITEMS} 条。` });

  const items: Array<{ kind: StaleKind; id: string; fingerprint: string; reason?: string }> = [];
  const seen = new Set<string>();
  for (const value of body.items) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw createError({ statusCode: 400, statusMessage: "条目格式无效。" });
    const row = value as Record<string, unknown>;
    const kind = typeof row.kind === "string" ? row.kind.toUpperCase() : "";
    if (kind !== "MEMORY" && kind !== "EVENT") throw createError({ statusCode: 400, statusMessage: "条目类型无效。" });
    const id = requireUuid(typeof row.id === "string" ? row.id : "", kind === "MEMORY" ? "长期记忆" : "忆泡").toLowerCase();
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = typeof row.reason === "string" ? row.reason.trim().slice(0, 200) : "";
    let fingerprint: string;
    try { fingerprint = requireStaleFingerprint(row.fingerprint); }
    catch { throw createError({ statusCode: 400, statusMessage: "条目缺少有效的体检版本，请重新体检。" }); }
    items.push({ kind, id, fingerprint, ...(reason ? { reason } : {}) });
  }
  if (!items.length) throw createError({ statusCode: 400, statusMessage: "没有可清理的条目。" });

  return applyStaleMemories(getPrisma(), { ownerId, characterId, items });
});
