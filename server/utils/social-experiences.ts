/**
 * 把忆泡经历挂到参与者各自的角色关系上。
 *
 * 忆泡正文只保留在 MemoryEvent；这里仅保存 EXTERNAL_IDENTITY 关系到事件的引用。
 * 账号必须同时匹配平台与平台 UID，绝不通过昵称、头像或语言风格归并。
 */

import { createHash } from "node:crypto";
import type { Prisma } from "../../src/generated/prisma/client";
import { readExternalParticipantRefs } from "./participant-names";
import { enqueueSocialRelationshipAssessment } from "./social-relationship-queue";
import { publishGrowthEvent } from "./growth-event-center";

export function buildSocialExperienceSourceKey(sourceMessageIds: readonly string[]): string | null {
  const ids = [...new Set(sourceMessageIds.map((id) => id.trim()).filter(Boolean))].sort();
  if (!ids.length) return null;
  return createHash("sha256").update(ids.join("\n")).digest("hex");
}

export async function linkMemoryEventToSocialExperiences(
  tx: Prisma.TransactionClient,
  input: {
    characterId: string;
    memoryEventId: string;
    participantRefs: unknown;
    sourceMessageIds: readonly string[];
  },
): Promise<number> {
  const source = await tx.memoryEvent.findFirst({
    where: { id: input.memoryEventId, memoryScope: { is: { characterId: input.characterId } } },
    select: { occurredAt: true },
  });
  if (!source) throw new Error("社交经历来源不存在或不属于当前角色。");

  const sourceKey = buildSocialExperienceSourceKey(input.sourceMessageIds);
  if (!sourceKey) return 0;

  const refs = readExternalParticipantRefs(input.participantRefs)
    .filter((ref) => ref.platform && ref.platform !== "unknown")
    .filter((ref, index, all) => all.findIndex((candidate) =>
      candidate.platform === ref.platform && candidate.externalId === ref.externalId,
    ) === index);
  if (!refs.length) return 0;

  const identities = await tx.externalIdentity.findMany({
    where: {
      OR: refs.map((ref) => ({ platform: ref.platform, platformUid: ref.externalId })),
    },
    select: {
      platform: true,
      platformUid: true,
      memoryScopes: {
        where: { characterId: input.characterId, scopeType: "EXTERNAL_IDENTITY" },
        select: { id: true },
      },
    },
  });

  const scopesByIdentity = new Map<string, string>();
  for (const identity of identities) {
    const key = identity.platform + ":" + identity.platformUid;
    const scope = identity.memoryScopes[0];
    if (scope) scopesByIdentity.set(key, scope.id);
  }

  const data = refs.flatMap((ref) => {
    const scopeId = scopesByIdentity.get(ref.platform + ":" + ref.externalId);
    return scopeId ? [{
      scopeId, memoryEventId: input.memoryEventId, sourceKey,
      assessmentDispatchStatus: "PENDING" as const,
    }] : [];
  }).sort((left, right) => left.scopeId.localeCompare(right.scopeId));
  if (!data.length) return 0;

  // 唯一键跳过的旧经历不发事件；新经历和 Outbox 在同一事务内提交。
  const created = await tx.socialExperience.createManyAndReturn({
    data,
    skipDuplicates: true,
    select: { id: true, scopeId: true },
  });
  for (const experience of created.sort((left, right) => left.id.localeCompare(right.id))) {
    await publishGrowthEvent(tx, {
      characterId: input.characterId,
      sourceDomain: "social",
      eventType: "social.experience.created",
      aggregateType: "SocialExperience",
      aggregateId: experience.id,
      occurredAt: source.occurredAt,
      idempotencyKey: `social.experience.created:${experience.id}`,
      payload: { sourceId: experience.id, sourceType: "SocialExperience" },
    });
  }
  return created.length;
}

/** 调用方必须处于投递确认事务中；状态标记、排队和投递确认一起提交或回滚。 */
export async function dispatchSocialExperienceAssessment(
  tx: Prisma.TransactionClient,
  input: { characterId: string; experienceId: string },
): Promise<{ queued: true } | { skipReason: string }> {
  const rows = await tx.$queryRaw<Array<{ scopeId: string }>>`
    UPDATE "social_experiences" AS experience
    SET "assessmentDispatchStatus" = 'QUEUED'::"SocialExperienceAssessmentDispatchStatus"
    FROM "memory_scopes" AS relation_scope, "memory_events" AS source,
         "memory_scopes" AS source_scope
    WHERE experience."id" = ${input.experienceId}::uuid
      AND experience."assessmentDispatchStatus" = 'PENDING'::"SocialExperienceAssessmentDispatchStatus"
      AND relation_scope."id" = experience."scopeId"
      AND relation_scope."scopeType" = 'EXTERNAL_IDENTITY'::"MemoryScopeType"
      AND relation_scope."characterId" = ${input.characterId}::uuid
      AND source."id" = experience."memoryEventId"
      AND source_scope."id" = source."memoryScopeId"
      AND source_scope."characterId" = ${input.characterId}::uuid
    RETURNING experience."scopeId"
  `;
  const row = rows[0];
  if (!row) return { skipReason: "社交经历已派发、沿用历史补偿，或来源不存在/不属于当前角色。" };
  // ARCHIVED 仍可追溯；结束派发责任，评估器仅选 ACTIVE 来源且不读取 PENDING。
  await enqueueSocialRelationshipAssessment(tx, { scopeId: row.scopeId, reason: "NEW_EXPERIENCE" });
  return { queued: true };
}
