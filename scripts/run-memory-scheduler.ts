import "dotenv/config";
import { getPrisma } from "../server/utils/prisma";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";

const prisma = getPrisma();
const watch = process.argv.includes("--watch");
const intervalInput = Number(process.env.YILING_MEMORY_SCHEDULER_INTERVAL_MS ?? 60_000);
const intervalMs = Number.isInteger(intervalInput) && intervalInput >= 5_000 ? intervalInput : 60_000;
let running = true;

process.on("SIGINT", () => { running = false; });
process.on("SIGTERM", () => { running = false; });

try {
  do {
    const at = new Date().toISOString();
    try {
      const report = await enqueueDueMemorySnapshots(prisma);
      process.stdout.write(JSON.stringify({ at, ...report }) + "\n");
    } catch (error) {
      process.stderr.write(JSON.stringify({
        at,
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
