<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ensureMemoryProgressPolling,
  isActiveMemoryJob,
  refreshMemoryProgress,
  useMemoryProgress,
  type MemoryProgressRow,
} from "~/composables/useMemoryProgress";

/**
 * 记忆任务进度（右下角常驻）。
 *
 * 为什么放在 AppShell 而不是记忆页：任务本身在服务端跑，切页面不会让它停下来，
 * 进度也不该跟着页面消失。这里读的是 `/api/memory-progress`，和任务行同一个真相。
 *
 * 两类任务的进度口径不同：
 * - 忆泡整理分块提交，`已处理对话 / 这一段总数` 是真实比例；
 * - 阶段总结是一次模型调用，没有中间态 —— 只给不确定进度条和已用时，不编百分比。
 */

const { jobs } = useMemoryProgress();
const isActive = isActiveMemoryJob;

const now = ref(Date.now());
/** 只看「本次亲眼看到结束」的任务；页面刚打开时摆一堆历史完成态没有意义。 */
const finishedAt = ref(new Map<string, number>());
/** 成功一闪而过没关系；失败 8 秒就消失，用户只会觉得「怎么没反应」，然后去点重试。 */
const FINISHED_VISIBLE_MS = 8_000;
const FAILED_VISIBLE_MS = 60_000;
let ticker: ReturnType<typeof setInterval> | null = null;

watch(jobs, (next, previous) => {
  const wasActive = new Set((previous ?? []).filter((job) => isActive(job.status)).map((job) => job.id));
  const nextFinished = new Map(finishedAt.value);
  for (const job of next) {
    if (wasActive.has(job.id) && !isActive(job.status)) nextFinished.set(job.id, Date.now());
  }
  finishedAt.value = nextFinished;
});

const visible = computed(() => jobs.value.filter((job) => {
  if (isActive(job.status)) return true;
  const finished = finishedAt.value.get(job.id);
  if (!finished) return false;
  return now.value - finished < (job.status === "FAILED" ? FAILED_VISIBLE_MS : FINISHED_VISIBLE_MS);
}));

const hasActive = computed(() => visible.value.some((job) => isActive(job.status)));

/**
 * 读屏播报只报「状态变了」，不报每秒都在跳的已用时 ——
 * 整块 `aria-live` 挂在列表上会每秒念一遍，等于噪音。
 */
const announcement = computed(() => visible.value
  .filter((job) => !isActive(job.status) || job.leaseExpired)
  .map((job) => `${job.label} ${statusLabel(job)}`)
  .join("；"));

onMounted(() => {
  ensureMemoryProgressPolling();
  void refreshMemoryProgress();
  ticker = setInterval(() => { now.value = Date.now(); }, 1_000);
});

onUnmounted(() => {
  if (ticker) clearInterval(ticker);
});

function elapsedSeconds(job: MemoryProgressRow): number {
  const from = new Date(job.startedAt ?? job.updatedAt).getTime();
  if (!Number.isFinite(from)) return 0;
  return Math.max(0, Math.round((now.value - from) / 1000));
}

function elapsedLabel(job: MemoryProgressRow): string {
  const seconds = elapsedSeconds(job);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function statusLabel(job: MemoryProgressRow): string {
  switch (job.status) {
    case "QUEUED": return "排队中";
    case "RETRY_WAIT": return "等待重试";
    case "RUNNING": return job.leaseExpired ? "可能卡住" : "进行中";
    case "SUCCEEDED": return "已完成";
    case "SKIPPED": return "已完成";
    case "FAILED": return "失败";
    case "CANCELLED": return "已取消";
    default: return job.status;
  }
}

function tone(job: MemoryProgressRow): string {
  if (job.status === "FAILED" || job.leaseExpired) return "is-bad";
  if (job.status === "RETRY_WAIT") return "is-warn";
  if (!isActive(job.status)) return job.status === "CANCELLED" ? "is-muted" : "is-good";
  return "is-active";
}

/** 有真实比例才画确定进度条；其余用不确定动画，绝不假装知道百分比。 */
function percent(job: MemoryProgressRow): number | null {
  if (job.done !== null && job.total) return Math.min(100, Math.round((job.done / job.total) * 100));
  // 跑完了就把条填满：刚成功的那一刻条子突然消失，看起来像出错了。
  if (job.status === "SUCCEEDED" || job.status === "SKIPPED") return 100;
  return null;
}

function detail(job: MemoryProgressRow): string {
  const elapsed = elapsedLabel(job);
  if (job.status === "RUNNING" && job.leaseExpired) {
    return "超过 5 分钟没有动静，去任务监控重试即可从断点接着跑。";
  }
  if (job.status === "FAILED") return job.lastError ?? "任务失败，可在任务监控里重试。";
  if (!isActive(job.status)) return `用时 ${elapsed}`;
  if (job.status === "QUEUED") {
    /**
     * 排队超过一分钟还不动，多半是整机没有 Worker 在跑：手动按钮排完任务会当场执行，
     * 但「任务监控里点重试」只把状态改成 QUEUED，没有任何进程领取它。
     * 不说破的话，用户看到的就是一个永远「已排队」、接口还每 2 秒问一次的面板。
     */
    return elapsedSeconds(job) >= 60
      ? `已排队 ${elapsed}，还没有执行进程领取；需要有 Worker 在跑（本地：yarn worker:watch）才会开始。`
      : "已排队，等执行进程领取。";
  }
  /**
   * 退避等待里「正在提炼」是假的：上一次调用已经失败了，正在等下一次。
   * 这一支以前会显示成「正在分块提炼 · 用时 3 分钟」，看不出是在重试。
   * 也不能说「已完成的部分不会重跑」—— 阶段总结是一次调用，重试就是整段重来。
   */
  if (job.status === "RETRY_WAIT") {
    const reason = job.lastError ? `上次失败：${job.lastError.slice(0, 120)}；` : "";
    const redo = job.type === "EXTRACT_EVENTS" ? "已经落库的分块不会重跑。" : "整段总结会重新调用一次模型。";
    return `${reason}${redo}到点后由 Worker 领取重试；本地没跑 Worker 时不会自己开始。`;
  }
  if (job.type === "EXTRACT_EVENTS") {
    if (job.done !== null && job.total !== null) {
      const events = job.eventCount ? `，已写入 ${job.eventCount} 条忆泡` : "";
      return `${job.done} / ${job.total} 条对话${events} · ${elapsed}`;
    }
    return `正在分块提炼 · ${elapsed}`;
  }
  return `调模型提炼整段对话 · ${elapsed}`;
}
</script>

<template>
  <aside
    v-if="visible.length"
    class="memory-progress"
    :class="{ 'is-idle': !hasActive }"
  >
    <p
      class="sr-only"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
    <header class="progress-head">
      <strong>记忆任务</strong>
      <NuxtLink
        to="/tasks"
        class="progress-link"
      >
        任务监控
      </NuxtLink>
    </header>
    <ul class="progress-list">
      <li
        v-for="job in visible"
        :key="job.id"
        class="progress-row"
        :class="tone(job)"
      >
        <div class="progress-title">
          <span class="progress-name">{{ job.label }}</span>
          <span class="progress-status">{{ statusLabel(job) }}</span>
        </div>
        <div
          class="progress-bar"
          :class="{ 'is-indeterminate': isActive(job.status) && percent(job) === null }"
          role="progressbar"
          :aria-valuenow="percent(job) ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <span
            v-if="percent(job) !== null"
            class="progress-fill"
            :style="{ width: (percent(job) ?? 0) + '%' }"
          />
          <span
            v-else-if="isActive(job.status)"
            class="progress-fill is-sweeping"
          />
        </div>
        <p class="progress-detail">
          {{ detail(job) }}
        </p>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.memory-progress {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 40;
  width: 320px;
  max-height: 60vh;
  overflow: auto;
  padding: 12px 14px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 14px 32px rgba(16, 22, 32, 0.14);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* 窄屏：别让 320px 的面板顶出屏幕右侧。 */
@media (max-width: 720px) {
  .memory-progress {
    right: 10px;
    bottom: 10px;
    width: auto;
    left: 10px;
    max-height: 45vh;
  }
}

.progress-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--text);
}

.progress-link {
  font-size: 12px;
  color: var(--dim);
  text-decoration: none;
}

.progress-link:hover {
  color: var(--brand-strong);
}

.progress-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.progress-row {
  display: grid;
  gap: 5px;
}

.progress-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 14px;
}

.progress-name {
  color: var(--text);
  font-weight: 600;
  line-height: 1.4;
}

.progress-status {
  flex: none;
  font-size: 12px;
  color: var(--dim);
}

.is-active .progress-status {
  color: var(--brand-strong);
}

.is-warn .progress-status {
  color: var(--amber);
}

.is-good .progress-status {
  color: var(--green);
}

.is-bad .progress-status {
  color: var(--red);
}

.progress-bar {
  position: relative;
  height: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--line);
}

.progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: var(--grad-brand);
  transition: width 0.4s var(--ease);
}

.is-good .progress-fill {
  background: var(--green);
}

.is-bad .progress-fill {
  background: var(--red);
}

.is-warn .progress-fill {
  background: var(--amber);
}

.progress-bar.is-indeterminate .progress-fill.is-sweeping {
  width: 40%;
  animation: progress-sweep 1.4s var(--ease) infinite;
}

@keyframes progress-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

.progress-detail {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dim);
}

@media (prefers-reduced-motion: reduce) {
  .progress-bar.is-indeterminate .progress-fill.is-sweeping {
    animation: none;
    width: 100%;
    opacity: 0.4;
  }
}
</style>
