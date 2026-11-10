import assert from "node:assert/strict";
import {
  createGrowthEventRunner,
  GROWTH_EVENT_CLEANUP_BATCH_SIZE,
  GROWTH_EVENT_CLEANUP_INTERVAL_MS,
  GROWTH_EVENT_DRAIN_BATCH_SIZE,
  resolveGrowthEventIdleIntervalMs,
  waitForGrowthEventRunner,
} from "../server/utils/growth-event-runner";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

assert.equal(resolveGrowthEventIdleIntervalMs(undefined), 5_000);
assert.equal(resolveGrowthEventIdleIntervalMs("1000"), 1_000);
for (const raw of ["0", "-1", "999", "60001", "NaN", "1.5"]) {
  assert.equal(resolveGrowthEventIdleIntervalMs(raw), 5_000);
}

// A blocked model/legacy round cannot stop event delivery or retention.
{
  const modelStarted = deferred();
  const releaseModel = deferred();
  const delivered = deferred();
  let claims = 0;
  let cleanups = 0;
  let modelFinished = false;
  const runner = createGrowthEventRunner({
    processEvent: async () => {
      claims += 1;
      if (claims === 2) delivered.resolve();
      return { processed: claims === 1 };
    },
    cleanup: async limit => { assert.equal(limit, 500); cleanups += 1; },
    runLegacyRound: async () => {
      modelStarted.resolve();
      await releaseModel.promise;
      modelFinished = true;
    },
    onError: (_pipeline, error) => { throw error; },
  }, { watch: true });
  const running = runner.run();
  await modelStarted.promise;
  await delivered.promise;
  assert.equal(modelFinished, false);
  assert.equal(cleanups, 1);
  runner.stop();
  let finished = false;
  void running.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false, "Shutdown must wait for the model task already in flight.");
  releaseModel.resolve();
  await running;
  assert.equal(modelFinished, true);
  assert.equal(claims, 2);
}

// Full batches keep draining without a five-second delay, while yielding between batches.
{
  let claims = 0;
  let active = 0;
  let maxActive = 0;
  let yields = 0;
  const runner = createGrowthEventRunner({
    processEvent: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      claims += 1;
      await Promise.resolve();
      active -= 1;
      if (claims === 45) runner.stop();
      return { processed: true };
    },
    cleanup: async () => {},
    runLegacyRound: async () => {},
    onError: (_pipeline, error) => { throw error; },
    wait: (ms, signal) => {
      if (ms === 0) { yields += 1; return waitForGrowthEventRunner(0, signal); }
      return waitForGrowthEventRunner(ms, signal);
    },
  }, { watch: true });
  await runner.run();
  assert.equal(claims, 45);
  assert.equal(yields, 2);
  assert.equal(maxActive, 1, "There must never be concurrent claims within the event pipeline.");
}

// Cleanup is one bounded batch per hour; failures in any pipeline do not stop the others.
{
  const errors: string[] = [];
  const wakeDelivery = deferred();
  const deliveryWaiting = deferred();
  const cleanupWaiting = deferred();
  const legacyWaiting = deferred();
  let claims = 0;
  let cleanupCalls = 0;
  let legacyCalls = 0;
  const waits: number[] = [];
  const runner = createGrowthEventRunner({
    processEvent: async () => {
      claims += 1;
      if (claims === 1) throw new Error("database temporarily unavailable");
      runner.stop();
      return { processed: true };
    },
    cleanup: async limit => {
      assert.equal(limit, GROWTH_EVENT_CLEANUP_BATCH_SIZE);
      cleanupCalls += 1;
      throw new Error("retention failed");
    },
    runLegacyRound: async () => { legacyCalls += 1; throw new Error("legacy failed"); },
    onError: (pipeline) => { errors.push(pipeline); },
    wait: (ms, signal) => {
      waits.push(ms);
      if (ms === 6_000) { deliveryWaiting.resolve(); return wakeDelivery.promise; }
      if (ms === GROWTH_EVENT_CLEANUP_INTERVAL_MS) cleanupWaiting.resolve();
      if (ms === 7_000) legacyWaiting.resolve();
      return waitForGrowthEventRunner(ms, signal);
    },
  }, { watch: true, eventIdleMs: 6_000, legacyIdleMs: 7_000 });
  const running = runner.run();
  await Promise.all([deliveryWaiting.promise, cleanupWaiting.promise, legacyWaiting.promise]);
  assert.deepEqual(errors.sort(), ["cleanup", "delivery", "legacy"]);
  assert.equal(cleanupCalls, 1);
  assert.equal(legacyCalls, 1);
  assert(waits.includes(GROWTH_EVENT_CLEANUP_INTERVAL_MS));
  wakeDelivery.resolve();
  await running;
  assert.equal(claims, 2);
}

// Stop during a database call completes that call but makes no further claims or rounds.
{
  const inFlight = deferred();
  const release = deferred();
  let claims = 0;
  let cleanups = 0;
  let rounds = 0;
  const runner = createGrowthEventRunner({
    processEvent: async () => {
      claims += 1;
      inFlight.resolve();
      await release.promise;
      return { processed: true };
    },
    cleanup: async () => { cleanups += 1; },
    runLegacyRound: async () => { rounds += 1; },
    onError: (_pipeline, error) => { throw error; },
  }, { watch: true });
  const running = runner.run();
  await inFlight.promise;
  runner.stop();
  const before = { claims, cleanups, rounds };
  release.resolve();
  await running;
  assert.deepEqual({ claims, cleanups, rounds }, before);
}

// Single-shot mode does one bounded event batch and exactly one legacy round, even on errors.
{
  const errors: string[] = [];
  let claims = 0;
  let cleanupCalls = 0;
  let legacyCalls = 0;
  await createGrowthEventRunner({
    processEvent: async () => { claims += 1; return { processed: true }; },
    cleanup: async () => { cleanupCalls += 1; throw new Error("cleanup"); },
    runLegacyRound: async () => { legacyCalls += 1; },
    onError: pipeline => { errors.push(pipeline); },
    wait: async () => { throw new Error("single shot must not create a wait timer"); },
  }, { watch: false }).run();
  assert.equal(claims, GROWTH_EVENT_DRAIN_BATCH_SIZE);
  assert.equal(cleanupCalls, 1);
  assert.equal(legacyCalls, 1);
  assert.deepEqual(errors, ["cleanup"]);
  claims = 0;
  legacyCalls = 0;
  await createGrowthEventRunner({
    processEvent: async () => { claims += 1; throw new Error("delivery"); },
    cleanup: async () => {},
    runLegacyRound: async () => { legacyCalls += 1; },
    onError: pipeline => { errors.push(pipeline); },
  }, { watch: false }).run();
  assert.equal(claims, 1);
  assert.equal(legacyCalls, 1);
  assert.deepEqual(errors, ["cleanup", "delivery"]);
}

// An already-stopped runner never calls dependencies, and stopping clears long wait timers.
{
  const unexpected = async () => { throw new Error("work started after shutdown"); };
  const runner = createGrowthEventRunner({
    processEvent: unexpected, cleanup: unexpected, runLegacyRound: unexpected,
    onError: (_pipeline, error) => { throw error; },
  }, { watch: true });
  runner.stop();
  await runner.run();
  const controller = new AbortController();
  const pending = waitForGrowthEventRunner(3_600_000, controller.signal);
  controller.abort();
  await pending;
  await waitForGrowthEventRunner(3_600_000, controller.signal);
}

console.log("Growth event runner: 7 scheduling/shutdown groups passed (no database or model calls).");
