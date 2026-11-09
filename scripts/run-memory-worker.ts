import "dotenv/config";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../server/utils/prisma";
import { processNextMemoryJob } from "../server/utils/memory-worker";
import { runSocialRelationshipQueueMaintenance } from "../server/utils/social-relationship-queue";
import { processNextSocialRelationshipAssessmentTask } from "../server/utils/social-relationship-assessment-ai";

const prisma = getPrisma();
const watch = process.argv.includes("--watch");
const intervalInput = Number(process.env.YILING_MEMORY_WORKER_INTERVAL_MS ?? 5_000);
const intervalMs = Number.isInteger(intervalInput) && intervalInput >= 1_000 ? intervalInput : 5_000;
const workerId = `memory-worker-${process.pid}-${randomUUID()}`;
let running = true;
let modelConfigurationWarningLogged = false;

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

try {
  do {
    try {
      const socialQueue = await runSocialRelationshipQueueMaintenance(prisma);
      if (socialQueue.backfilled || socialQueue.periodicQueued || socialQueue.recoveredLeases || socialQueue.failedLeases) {
        process.stdout.write(JSON.stringify({
          at: new Date().toISOString(),
          event: "social-relationship-queue-maintained",
          ...socialQueue,
        }) + "\n");
      }
    } catch (error) {
      // 社交队列维护故障不能阻断现有记忆任务。
      process.stderr.write(JSON.stringify({
        at: new Date().toISOString(),
        event: "social-relationship-queue-error",
        error: error instanceof Error ? error.message : String(error),
      }) + "\n");
      if (!watch) process.exitCode = 1;
    }

    try {
      const socialAssessment = await processNextSocialRelationshipAssessmentTask(prisma, { workerId });
      if (socialAssessment.processed) {
        process.stdout.write(JSON.stringify({
          at: new Date().toISOString(),
          event: "social-relationship-assessment-processed",
          ...socialAssessment,
        }) + "\n");
      }
    } catch (error) {
      process.stderr.write(JSON.stringify({
        at: new Date().toISOString(),
        event: "social-relationship-assessment-error",
        error: error instanceof Error ? error.message : String(error),
      }) + "\n");
      if (!watch) process.exitCode = 1;
    }

    try {
      const result = await processNextMemoryJob(prisma, { workerId });
      if (result.processed) {
        process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n");
      } else if ((result.message.startsWith("尚未配置 AI 模型") || result.message.startsWith("待处理快照关联")) && !modelConfigurationWarningLogged) {
        process.stderr.write(JSON.stringify({ at: new Date().toISOString(), warning: result.message }) + "\n");
        modelConfigurationWarningLogged = true;
      }
    } catch (error) {
      process.stderr.write(JSON.stringify({
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }) + "\n");
      if (!watch) process.exitCode = 1;
    }
    if (!watch || !running) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (running);
} finally {
  await prisma.$disconnect();
}
