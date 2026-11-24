import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";

/** Serialize automatic event insertion with the settings API's disable-and-cancel transaction. */
export async function enqueueAutomaticEventJobs(
  prisma: PrismaClient,
  characterId: string,
  data: Prisma.MemoryJobCreateManyInput[],
): Promise<{ count: number }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "characterId" FROM "character_memory_settings" WHERE "characterId" = ${characterId}::uuid FOR UPDATE`;
    const setting = await tx.characterMemorySetting.findUnique({
      where: { characterId }, select: { autoSnapshotEnabled: true },
    });
    if (!setting?.autoSnapshotEnabled) return { count: 0 };
    return tx.memoryJob.createMany({ data, skipDuplicates: true });
  });
}
