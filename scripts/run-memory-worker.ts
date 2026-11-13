import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { processNextMemoryJob } from "../server/utils/memory-worker";
import { cleanupGrowthEvents, processNextGrowthEventDelivery } from "../server/utils/growth-event-delivery";
import { GROWTH_EVENT_HANDLERS } from "../server/utils/growth-event-consumers";
import { createGrowthEventRunner, resolveGrowthEventIdleIntervalMs } from "../server/utils/growth-event-runner";
import { runSocialRelationshipQueueMaintenance } from "../server/utils/social-relationship-queue";
import { processNextSocialRelationshipAssessmentTask } from "../server/utils/social-relationship-assessment-ai";
import { processAutomaticInteractionExperience } from "../server/utils/interaction-experience-automatic";
import { processNextReflectionRun } from "../server/utils/reflection-worker";

const prisma = getPrisma();
const watch = process.argv.includes("--watch");
const intervalInput = Number(process.env.YILING_MEMORY_WORKER_INTERVAL_MS ?? 5_000);
const intervalMs = Number.isInteger(intervalInput) && intervalInput >= 1_000 ? intervalInput : 5_000;
const workerId = `memory-worker-${process.pid}-${randomUUID()}`;
let modelConfigurationWarningLogged = false;

function reportError(event: string, error: unknown) {
  process.stderr.write(JSON.stringify({
    at: new Date().toISOString(), event,
    error: error instanceof Error ? error.message : String(error),
  }) + "\n");
  if (!watch) process.exitCode = 1;
}

const runner = createGrowthEventRunner({
  processEvent: async () => {
    const result = await processNextGrowthEventDelivery(prisma, GROWTH_EVENT_HANDLERS, { workerId });
    if (result.processed) {
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "growth-event-delivery-processed", ...result }) + "\n");
    }
    return result;
  },
  cleanup: async batchSize => {
    const deleted = await cleanupGrowthEvents(prisma, { batchSize });
    if (deleted) {
      process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "growth-event-retention-cleaned", deleted }) + "\n");
    }
  },
  runLegacyRound: async signal => {
    if (signal.aborted) return;
    try {
      const socialQueue = await runSocialRelationshipQueueMaintenance(prisma);
      if (socialQueue.backfilled || socialQueue.periodicQueued || socialQueue.recoveredLeases || socialQueue.failedLeases) {
        process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "social-relationship-queue-maintained", ...socialQueue }) + "\n");
      }
    } catch (error) {
      reportError("social-relationship-queue-error", error);
    }
    if (signal.aborted) return;
    try {
      const socialAssessment = await processNextSocialRelationshipAssessmentTask(prisma, { workerId });
      if (socialAssessment.processed) {
        process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "social-relationship-assessment-processed", ...socialAssessment }) + "\n");
      }
    } catch (error) {
      reportError("social-relationship-assessment-error", error);
    }
    if (signal.aborted) return;
    try {
      const experience = await processAutomaticInteractionExperience(prisma);
      if (experience.processed) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "interaction-experience-processed", ...experience }) + "\n");
    } catch { reportError("interaction-experience-error", new Error("Automatic experience maintenance unavailable")); }
    if (signal.aborted) return;
    try {
      const reflection = await processNextReflectionRun(prisma, { workerId });
      if (reflection.processed) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "reflection-processed", ...reflection }) + "\n");
    } catch (error) {
      reportError("reflection-error", error);
    }
    if (signal.aborted) return;
    try {
      const result = await processNextMemoryJob(prisma, { workerId });
      if (result.processed) {
        process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n");
      } else if ((result.message.startsWith("尚未配置 AI 模型") || result.message.startsWith("待处理快照关联")) && !modelConfigurationWarningLogged) {
        process.stderr.write(JSON.stringify({ at: new Date().toISOString(), warning: result.message }) + "\n");
        modelConfigurationWarningLogged = true;
      }
    } catch (error) {
      reportError("memory-job-error", error);
    }
  },
  onError: (pipeline, error) => reportError(
    pipeline === "delivery" ? "growth-event-delivery-error"
      : pipeline === "cleanup" ? "growth-event-retention-error" : "memory-worker-round-error",
    error,
  ),
}, {
  watch,
  eventIdleMs: resolveGrowthEventIdleIntervalMs(process.env.YILING_GROWTH_EVENT_IDLE_INTERVAL_MS),
  legacyIdleMs: intervalMs,
});

const stop = () => runner.stop();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
try {
  await runner.run();
} finally {
  runner.stop();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await prisma.$disconnect();
}
