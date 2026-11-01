import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { loadBiliConnections } from "../../../utils/channel-adapter/bili/configure";
import { runDutyRound } from "../../../utils/channel-adapter/bili/duty-pipeline";

/**
 * 手动触发一轮 B站值班（对应 bili-desk 的 POST /api/agent/run）。
 * 按 connectionId 找到连接，再按 bindingId（可选，缺省用第一个活动绑定）找到角色，
 * 调用 runDutyRound 跑完整流水线：找候选 → 模型判断 → 写报告 + 判重表。
 *
 * 注意：这一轮会真的调 bili CLI 和模型，耗时可能几十秒；前端应显示 loading。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<{ connectionId?: unknown; bindingId?: unknown }>(event);

  const connectionId = typeof body?.connectionId === "string" && body.connectionId.trim()
    ? body.connectionId.trim()
    : null;
  if (!connectionId) {
    throw createError({ statusCode: 400, statusMessage: "缺少连接 ID。" });
  }
  const bindingId = typeof body?.bindingId === "string" && body.bindingId.trim()
    ? body.bindingId.trim()
    : null;

  const connections = await loadBiliConnections();
  const connection = connections.find((c) => c.id === connectionId);
  if (!connection) {
    throw createError({ statusCode: 404, statusMessage: "找不到该 B站 连接。" });
  }
  if (connection.bindings.length === 0) {
    throw createError({ statusCode: 400, statusMessage: "该连接还没有绑定角色，请先在 B站值班台的账号卡片上绑定。" });
  }

  const binding = bindingId
    ? connection.bindings.find((b) => b.id === bindingId)
    : connection.bindings[0];
  if (!binding) {
    throw createError({ statusCode: 404, statusMessage: "找不到该绑定角色。" });
  }

  const started = Date.now();
  const result = await runDutyRound(connection, { id: binding.id, characterId: binding.characterId });
  const seconds = Math.round((Date.now() - started) / 10) / 100;

  return {
    ok: result.ok,
    seconds,
    picked: result.picked,
    skipped: result.skipped,
    seenVideos: result.seenVideos,
    reportId: result.reportId,
    error: result.error,
    // 过程记录要透出去：一条都没挑中时，前端要把「为什么」摆在人脸上，
    // 而不是只弹一句「挑中 0 条」让人对着报告猜。
    notes: result.notes,
  };
});
