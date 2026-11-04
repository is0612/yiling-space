import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { isMemoryModelConfigured } from "./memory-ai";

/** Bound each read, not the entire scan: a fixed total cap would starve later characters again. */
const CANDIDATE_BATCH_SIZE = 100;

/** Read-only selection. Unconfigured characters keep every job and attempt unchanged. */
export async function readConfiguredMemoryJobCandidates(
  prisma: Pick<PrismaClient, "memoryJob">,
  now: Date,
  ownership: Prisma.MemoryJobWhereInput,
) {
  const excludedCharacterIds = new Set<string>();
  let hasUnconfiguredCandidates = false;
  for (;;) {
    const candidates = await prisma.memoryJob.findMany({
      where: {
        type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "EXTRACT_EVENTS", "GENERATE_JOURNAL"] },
        status: { in: ["QUEUED", "RETRY_WAIT"] },
        runAt: { lte: now },
        // AND preserves the caller's ownership relation filter instead of replacing it.
        AND: [ownership, ...(excludedCharacterIds.size > 0
          ? [{ memoryScope: { is: { characterId: { notIn: [...excludedCharacterIds] } } } }]
          : [])],
      },
      orderBy: [{ runAt: "asc" }, { periodEnd: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: CANDIDATE_BATCH_SIZE,
      select: {
        id: true,
        type: true,
        status: true,
        attemptCount: true,
        maxAttempts: true,
        memoryScope: { select: { characterId: true, character: { select: { modelConfig: true } } } },
      },
    });
    const configuredCandidates = candidates.filter((candidate) => {
      // Keep the shared predicate (including provider-safe global environment fallback).
      if (isMemoryModelConfigured(candidate.memoryScope.character.modelConfig)) return true;
      excludedCharacterIds.add(candidate.memoryScope.characterId);
      hasUnconfiguredCandidates = true;
      return false;
    });
    if (configuredCandidates.length > 0 || candidates.length < CANDIDATE_BATCH_SIZE) {
      return { configuredCandidates, hasUnconfiguredCandidates };
    }
    // Every full unconfigured page excludes at least one new character, across all scopes.
    // No offset/cursor reset or process-local rotation: a finite queue always makes progress,
    // even if one character owns thousands of older jobs. Recheck configuration next run.
  }
}
