import { createError, getRouterParam, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";
import { requireUuid } from "../../../utils/local-api";
import { assertFriendEducationOwner, readFriendEducationPatch } from "../../../utils/friend-education-permission";

const IDENTITY_KINDS = ["UNKNOWN", "HUMAN", "AI"] as const;
const CHAT_POLICIES = ["DEFAULT", "ALLOW", "BLOCK"] as const;

type IdentityKind = (typeof IDENTITY_KINDS)[number];
type FriendChatPolicy = (typeof CHAT_POLICIES)[number];

/**
 * 更新朋友身份和这段关系的交流权限。
 *
 * identityKind 写 ExternalIdentity：同一平台账号在所有角色里保持同一种身份；
 * friendChatPolicy 写 MemoryScope：每个角色可以独立决定是否与这个对象交流。
 */
export default defineEventHandler(async (event) => {
  const actor = await requireAdminActor(event);
  const scopeId = requireUuid(getRouterParam(event, "id") ?? "", "朋友关系");
  const body = await readBody<{ identityKind?: unknown; friendChatPolicy?: unknown; proactiveContactEnabled?: unknown; educationEnabled?: unknown; knowledgeCollectEnabled?: unknown }>(event).catch(() => null);
  if (!body) throw createError({ statusCode: 400, statusMessage: "请求内容无效。" });

  const hasIdentityKind = Object.prototype.hasOwnProperty.call(body, "identityKind");
  const hasPolicy = Object.prototype.hasOwnProperty.call(body, "friendChatPolicy");
  const hasProactiveContact = Object.prototype.hasOwnProperty.call(body, "proactiveContactEnabled");
  const educationEnabled = readFriendEducationPatch(body);
  const hasKnowledgeCollect = Object.prototype.hasOwnProperty.call(body, "knowledgeCollectEnabled");
  if (!hasIdentityKind && !hasPolicy && !hasProactiveContact && !hasKnowledgeCollect && educationEnabled === undefined) {
    throw createError({ statusCode: 400, statusMessage: "至少提供一个要修改的字段。" });
  }

  let identityKind: IdentityKind | undefined;
  let friendChatPolicy: FriendChatPolicy | undefined;
  let proactiveContactEnabled: boolean | undefined;
  let knowledgeCollectEnabled: boolean | undefined;
  if (hasIdentityKind) {
    if (typeof body.identityKind !== "string" || !(IDENTITY_KINDS as readonly string[]).includes(body.identityKind)) {
      throw createError({ statusCode: 400, statusMessage: "身份类型无效。" });
    }
    identityKind = body.identityKind as IdentityKind;
  }
  if (hasPolicy) {
    if (typeof body.friendChatPolicy !== "string" || !(CHAT_POLICIES as readonly string[]).includes(body.friendChatPolicy)) {
      throw createError({ statusCode: 400, statusMessage: "交流权限无效。" });
    }
    friendChatPolicy = body.friendChatPolicy as FriendChatPolicy;
  }
  if (hasProactiveContact) {
    if (typeof body.proactiveContactEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "主动联系授权必须是布尔值。" });
    }
    proactiveContactEnabled = body.proactiveContactEnabled;
  }
  if (body.knowledgeCollectEnabled !== undefined) {
    if (typeof body.knowledgeCollectEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "知识来源授权必须是布尔值。" });
    }
    knowledgeCollectEnabled = body.knowledgeCollectEnabled;
  }

  const prisma = getPrisma();
  const scope = await prisma.memoryScope.findUnique({
    where: { id: scopeId },
    select: {
      id: true,
      scopeType: true,
      friendChatPolicy: true,
      proactiveContactEnabled: true,
      educationEnabled: true,
      knowledgeCollectEnabled: true,
      characterId: true,
      character: { select: { ownerId: true } },
      externalIdentity: {
        select: { id: true, kind: true, kindSource: true },
      },
    },
  });
  if (!scope || scope.scopeType !== "EXTERNAL_IDENTITY" || !scope.externalIdentity) {
    throw createError({ statusCode: 404, statusMessage: "朋友关系不存在。" });
  }

  const result = await prisma.$transaction(async (tx) => {
    // Recheck owner within the write transaction; no identity/relationship mutation can grant authority.
    // 教育授权和知识来源授权都改「这个角色从这个人身上学什么」，同属角色主人才能签的权限，
    // 所以共用一次行锁与一次 owner 复核。
    if (educationEnabled !== undefined || knowledgeCollectEnabled !== undefined) {
      await tx.$queryRaw`SELECT "id" FROM "memory_scopes" WHERE "id" = ${scope.id}::uuid FOR UPDATE`;
      const owned = await tx.memoryScope.findFirst({
        where: { id: scope.id, character: { ownerId: actor.user.id } },
        select: { educationEnabled: true, knowledgeCollectEnabled: true },
      });
      if (!owned) throw createError({ statusCode: 403, statusMessage: "只有角色主人可以设置教育权限与知识来源。" });
      if (educationEnabled !== undefined) {
        assertFriendEducationOwner(actor.user.id, scope.character.ownerId);
        await tx.auditLog.create({ data: { actorType: "USER", actorId: actor.user.id, characterId: scope.characterId, action: "friend.education_permission_updated", entityType: "MemoryScope", entityId: scope.id, details: { before: owned.educationEnabled, after: educationEnabled } } });
      }
      if (knowledgeCollectEnabled !== undefined) {
        await tx.auditLog.create({ data: { actorType: "USER", actorId: actor.user.id, characterId: scope.characterId, action: "friend.knowledge_source_updated", entityType: "MemoryScope", entityId: scope.id, details: { before: owned.knowledgeCollectEnabled, after: knowledgeCollectEnabled } } });
      }
    }
    const identity = identityKind
      ? await tx.externalIdentity.update({
          where: { id: scope.externalIdentity!.id },
          data: { kind: identityKind, kindSource: "MANUAL" },
          select: { kind: true, kindSource: true },
        })
      : { kind: scope.externalIdentity!.kind, kindSource: scope.externalIdentity!.kindSource };
    const relationPatch = {
      ...(educationEnabled !== undefined ? { educationEnabled } : {}),
      ...(knowledgeCollectEnabled !== undefined ? { knowledgeCollectEnabled } : {}),
      ...(friendChatPolicy !== undefined ? { friendChatPolicy } : {}),
      ...(proactiveContactEnabled !== undefined ? { proactiveContactEnabled } : {}),
    };
    const relation = Object.keys(relationPatch).length
      ? await tx.memoryScope.update({
          where: { id: scope.id },
          data: relationPatch,
          select: { friendChatPolicy: true, proactiveContactEnabled: true, educationEnabled: true, knowledgeCollectEnabled: true },
        })
      : {
          educationEnabled: scope.educationEnabled,
          knowledgeCollectEnabled: scope.knowledgeCollectEnabled,
          friendChatPolicy: scope.friendChatPolicy,
          proactiveContactEnabled: scope.proactiveContactEnabled,
        };
    return { identity, relation };
  });

  // 只返回本次实际修改的字段。另一个维度可能被并发 PATCH 更新，
  // 返回事务外读取的旧值会让前端把刚保存成功的新设置覆盖回去。
  return {
    scopeId,
    ...(identityKind ? {
      identityKind: result.identity.kind,
      identityKindSource: result.identity.kindSource,
    } : {}),
    ...(friendChatPolicy !== undefined ? { friendChatPolicy: result.relation.friendChatPolicy } : {}),
    ...(educationEnabled !== undefined ? { educationEnabled: result.relation.educationEnabled } : {}),
    ...(knowledgeCollectEnabled !== undefined ? { knowledgeCollectEnabled: result.relation.knowledgeCollectEnabled } : {}),
    ...(proactiveContactEnabled !== undefined ? { proactiveContactEnabled: result.relation.proactiveContactEnabled } : {}),
  };
});
