/**
 * 记忆任务的进度（忆泡整理 / 阶段总结）。
 *
 * 两个手动按钮都是在服务端请求里现跑，慢的时候几十秒到几分钟。进度**不能只活在
 * 那个请求的 loading 里**：切走页面、刷新一下，用户就再也看不到它跑到哪了。
 * 所以状态来源统一是数据库（`/api/memory-progress`），这里只负责轮询和共享。
 *
 * 轮询节奏：有活任务 2 秒一次，闲时 10 秒一次 —— 闲着的时候一次轮询只有一条
 * 「有没有在跑的任务」查询，代价可以忽略，但能自动接住调度器/worker 起的那一批。
 */

export type MemoryProgressRow = {
  id: string;
  type: "GENERATE_SNAPSHOT" | "EXTRACT_EVENTS";
  status: string;
  characterId: string;
  characterName: string;
  label: string;
  done: number | null;
  total: number | null;
  eventCount: number | null;
  startedAt: string | null;
  updatedAt: string;
  leaseExpired: boolean;
  lastError: string | null;
};

export type MemoryJobFinished = {
  id: string;
  characterId: string;
  type: string;
  status: string;
  at: number;
};

const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "RETRY_WAIT"];
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 10_000;

export function isActiveMemoryJob(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let inflight = false;

function progressState() {
  return {
    jobs: useState<MemoryProgressRow[]>("memory-progress-jobs", () => []),
    lastFinished: useState<MemoryJobFinished | null>("memory-progress-last-finished", () => null),
    checkedAt: useState<string | null>("memory-progress-checked-at", () => null),
  };
}

export async function refreshMemoryProgress(): Promise<MemoryProgressRow[]> {
  if (!import.meta.client || inflight) return progressState().jobs.value;
  const { jobs, lastFinished, checkedAt } = progressState();
  inflight = true;
  try {
    const result = await $fetch<{ jobs: MemoryProgressRow[]; checkedAt: string }>("/api/memory-progress");
    // 「上一轮还在跑、这一轮结束了」是唯一的完成信号：面板据此标一次完成，页面据此刷新列表。
    const wasActive = new Set(jobs.value.filter((job) => isActiveMemoryJob(job.status)).map((job) => job.id));
    jobs.value = result.jobs;
    checkedAt.value = result.checkedAt;
    const finished = result.jobs.find((job) => wasActive.has(job.id) && !isActiveMemoryJob(job.status));
    if (finished) {
      lastFinished.value = {
        id: finished.id,
        characterId: finished.characterId,
        type: finished.type,
        status: finished.status,
        at: Date.now(),
      };
    }
  } catch {
    // 进度面板不是关键路径：接口一时失败就保持上一次的数据，不弹错。
  } finally {
    inflight = false;
  }
  return jobs.value;
}

function scheduleNext() {
  if (!import.meta.client) return;
  if (timer) clearTimeout(timer);
  const active = progressState().jobs.value.some((job) => isActiveMemoryJob(job.status));
  timer = setTimeout(async () => {
    await refreshMemoryProgress();
    scheduleNext();
  }, active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
}

/** 只启动一次；多次调用（每个页面都会挂面板）不会叠加定时器。 */
export function ensureMemoryProgressPolling() {
  if (!import.meta.client || started) return;
  started = true;
  void refreshMemoryProgress().then(scheduleNext);
}

export function useMemoryProgress() {
  return progressState();
}
