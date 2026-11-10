import type { Prisma } from "../../src/generated/prisma/client";

/** 社交领域对外仅暴露引用及派发状态，不复制忆泡正文。 */
export type SocialExperienceReference = {
  id: string;
  characterId: string;
  scopeId: string;
  memoryEventId: string;
  sourceStatus: "ACTIVE" | "ARCHIVED";
  dispatchStatus: "LEGACY" | "PENDING" | "QUEUED";
};

export async function readSocialExperienceReference(
  tx: Prisma.TransactionClient,
  characterId: string,
  experienceId: string,
): Promise<SocialExperienceReference | null> {
  const row = await tx.socialExperience.findFirst({
    where: {
      id: experienceId,
      scope: { is: { characterId, scopeType: "EXTERNAL_IDENTITY" } },
      memoryEvent: { is: { memoryScope: { is: { characterId } } } },
    },
    select: {
      id: true, scopeId: true, memoryEventId: true, assessmentDispatchStatus: true,
      memoryEvent: { select: { status: true } },
    },
  });
  return row ? {
    id: row.id, characterId, scopeId: row.scopeId, memoryEventId: row.memoryEventId,
    sourceStatus: row.memoryEvent.status, dispatchStatus: row.assessmentDispatchStatus,
  } : null;
}
