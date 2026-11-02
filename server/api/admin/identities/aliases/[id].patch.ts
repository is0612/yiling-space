import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../../utils/auth";
import { getPrisma } from "../../../../utils/prisma";
import { requireUuid } from "../../../../utils/local-api";
import { dropAliasesMatchingName, normalizeFriendAliases } from "../../../../utils/friend-aliases";

/**
 * 保存「她私底下怎么叫这个人」。
 *
 * **这里的 id 是关系行（MemoryScope.id），不是 ExternalIdentity.id。**
 * 备注按「角色 × 人」存：同一个 QQ 号跟鱼、跟别的角色都聊过，就有两条关系、两套备注。
 * 这也是为什么不复用同目录下 `[id]/verify.post.ts` 那一套 —— 那些是账号级操作。
 *
 * 全量替换语义：页面每次提交的是这一栏完整的备注列表，不是增量。
 * 这样「删掉一个」「清空」都只需要一次请求，也不会出现并发追加导致的重复。
 *
 * 清洗和上限在 `friend-aliases.ts`：截断而不是整条拒绝，返回最终的 aliases 让页面
 * 直接拿它渲染 —— 用户看到的永远和库里一致。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const scopeId = requireUuid(getRouterParam(event, "id") ?? "", "朋友关系");

  // 区分「没传 aliases」和「传了空数组」：前者是调用方写错了，后者是用户清空备注。
  const body = await readBody<{ aliases?: unknown }>(event).catch(() => null);
  if (!body || !("aliases" in body)) {
    throw createError({ statusCode: 400, statusMessage: "缺少 aliases 字段。" });
  }

  const prisma = getPrisma();
  const scope = await prisma.memoryScope.findUnique({
    where: { id: scopeId },
    select: {
      scopeType: true,
      externalIdentity: { select: { displayName: true, platformUid: true } },
    },
  });
  if (!scope || scope.scopeType !== "EXTERNAL_IDENTITY" || !scope.externalIdentity) {
    throw createError({ statusCode: 404, statusMessage: "朋友关系不存在。" });
  }

  const normalized = normalizeFriendAliases(body.aliases);
  // 跟平台昵称一模一样的条目没有意义：提示词里会出现「本名叫小鱼干，私下叫小鱼干」。
  const aliases = dropAliasesMatchingName(
    normalized.aliases,
    scope.externalIdentity.displayName ?? scope.externalIdentity.platformUid,
  );

  const updated = await prisma.memoryScope.update({
    where: { id: scopeId },
    data: { aliases },
    select: { aliases: true },
  });

  return { scopeId, aliases: updated.aliases, dropped: normalized.dropped };
});
