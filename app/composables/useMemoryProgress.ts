/**
 * 记忆任务的进度（忆泡整理 / 阶段总结）。
 *
 * 两个手动按钮都是在服务端请求里现跑，慢的时候几十秒到几分钟。进度**不能只活在
 * 那个请求的 loading 里**：切走页面、刷新一下，用户就再也看不到它跑到哪了。
 * 所以状态来源统一是数据库（`/api/memory-progress`），这里只负责轮询和共享。
 *
 * 轮询节奏按「这个状态还会不会自己变化」分档，不是有活任务就一律 2 秒：
 * - 忆泡整理分块提交，进度会一跳一跳地走，2 秒才看得出在动；
 * - 阶段总结是一次整段模型调用，中间没有任何可观测态，2 秒问一次问不出新东西；
 * - 排队 / 退避 / 租约过期没有任何东西在推进，问得再快也不会变，反而会一直刷；
 * - 闲着只为了接住调度器 / Worker 新排的任务，不需要很勤。
 * 后台标签页不轮询：没有人看的时候，每 2 秒一次只是白烧请求。
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
  /** Optional while older servers and cached responses are still in use. */
  runAt?: string;
  attemptCount?: number;
  maxAttempts?: number;
  leaseExpired: boolean;
  lastError: string | null;
};

/** Describe persisted retry scheduling, never infer Worker health from a waiting task. */
export function memoryRetryScheduleLabel(
  job: Pick<MemoryProgressRow, "runAt" | "attemptCount" | "maxAttempts">,
  now = Date.now(),
): string {
  const attempts = Number.isInteger(job.attemptCount) && Number.isInteger(job.maxAttempts)
    ? `已尝试 ${job.attemptCount}/${job.maxAttempts} 次；` : "";
  const runAt = job.runAt ? new Date(job.runAt).getTime() : NaN;
  if (!Number.isFinite(runAt)) return `${attempts}等待执行进程领取重试。`;
  const localTime = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(new Date(runAt));
  const schedule = `下次尝试 ${localTime}（本地时间）；`;
  return `${attempts}${schedule}${now - runAt >= 60_000
    ? "已到重试时间，尚未被领取。"
    : now >= runAt ? "已到重试时间，等待领取。" : "到点后等待执行进程领取。"}`;
}

export type MemoryJobFinished = {
  id: string;
  characterId: string;
  type: string;
  status: string;
  at: number;
};

const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "RETRY_WAIT"];
/** 忆泡整理：分块落库，`done/total` 会变。 */
export const MEMORY_PROGRESS_EVENT_POLL_MS = 2_000;
/** 阶段总结：一次模型调用，中间没有可观测状态，只要接住「跑完了」。 */
export const MEMORY_PROGRESS_SNAPSHOT_POLL_MS = 5_000;
/** 排队 / 退避等待 / 租约过期：没有进程领取之前不会自己变化。 */
export const MEMORY_PROGRESS_WAITING_POLL_MS = 10_000;
/** 闲着：只是为了接住调度器 / Worker 新排的任务。 */
export const MEMORY_PROGRESS_IDLE_POLL_MS = 15_000;

export function isActiveMemoryJob(status: string): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * 下一次轮询该等多久。
 *
 * 抽成纯函数是为了能单独测：这些数字以前直接拍在 `scheduleNext` 里，改一次只能开浏览器
 * 看网络面板才知道生效没有。`leaseExpired` 的 RUNNING 不算「在跑」——领走它的进程可能
 * 已经不在了，只有人去任务监控点重试才会变。
 */
export function memoryProgressPollDelay(
  jobs: Array<Pick<MemoryProgressRow, "type" | "status" | "leaseExpired">>,
): number {
  const running = jobs.filter((job) => job.status === "RUNNING" && !job.leaseExpired);
  if (running.some((job) => job.type === "EXTRACT_EVENTS")) return MEMORY_PROGRESS_EVENT_POLL_MS;
  if (running.length > 0) return MEMORY_PROGRESS_SNAPSHOT_POLL_MS;
  if (jobs.some((job) => isActiveMemoryJob(job.status))) return MEMORY_PROGRESS_WAITING_POLL_MS;
  return MEMORY_PROGRESS_IDLE_POLL_MS;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let inflight = false;
let visibilityBound = false;

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
  timer = null;
  /**
   * 后台标签页直接停表。回调在隐藏之后才到点的话，这里也会在下一次调度时停下，
   * 最多多跑一次；切回前台由 `visibilitychange` 立刻补一次并重新排表。
   */
  if (document.visibilityState === "hidden") return;
  const delay = memoryProgressPollDelay(progressState().jobs.value);
  timer = setTimeout(async () => {
    await refreshMemoryProgress();
    scheduleNext();
  }, delay);
}

function onVisibilityChange() {
  if (document.visibilityState === "hidden") return;
  if (!started) return;
  // 补一次「切回前台」的刷新，再按最新状态重新排表（scheduleNext 会清掉旧的定时器）。
  void refreshMemoryProgress().then(scheduleNext);
}

/** 只启动一次；多次调用（每个页面都会挂面板）不会叠加定时器，也不会重复挂监听。 */
export function ensureMemoryProgressPolling() {
  if (!import.meta.client || started) return;
  started = true;
  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  if (document.visibilityState === "hidden") return;
  void refreshMemoryProgress().then(scheduleNext);
}

export function useMemoryProgress() {
  return progressState();
}
