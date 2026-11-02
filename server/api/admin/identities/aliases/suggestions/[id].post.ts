import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../../utils/auth";
import { getPrisma } from "../../../../../utils/prisma";
import { requireUuid } from "../../../../../utils/local-api";
import { dropAliasesMatchingName } from "../../../../../utils/friend-aliases";

/**
 * 裁决一条待审备注：`approve: true` 写入 `MemoryScope.aliases`，`false` 标记 REJECTED。
 *
 * 同意 = 把这条叫法追加进她已有的备注列表，再按既有口径归一化（去重、去本名、上限）。
 * 拒绝 = 只改状态、不删行 —— `aliasKey` 唯一约束挡着，删了它下个周期又会被提回来。
 * 不接受把 REJECTED 改回 PENDING：没有哪个界面需要「重新变回待确认」，多一条路径只会多一种坏状态。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "待审备注");
  const body = await readBody<{ approve?: unknown }>(event).catch(() => null);
  if (!body || typeof body.approve !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "approve 必须是布尔值。" });
  }

  const prisma = getPrisma();
  const suggestion = await prisma.friendAliasSuggestion.findUnique({
    where: { id },
    select: {
      id: true,
      scopeId: true,
      alias: true,
      status: true,
      scope: {
        select: {
          aliases: true,
          externalIdentity: { select: { displayName: true, platformUid: true } },
        },
      },
    },
  });
  if (!suggestion || suggestion.status !== "PENDING") {
    throw createError({ statusCode: 404, statusMessage: "这条待审备注不存在或已处理。" });
  }

  const aliases = body.approve
    ? dropAliasesMatchingName(
        [...suggestion.scope.aliases, suggestion.alias],
        suggestion.scope.externalIdentity?.displayName ?? suggestion.scope.externalIdentity?.platformUid,
      )
    : suggestion.scope.aliases;

  await prisma.$transaction(async (tx) => {
    await tx.friendAliasSuggestion.update({
      where: { id },
      data: { status: body.approve ? "APPROVED" : "REJECTED" },
    });
    if (body.approve) {
      await tx.memoryScope.update({ where: { id: suggestion.scopeId }, data: { aliases } });
    }
  });

  return { id, status: body.approve ? "APPROVED" : "REJECTED", aliases };
});
