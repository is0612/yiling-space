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
    return scopeId ? [{ scopeId, memoryEventId: input.memoryEventId, sourceKey }] : [];
  });
  if (!data.length) return 0;

  // 只对真正新插入的经历触发队列；重复提炼被唯一约束跳过时，不增加 generation。
  const created = await tx.socialExperience.createManyAndReturn({
    data,
    skipDuplicates: true,
    select: { scopeId: true },
  });
  for (const scopeId of new Set(created.map((row) => row.scopeId))) {
    await enqueueSocialRelationshipAssessment(tx, {
      scopeId,
      reason: "NEW_EXPERIENCE",
    });
  }
  return created.length;
}
