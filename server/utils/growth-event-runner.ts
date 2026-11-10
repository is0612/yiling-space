export const GROWTH_EVENT_DRAIN_BATCH_SIZE = 20;
export const GROWTH_EVENT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
export const GROWTH_EVENT_CLEANUP_BATCH_SIZE = 500;

export function resolveGrowthEventIdleIntervalMs(raw: string | undefined): number {
  const value = Number(raw ?? 5_000);
  return Number.isInteger(value) && value >= 1_000 && value <= 60_000 ? value : 5_000;
}

/** A stop wakes waits and clears their timers; in-flight database work is allowed to finish. */
export function waitForGrowthEventRunner(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export type GrowthEventRunnerDependencies = {
  processEvent: () => Promise<{ processed: boolean }>;
  cleanup: (batchSize: number) => Promise<void>;
  runLegacyRound: (signal: AbortSignal) => Promise<void>;
  onError: (pipeline: "delivery" | "cleanup" | "legacy", error: unknown) => void;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};

/**
 * Scheduling only: the database remains the sole source of deliveries.
 * Each pipeline is serial; watch pipelines run independently of one another.
 */
export function createGrowthEventRunner(
  dependencies: GrowthEventRunnerDependencies,
  options: { watch: boolean; eventIdleMs?: number; legacyIdleMs?: number },
): { stop: () => void; run: () => Promise<void>; signal: AbortSignal } {
  const controller = new AbortController();
  const signal = controller.signal;
  const wait = dependencies.wait ?? waitForGrowthEventRunner;
  const eventIdleMs = resolveGrowthEventIdleIntervalMs(String(options.eventIdleMs ?? 5_000));
  const legacyIdleMs = options.legacyIdleMs ?? 5_000;

  async function drain(): Promise<boolean> {
    try {
      for (let index = 0; index < GROWTH_EVENT_DRAIN_BATCH_SIZE && !signal.aborted; index += 1) {
        const result = await dependencies.processEvent();
        if (!result.processed) return false;
      }
      return true;
    } catch (error) {
      dependencies.onError("delivery", error);
      return false; // A broken database must not cause an immediate retry spin.
    }
  }

  async function clean(): Promise<void> {
    if (signal.aborted) return;
    try {
      await dependencies.cleanup(GROWTH_EVENT_CLEANUP_BATCH_SIZE);
    } catch (error) {
      dependencies.onError("cleanup", error);
    }
  }

  async function legacy(): Promise<void> {
    if (signal.aborted) return;
    try {
      await dependencies.runLegacyRound(signal);
    } catch (error) {
      dependencies.onError("legacy", error);
    }
  }

  async function run(): Promise<void> {
    if (!options.watch) {
      await clean();
      if (!signal.aborted) await drain();
      await legacy();
      return;
    }
    await Promise.all([
      (async () => {
        while (!signal.aborted) {
          const fullBatch = await drain();
          // Even a busy queue yields to timers/signals between bounded batches.
          if (!signal.aborted) await wait(fullBatch ? 0 : eventIdleMs, signal);
        }
      })(),
      (async () => {
        while (!signal.aborted) {
          await clean();
          if (!signal.aborted) await wait(GROWTH_EVENT_CLEANUP_INTERVAL_MS, signal);
        }
      })(),
      (async () => {
        while (!signal.aborted) {
          await legacy();
          if (!signal.aborted) await wait(legacyIdleMs, signal);
        }
      })(),
    ]);
  }

  return { stop: () => controller.abort(), run, signal };
}
