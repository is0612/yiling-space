import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../../utils/auth";
import { getPrisma } from "../../../../../utils/prisma";
import { requireUuid } from "../../../../../utils/local-api";
import { dropAliasesMatchingName, normalizeFriendAliases } from "../../../../../utils/friend-aliases";

/** 裁决保留终态行用于防重；同一关系的备注修改串行化，避免并发采纳丢失。 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "待审备注");
  const body = await readBody<{ approve?: unknown }>(event).catch(() => null);
  if (!body || typeof body.approve !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "approve 必须是布尔值。" });
  }
  const approve = body.approve;
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const target = await tx.friendAliasSuggestion.findUnique({ where: { id }, select: { scopeId: true } });
    if (!target) throw createError({ statusCode: 404, statusMessage: "这条待审备注不存在或已处理。" });
    await tx.$queryRaw`SELECT id FROM memory_scopes WHERE id = ${target.scopeId}::uuid FOR UPDATE`;
    const suggestion = await tx.friendAliasSuggestion.findUnique({
      where: { id },
      select: { alias: true, status: true, scope: { select: { scopeType: true, externalIdentityId: true, aliases: true, externalIdentity: { select: { displayName: true, platformUid: true } } } } },
    });
    if (!suggestion || suggestion.status !== "PENDING") {
      throw createError({ statusCode: 409, statusMessage: "这条待审备注已处理，请刷新列表。" });
    }
    if (suggestion.scope.scopeType !== "EXTERNAL_IDENTITY" || !suggestion.scope.externalIdentityId) {
      throw createError({ statusCode: 409, statusMessage: "这条备注没有有效的好友对象，不能采纳。" });
    }
    const previous = normalizeFriendAliases(suggestion.scope.aliases).aliases;
    const aliases = approve ? dropAliasesMatchingName(
      normalizeFriendAliases([...previous, suggestion.alias]).aliases,
      suggestion.scope.externalIdentity?.displayName || suggestion.scope.externalIdentity?.platformUid,
    ) : previous;
    if (approve) {
      const proposed = normalizeFriendAliases(suggestion.alias).aliases[0];
      if (!proposed || !aliases.some(alias => alias.toLowerCase() === proposed.toLowerCase())) {
        throw createError({ statusCode: 409, statusMessage: "该叫法与本名重复或备注已达上限，请先编辑已有备注。" });
      }
    }
    const status = approve ? "APPROVED" : "REJECTED";
    await tx.friendAliasSuggestion.update({ where: { id }, data: { status } });
    if (approve) await tx.memoryScope.update({ where: { id: target.scopeId }, data: { aliases } });
    return { id, status, aliases };
  });
});
