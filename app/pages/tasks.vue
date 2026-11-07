<script setup lang="ts">
/**
 * 任务监控（后台任务）。
 *
 * 内容排序：① 有没有事要处理（失败/重试）② 任务清单 ③ 维护动作（扫描 / Worker）。
 * 一屏只有一个筛选入口：带计数的 chips（原来 KPI 四卡 + 状态下拉各筛一遍，两套控件说同一件事）。
 * 表格不用 el-table：六个字段用 CSS grid 排，行就是按钮 —— 点整行开详情，省掉「操作」列。
 */
import { ArrowRight, Cpu, Files, MagicStick, Refresh, Search, Warning } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "后台任务" },
});

type MemoryTask = {
  id: string;
  type: "GENERATE_SNAPSHOT" | "REGENERATE_SNAPSHOT" | "UPDATE_LONG_TERM_MEMORY" | "CLEAN_EXPIRED_MESSAGES" | "EXTRACT_EVENTS" | "GENERATE_JOURNAL";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "RETRY_WAIT" | "CANCELLED";
  attemptCount: number;
  maxAttempts: number;
  runAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  lastError: string | null;
  startedAt: string | null;
  /** 领取时间（租约起点）。运行中才有值。 */
  lockedAt: string | null;
  /** 服务端按 5 分钟租约算好的结论：运行中 + 已过期 = 没人在回收它。 */
  leaseExpired: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  characterId: string;
  characterName: string;
  cleanupResult: { deletedMessageCount: number | null; cutoff: string | null; recordedAt: string } | null;
};
type TaskListResponse = {
  items: MemoryTask[];
  total: number;
  allTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stuckCount: number;
  oldestStuckAt: string | null;
  statusCounts: Record<MemoryTask["status"], number>;
};
type WorkerResult = {
  processed: boolean;
  jobId?: string;
  status?: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED" | "CANCELLED";
  snapshotId?: string;
  message: string;
};
type SchedulerReport = {
  settingsChecked: number;
  settingsAdvanced: number;
  jobsQueued: number;
  periodsConsidered: number;
  missingGlobalScope: number;
  settingsStillDue: number;
  note: string;
};

const tasks = ref<MemoryTask[]>([]);
const totalTasks = ref(0);
const allTasksTotal = ref(0);
const currentPage = ref(1);
const pageSize = ref(20);
const totalPages = ref(1);
const stuckCount = ref(0);
const oldestStuckAt = ref<string | null>(null);
const requestVersion = ref(0);
const statusCounts = ref<Record<MemoryTask["status"], number>>({
  QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0, RETRY_WAIT: 0, CANCELLED: 0,
});
const query = ref("");
const statusFilter = ref("ALL");
const loading = ref(true);
const schedulerRunning = ref(false);
const workerRunning = ref(false);
const loadError = ref("");
const detailsOpen = ref(false);
const selectedTask = ref<MemoryTask | null>(null);
const taskActionLoading = ref(false);

const failedCount = computed(() => statusCounts.value.FAILED + statusCounts.value.RETRY_WAIT);
const hasFilters = computed(() => Boolean(query.value) || statusFilter.value !== "ALL");

/**
 * 「运行中」不等于「在跑」：租约 5 分钟没人续，就说明领走它的进程已经退出。
 * 这类任务没人会回收（回收要有人领任务），页面上必须单独指出来，否则只能靠看日志发现。
 */
function isStuck(task: MemoryTask) {
  return task.status === "RUNNING" && task.leaseExpired;
}


/** 计数和筛选合成一行：状态分布就是筛选条件，不需要再排一张 KPI。 */
const statusChips = computed(() => [
  { value: "ALL", label: "全部", count: allTasksTotal.value },
  { value: "QUEUED", label: "待执行", count: statusCounts.value.QUEUED },
  { value: "RUNNING", label: "运行中", count: statusCounts.value.RUNNING },
  { value: "SUCCEEDED", label: "成功", count: statusCounts.value.SUCCEEDED },
  { value: "ISSUES", label: "失败 / 待重试", count: failedCount.value, alert: failedCount.value > 0 },
  { value: "SKIPPED", label: "已跳过", count: statusCounts.value.SKIPPED },
  { value: "CANCELLED", label: "已取消", count: statusCounts.value.CANCELLED },
]);

function resetFilters() {
  query.value = "";
  statusFilter.value = "ALL";
  currentPage.value = 1;
  void loadTasks();
}

function setStatusFilter(value: string) {
  if (statusFilter.value === value && currentPage.value === 1) return;
  statusFilter.value = value;
  currentPage.value = 1;
  void loadTasks();
}

function changePage(value: number) {
  currentPage.value = value;
  void loadTasks();
}

function changePageSize(value: number) {
  pageSize.value = value;
  currentPage.value = 1;
  void loadTasks();
}

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, () => {
  currentPage.value = 1;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadTasks(), 300);
});


function taskTypeText(type: MemoryTask["type"]) {
  const names: Record<MemoryTask["type"], string> = {
    GENERATE_SNAPSHOT: "生成阶段总结",
    REGENERATE_SNAPSHOT: "重新生成总结",
    UPDATE_LONG_TERM_MEMORY: "长期记忆更新",
    CLEAN_EXPIRED_MESSAGES: "清理过期消息",
    EXTRACT_EVENTS: "整理忆泡",
    GENERATE_JOURNAL: "生成日记/手账",
  };
  return names[type] || type;
}

function statusText(status: MemoryTask["status"]) {
  const labels: Record<MemoryTask["status"], string> = {
    QUEUED: "等待执行",
    RUNNING: "运行中",
    SUCCEEDED: "执行成功",
    FAILED: "执行失败",
    SKIPPED: "已跳过",
    RETRY_WAIT: "等待重试",
    CANCELLED: "已取消",
  };
  return labels[status];
}

/** 卡住的运行中任务不写成「运行中」：那个词会让人以为有人正在处理。 */
function statusLabel(task: MemoryTask) {
  return isStuck(task) ? "运行中·卡住" : statusText(task.status);
}

function tone(task: MemoryTask) {
  if (isStuck(task)) return "pill-rose";
  if (task.status === "SUCCEEDED") return "pill-green";
  if (task.status === "FAILED") return "pill-rose";
  if (task.status === "QUEUED" || task.status === "RETRY_WAIT") return "pill-amber";
  if (task.status === "RUNNING") return "pill-blue";
  return "pill-gray";
}

/** 「3 小时前领走」这种人话；精确到分钟就够，卡住是按小时算的。 */
function sinceText(value: string | null) {
  if (!value) return "—";
  const started = new Date(value).getTime();
  if (Number.isNaN(started)) return "—";
  const minutes = Math.floor((Date.now() - started) / 60000);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} 天`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时`;
  return `${Math.max(1, minutes)} 分钟`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** 列表里用短格式：任务周期是周级的，年份进不了前 8 个字就别占宽度。 */
function formatShort(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function periodText(task: MemoryTask) {
  if (task.type === "CLEAN_EXPIRED_MESSAGES") {
    return task.periodEnd ? `早于 ${formatShort(task.periodEnd)} 的原始消息` : "未指定清理截止时间";
  }
  if (!task.periodStart || !task.periodEnd) return "未指定周期范围";
  return `${formatShort(task.periodStart)} → ${formatShort(task.periodEnd)}`;
}

/** 详情里给完整时间，列表里给短格式 —— 同一份数据两种精度。 */
function periodFull(task: MemoryTask) {
  if (task.type === "CLEAN_EXPIRED_MESSAGES") {
    return task.periodEnd ? `${formatDate(task.periodEnd)} 之前的原始消息` : "未指定清理截止时间";
  }
  if (!task.periodStart || !task.periodEnd) return "未指定周期范围";
  return `${formatDate(task.periodStart)} → ${formatDate(task.periodEnd)}`;
}

/** 只有清理任务有执行结果，单独成列时其余六行都是「—」，所以并进处理范围那一格。 */
function cleanupText(task: MemoryTask) {
  if (task.type !== "CLEAN_EXPIRED_MESSAGES") return "";
  if (task.cleanupResult) return `已删除 ${task.cleanupResult.deletedMessageCount ?? "未知"} 条`;
  return task.status === "SUCCEEDED" ? "审计记录暂不可用" : "";
}

function taskIssueTitle(task: MemoryTask) {
  if (task.status === "SKIPPED") return "跳过原因";
  if (task.status === "RETRY_WAIT") return "最近失败原因";
  if (task.status === "FAILED") return "失败原因";
  return "任务信息";
}

function taskStatusHint(task: MemoryTask) {
  if (task.status === "QUEUED") return "任务已进入持久化队列，等待 Worker 执行。";
  if (isStuck(task)) {
    return `Worker 最后一次续租在 ${sinceText(task.lockedAt)}前；租约连续 5 分钟没有续期，任务已可回收：`
      + "回收是「有人领任务时顺带做的」，本机没在跑 Worker 就一直不会发生。点「回收并重新入队」可以立刻放回队列。";
  }
  if (task.status === "RUNNING") return "Worker 正在执行该任务；较长的忆泡任务会在每次模型请求前续租，连续 5 分钟没有续期才算卡住。";
  if (task.status === "SUCCEEDED") return "任务已完成，没有记录错误。";
  if (task.status === "SKIPPED") return "该任务没有需要处理的活动，已按规则跳过。";
  if (task.status === "RETRY_WAIT") return "任务执行未成功，系统会在计划时间再次尝试。";
  if (task.status === "CANCELLED") return "任务已取消，历史记录与审计信息会保留。";
  return "该任务已失败，请查看失败原因并在必要时重新入队。";
}

async function loadTasks(allowPageCorrection = true) {
  const version = ++requestVersion.value;
  loading.value = true;
  loadError.value = "";
  try {
    const params = new URLSearchParams({
      page: String(currentPage.value),
      pageSize: String(pageSize.value),
    });
    if (statusFilter.value !== "ALL") params.set("status", statusFilter.value);
    if (query.value.trim()) params.set("q", query.value.trim());
    const result = await $fetch<TaskListResponse>("/api/tasks?" + params.toString());
    if (version !== requestVersion.value) return;
    // 操作任务后筛选结果可能缩小，当前页随之越界；只回退重查一次，避免空页锁死。
    if (allowPageCorrection && result.page > result.totalPages) {
      currentPage.value = result.totalPages;
      await loadTasks(false);
      return;
    }
    tasks.value = result.items;
    totalTasks.value = result.total;
    allTasksTotal.value = result.allTotal;
    currentPage.value = result.page;
    pageSize.value = result.pageSize;
    totalPages.value = result.totalPages;
    stuckCount.value = result.stuckCount;
    oldestStuckAt.value = result.oldestStuckAt;
    statusCounts.value = result.statusCounts;
  } catch (error) {
    if (version !== requestVersion.value) return;
    tasks.value = [];
    totalTasks.value = 0;
    totalPages.value = 1;
    stuckCount.value = 0;
    oldestStuckAt.value = null;
    statusCounts.value = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0, RETRY_WAIT: 0, CANCELLED: 0 };
    loadError.value = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "任务列表读取失败。";
    ElMessage.error("真实任务列表读取失败，请确认开发 API 已启用。");
  } finally {
    if (version === requestVersion.value) loading.value = false;
  }
}

async function runScheduler() {
  if (schedulerRunning.value) return;
  schedulerRunning.value = true;
  try {
    const report = await $fetch<SchedulerReport>("/api/tasks/scheduler/run", { method: "POST" });
    await loadTasks();
    if (report.jobsQueued > 0) {
      ElMessage.success(`扫描完成：排入 ${report.jobsQueued} 个周期任务，处理 ${report.periodsConsidered} 个到期周期。`);
    } else {
      ElMessage.info("扫描完成，目前没有新的到期周期任务。");
    }
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "扫描周期失败。";
    ElMessage.error(message);
  } finally {
    schedulerRunning.value = false;
  }
}

async function runWorker() {
  if (workerRunning.value) return;
  workerRunning.value = true;
  try {
    const result = await $fetch<WorkerResult>("/api/tasks/worker/run", { method: "POST" });
    await loadTasks();
    if (!result.processed) {
      ElMessage.info(result.message);
    } else if (result.status === "SUCCEEDED") {
      ElMessage.success(result.message || "任务执行完成。");
    } else if (result.status === "SKIPPED") {
      ElMessage.info(result.message || "该周期没有已保存活动，任务已跳过。");
    } else if (result.status === "CANCELLED") {
      ElMessage.info(result.message || "任务已取消。");
    } else {
      ElMessage.warning(result.message);
    }
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "执行任务失败。";
    ElMessage.error(message);
  } finally {
    workerRunning.value = false;
  }
}

/** 能不能重新入队 / 取消：模板里原来写了两串长条件，页脚那句提示也就跟着对不上了 */
const canRetry = computed(() => {
  const task = selectedTask.value;
  if (!task) return false;
  // 运行中的任务只在租约过期时放行 —— 没过期就抢，等于和还在写的 Worker 抢同一段数据。
  const statusOk = ["FAILED", "RETRY_WAIT", "CANCELLED"].includes(task.status) || isStuck(task);
  return statusOk
    && ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "CLEAN_EXPIRED_MESSAGES", "GENERATE_JOURNAL", "EXTRACT_EVENTS"].includes(task.type);
});
const canCancel = computed(() => !!selectedTask.value && ["QUEUED", "RETRY_WAIT"].includes(selectedTask.value.status));

async function copyTaskId(id: string) {
  try {
    await navigator.clipboard.writeText(id);
    ElMessage.success("已复制完整任务编号。");
  } catch {
    ElMessage.error("复制失败，请手动选择编号复制。");
  }
}

function openDetails(task: MemoryTask) {
  selectedTask.value = task;
  detailsOpen.value = true;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error && typeof error === "object" && "statusMessage" in error
    ? String(error.statusMessage)
    : error instanceof Error ? error.message : fallback;
}

async function retrySelectedTask() {
  const task = selectedTask.value;
  if (!task || taskActionLoading.value) return;
  const stuck = isStuck(task);
  try {
    await ElMessageBox.confirm(
      stuck
        ? `这条任务最后一次续租已是 ${sinceText(task.lockedAt)}前，租约早已过期。放回队列会重置尝试计数，接下来由 Worker 重新执行；审计记录会保留。`
        : "系统会清除本次任务的错误状态和尝试计数，并立即重新排队。历史审计记录会保留。",
      stuck ? "回收卡住的任务" : "重新入队任务",
      { confirmButtonText: stuck ? "回收并重新入队" : "重新入队", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  taskActionLoading.value = true;
  try {
    await $fetch(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { method: "POST" });
    await loadTasks();
    selectedTask.value = tasks.value.find((item) => item.id === task.id) ?? null;
    if (!selectedTask.value) {
      detailsOpen.value = false;
      ElMessage.info("任务已更新，并从当前筛选结果移出。");
    } else {
      ElMessage.success(stuck ? "任务已放回队列，等 Worker 跑一次就会执行。" : "任务已重新排队。");
    }
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "任务重新入队失败。"));
  } finally {
    taskActionLoading.value = false;
  }
}

async function cancelSelectedTask() {
  const task = selectedTask.value;
  if (!task || taskActionLoading.value) return;
  try {
    await ElMessageBox.confirm(
      "这会取消尚未开始执行的任务。运行中的任务不能被强制终止，已完成的历史记录不会删除。",
      "取消任务",
      { confirmButtonText: "确认取消", cancelButtonText: "保留任务", type: "warning" },
    );
  } catch {
    return;
  }

  taskActionLoading.value = true;
  try {
    await $fetch(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" });
    await loadTasks();
    selectedTask.value = tasks.value.find((item) => item.id === task.id) ?? null;
    if (!selectedTask.value) {
      detailsOpen.value = false;
      ElMessage.info("任务已取消，并从当前筛选结果移出。");
    } else {
      ElMessage.success("任务已取消，审计记录已保留。");
    }
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "取消任务失败。"));
  } finally {
    taskActionLoading.value = false;
  }
}

onMounted(() => void loadTasks());
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <div class="page-wrap tasks-a">
    <PageHeader
      eyebrow="系统管理 / 任务监控"
      description="持久化任务队列：扫描到期周期、手动跑一次 Worker，处理失败与待重试的任务。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadTasks()"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
        <button
          type="button"
          class="btn"
          :disabled="workerRunning"
          @click="runWorker"
        >
          <el-icon><Cpu /></el-icon>运行一次 Worker
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="schedulerRunning"
          @click="runScheduler"
        >
          <el-icon><MagicStick /></el-icon>扫描到期周期
        </button>
      </template>
    </PageHeader>

    <div
      v-if="loadError"
      class="notice err"
    >
      <el-icon><Warning /></el-icon>
      <span><strong>任务列表没读出来：</strong>{{ loadError }}</span>
    </div>

    <!-- 有失败时才提醒一次；正常的日子这行不该出现 -->
    <button
      v-if="failedCount > 0 && statusFilter !== 'ISSUES'"
      type="button"
      class="alert-row"
      @click="setStatusFilter('ISSUES')"
    >
      <el-icon><Warning /></el-icon>
      <span><strong>{{ failedCount }} 项失败或待重试</strong>，点这里只看它们。</span>
      <el-icon class="go">
        <ArrowRight />
      </el-icon>
    </button>

    <!-- 卡在「运行中」是另一种坏法：没有失败记录、队列里也没积压，只有这一行能看出来 -->
    <button
      v-if="stuckCount > 0 && statusFilter !== 'RUNNING'"
      type="button"
      class="alert-row"
      @click="setStatusFilter('RUNNING')"
    >
      <el-icon><Warning /></el-icon>
      <span>
        <strong>{{ stuckCount }} 条任务卡在「运行中」</strong>，租约已过期且尚未回收<template v-if="oldestStuckAt">，最早一次租约续期在 {{ sinceText(oldestStuckAt) }}前</template> —— 点这里只看它们。
      </span>
      <el-icon class="go">
        <ArrowRight />
      </el-icon>
    </button>

    <!-- 筛选条：计数 + 状态 + 搜索，一屏只有这一个入口 -->
    <div class="toolbar">
      <div class="chips">
        <button
          v-for="chip in statusChips"
          :key="chip.value"
          type="button"
          class="chip"
          :class="{ on: statusFilter === chip.value, 'is-alert': chip.alert && statusFilter !== chip.value }"
          @click="setStatusFilter(chip.value)"
        >
          {{ chip.label }}<span class="n">{{ chip.count }}</span>
        </button>
      </div>
      <div class="tools">
        <el-input
          v-model="query"
          class="search"
          clearable
          placeholder="搜索角色、任务类型或任务编号前缀"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <button
          v-if="hasFilters"
          type="button"
          class="reset"
          @click="resetFilters"
        >
          重置
        </button>
      </div>
    </div>

    <div class="tbl">
      <div class="tbl-head">
        <span>任务</span>
        <span>处理范围</span>
        <span>状态</span>
        <span class="num">尝试</span>
        <span class="time">最近活动</span>
        <span />
      </div>

      <div
        v-if="loading && !tasks.length"
        class="tbl-body"
      >
        <div
          v-for="i in 5"
          :key="'sk-' + i"
          class="tbl-row is-skeleton"
        >
          <span class="sk" />
        </div>
      </div>

      <div
        v-else-if="!tasks.length"
        class="tbl-empty"
      >
        <span class="empty-icon"><el-icon><Files /></el-icon></span>
        <h3>{{ hasFilters ? "没有匹配的任务" : "还没有任务记录" }}</h3>
        <p>
          {{ hasFilters
            ? "换个关键词，或者把状态筛选切回「全部」。"
            : "启用角色的自动归档并到达周期边界后，「扫描到期周期」会在这里排入任务。" }}
        </p>
        <button
          v-if="hasFilters"
          type="button"
          class="abtn"
          @click="resetFilters"
        >
          重置筛选
        </button>
      </div>

      <div
        v-else
        class="tbl-body"
      >
        <button
          v-for="task in tasks"
          :key="task.id"
          type="button"
          class="tbl-row"
          @click="openDetails(task)"
        >
          <span class="cell-task">
            <b>{{ taskTypeText(task.type) }}</b>
            <em :title="task.id">{{ task.characterName }} · #{{ task.id.slice(0, 8) }}</em>
          </span>
          <span class="cell-period">
            {{ periodText(task) }}
            <em v-if="cleanupText(task)">{{ cleanupText(task) }}</em>
          </span>
          <span>
            <span
              class="pill"
              :class="tone(task)"
              :title="isStuck(task) ? `最后一次续租在 ${sinceText(task.lockedAt)}前，租约已过期` : ''"
            >{{ statusLabel(task) }}</span>
          </span>
          <span class="num">{{ task.attemptCount }} / {{ task.maxAttempts }}</span>
          <span class="time">{{ formatShort(task.updatedAt) }}</span>
          <span class="chev"><el-icon><ArrowRight /></el-icon></span>
        </button>
      </div>
    </div>

    <div
      v-if="totalTasks > 0"
      class="pagination-bar"
    >
      <span class="pagination-summary">
        第 {{ (currentPage - 1) * pageSize + 1 }}–{{ Math.min(currentPage * pageSize, totalTasks) }} 条，共 {{ totalTasks }} 条
        <template v-if="hasFilters">（当前为筛选结果）</template>
      </span>
      <el-pagination
        :current-page="currentPage"
        :page-size="pageSize"
        :page-sizes="[20, 50, 100]"
        :total="totalTasks"
        :disabled="loading"
        background
        layout="sizes, prev, pager, next"
        @current-change="changePage"
        @size-change="changePageSize"
      />
    </div>

    <p class="footer-note">
      任务由独立 Worker 消费（「yarn worker:watch」）——没有它在跑，任务只会停在队列里，卡住的任务也没人回收。
      生成总结与长期记忆会调用服务端配置的模型；重新入队与清理结果都会保留审计记录。
    </p>

    <el-dialog
      v-model="detailsOpen"
      title="任务详情"
      width="min(600px, 94vw)"
    >
      <template v-if="selectedTask">
        <div class="d-head">
          <h3>{{ taskTypeText(selectedTask.type) }}</h3>
          <span
            class="pill"
            :class="tone(selectedTask)"
          >{{ statusLabel(selectedTask) }}</span>
        </div>
        <p class="d-sub">
          {{ selectedTask.characterName }}
          <span class="sep">·</span>
          <code :title="selectedTask.id">#{{ selectedTask.id.slice(0, 8) }}</code>
          <button
            type="button"
            class="copy-id"
            @click.stop="copyTaskId(selectedTask.id)"
          >
            复制完整编号
          </button>
        </p>

        <p class="d-period">
          {{ periodFull(selectedTask) }}
        </p>

        <dl class="d-grid">
          <div>
            <dt>尝试次数</dt>
            <dd>{{ selectedTask.attemptCount }} / {{ selectedTask.maxAttempts }}</dd>
          </div>
          <div>
            <dt>计划执行</dt>
            <dd>{{ formatDate(selectedTask.runAt) }}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{{ formatDate(selectedTask.startedAt) }}</dd>
          </div>
          <div v-if="selectedTask.lockedAt">
            <dt>最近租约更新时间</dt>
            <dd>
              {{ formatDate(selectedTask.lockedAt) }}
              <span
                v-if="selectedTask.leaseExpired"
                class="lease-expired"
              >已过期</span>
            </dd>
          </div>
          <div>
            <dt>完成时间</dt>
            <dd>{{ formatDate(selectedTask.completedAt) }}</dd>
          </div>
          <div>
            <dt>创建时间</dt>
            <dd>{{ formatDate(selectedTask.createdAt) }}</dd>
          </div>
          <div v-if="selectedTask.type === 'CLEAN_EXPIRED_MESSAGES'">
            <dt>清理结果</dt>
            <dd>
              {{ selectedTask.cleanupResult
                ? `已删除 ${selectedTask.cleanupResult.deletedMessageCount ?? "未知"} 条原始消息`
                : selectedTask.status === "SUCCEEDED" ? "未找到对应审计记录" : "尚无成功清理记录" }}
            </dd>
          </div>
        </dl>

        <div
          v-if="selectedTask.lastError"
          class="d-error"
        >
          <strong>{{ taskIssueTitle(selectedTask) }}</strong>
          <p>{{ selectedTask.lastError }}</p>
        </div>
        <p
          v-else
          class="d-hint"
        >
          {{ taskStatusHint(selectedTask) }}
        </p>
      </template>

      <template #footer>
        <div class="d-foot">
          <span class="d-foot-note">
            {{ canRetry
              ? (selectedTask && isStuck(selectedTask) ? "回收会把租约过期的那条任务放回队列" : "重新入队会清掉错误状态与尝试计数")
              : canCancel ? "只能取消尚未开始执行的任务" : "" }}
          </span>
          <span class="d-foot-actions">
            <el-button
              v-if="canRetry"
              :loading="taskActionLoading"
              @click="retrySelectedTask"
            >
              <el-icon><Refresh /></el-icon>{{ selectedTask && isStuck(selectedTask) ? "回收并重新入队" : "重新入队" }}
            </el-button>
            <el-button
              v-if="canCancel"
              :loading="taskActionLoading"
              @click="cancelSelectedTask"
            >
              取消任务
            </el-button>
            <el-button @click="detailsOpen = false">
              关闭
            </el-button>
          </span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览 / QQ 渠道的 A 套：白砖、零描边、零阴影，层次靠明度差与间距。
   全部规则挂在 .tasks-a 下（作用域 + 压过 main.css 的单类规则）。
   ══════════════════════════════════════════════════════════════ */

/* 页头按钮：次要动作是纯文字，hover 才出下划线；唯一主操作实心 */
.tasks-a .btn { height: 36px; border: 0; background: none; box-shadow: none; padding: 0 10px; color: var(--text-2); border-radius: 8px; }
.tasks-a .btn:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
.tasks-a .btn.primary { background: var(--brand-btn); padding: 0 14px; color: #fff; }
.tasks-a .btn.primary:hover { background: var(--brand-btn-h); color: #fff; text-decoration: none; }

/* 失败提醒：整行可点，是页面上唯一的暖色块 */
.alert-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: var(--sp-3);
  border: 0;
  border-radius: 8px;
  background: var(--red-soft);
  padding: 10px 14px;
  color: #8c2434;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background .14s var(--ease);
}
.alert-row:hover { background: #fbe0e4; }
.alert-row .el-icon { flex: none; font-size: 14px; }
.alert-row strong { font-weight: 700; }
.alert-row .go { margin-left: auto; }

/* 筛选条：chips 左、搜索右；窄屏换行 */
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
/* chips 默认带描边、无计数位；这里去掉描边、给计数留一点静音位。
   ⚠️ main.css 的 `.chip.on` 是「深底 + 白字」，而 `.chips .chip` 的浅底一样是 (0,2,0)
   且加载更晚 —— 只写浅底会把选中态压成「白底白字」。所以选中态必须整组重写。 */
.chips .chip { border-color: transparent; background: var(--surface); }
.chips .chip:hover { border-color: transparent; background: var(--surface-3); }
.chips .chip.on {
  border-color: transparent;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-weight: 700;
}
.chips .chip.is-alert { color: var(--red); }
.chips .chip.is-alert .n { color: var(--red); }
.chips .chip .n { margin-left: 5px; font-variant-numeric: tabular-nums; opacity: .55; }
.chips .chip.on .n { color: var(--brand-strong); opacity: .7; }

.tools { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.pagination-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 14px; }
.pagination-summary { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.pagination-bar :deep(.el-pagination) { justify-content: flex-end; }
@media (max-width: 720px) {
  .pagination-bar { align-items: flex-start; flex-direction: column; }
  .pagination-bar :deep(.el-pagination) { max-width: 100%; flex-wrap: wrap; justify-content: flex-start; }
}
.search { width: 240px; }
.reset { border: 0; background: none; padding: 0 4px; color: var(--brand-strong); font-size: 12px; font-weight: 600; cursor: pointer; }
.reset:hover { text-decoration: underline; }

/* ── 表格：CSS grid 行，整行是按钮 ─────────────────── */
.tbl {
  border-radius: 10px;
  background: var(--surface);
  padding: 4px 8px 6px;
}
/* 列宽：任务 1.5、范围 1.4，其余按内容定宽 —— 状态药丸和「1 / 3」不该被拉伸。
   状态列留 104px：「运行中·卡住」比「运行中」多三个字，压到 92px 就会被挤成两行 */
.tbl-head,
.tbl-row {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1.4fr) 104px 60px 96px 20px;
  gap: 12px;
  align-items: center;
}
.tbl-head {
  border-bottom: 1px solid var(--surface-3);
  padding: 10px 10px 9px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
}
.tbl-head .num,
.tbl-head .time { text-align: left; }
.tbl-body { display: flex; flex-direction: column; }

/* 行是按钮：键盘可达，hover 用软底，不加分隔线（间距已足够分块） */
.tbl-row {
  width: 100%;
  border: 0;
  border-radius: 8px;
  background: none;
  padding: 10px;
  color: var(--text-2);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
  transition: background .13s var(--ease);
}
.tbl-row:hover { background: var(--surface-2); }
.tbl-row:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.tbl-row.is-skeleton { display: block; padding: 14px 10px; cursor: default; }
.tbl-row.is-skeleton .sk { display: block; height: 14px; border-radius: 5px; }

.cell-task { min-width: 0; }
.cell-task b { display: block; color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.4; }
/* 角色 + 编号：二级信息，12px 静音，不跟任务名抢 */
.cell-task em,
.cell-period em {
  display: block;
  margin-top: 2px;
  color: var(--dim);
  font-size: 12px;
  font-style: normal;
  line-height: 1.5;
}
.cell-period { min-width: 0; line-height: 1.4; overflow-wrap: anywhere; }
.num { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.time { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.chev { display: flex; justify-content: flex-end; color: var(--faint); font-size: 14px; }
.tbl-row:hover .chev { color: var(--brand); }

/* 空态：白砖里居中，一行说明 + 可选的重置 */
.tbl-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44px 24px 48px;
  text-align: center;
}
.tbl-empty .empty-icon {
  display: grid;
  width: 44px;
  height: 44px;
  margin-bottom: 12px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20px;
}
.tbl-empty h3 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.tbl-empty p { max-width: 440px; margin: 8px 0 14px; color: var(--dim); font-size: 14px; line-height: 1.75; }

.abtn {
  display: inline-flex;
  height: 32px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 0 12px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.abtn:hover { background: var(--brand-soft); color: var(--brand-strong); }

/* ── 详情弹窗 ─────────────────────────────────────── */
.d-head { display: flex; align-items: center; gap: 10px; }
.d-head h3 { margin: 0; color: var(--text); font-size: 18px; font-weight: 700; line-height: 1.4; }
.d-sub { margin: 5px 0 0; color: var(--dim); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.d-sub .sep { margin: 0 5px; color: var(--faint); }
.d-sub code { border-radius: 4px; background: var(--surface-3); padding: 1px 5px; color: var(--text-2); font-family: ui-monospace, Consolas, monospace; font-size: 12px; user-select: all; }
/* 「复制完整编号」：和编号同行的轻量文字按钮 —— 浏览器默认按钮（灰底 + outset 边框）
   会在这行里凸出来一块，所以边框/底色全部清掉，只在 hover 时给下划线。 */
.copy-id {
  margin-left: 6px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.6;
  cursor: pointer;
}
.copy-id:hover { text-decoration: underline; text-underline-offset: 3px; }
.copy-id:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 3px; }
.d-period {
  margin: 14px 0 0;
  border-radius: 8px;
  background: var(--surface-2);
  padding: 9px 12px;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.6;
}

/* 五个时间字段两列排：一列十行太长，两列一眼扫完 */
.d-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px 24px;
  margin: 16px 0 0;
}
.d-grid dt { color: var(--dim); font-size: 12px; }
.d-grid dd { margin: 3px 0 0; color: var(--text-2); font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
/* 租约过期是这一格唯一需要红的信息：它解释「为什么这条任务没人管」 */
.d-grid dd .lease-expired { margin-left: 6px; color: var(--red); font-size: 12px; font-weight: 700; }

.d-error {
  margin-top: 16px;
  border-radius: 8px;
  background: var(--red-soft);
  padding: 11px 14px;
  color: #8c2434;
  font-size: 12px;
  line-height: 1.75;
}
.d-error strong { display: block; margin-bottom: 4px; font-weight: 700; }
.d-error p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.d-hint { margin: 16px 0 0; color: var(--dim); font-size: 12px; line-height: 1.75; }

.d-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.d-foot-note { color: var(--dim); font-size: 12px; text-align: left; }
.d-foot-actions { display: flex; }

/* ── 自适应 ───────────────────────────────────────── */
@media (max-width: 1000px) {
  /* 少掉「最近活动」和箭头，剩下的三列还读得通 */
  .tbl-head,
  .tbl-row { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.2fr) 104px 56px; }
  .tbl-head .time,
  .tbl-row .time,
  .tbl-head span:nth-child(6),
  .tbl-row .chev { display: none; }
}
@media (max-width: 720px) {
  .search { width: 100%; }
  .tools { width: 100%; margin-left: 0; }
  /* 窄屏一行放不下四个字段：任务 + 状态一行，范围和时间退到下面 */
  .tbl-head { display: none; }
  /* 显式给区域：自动排布会把「状态」顺延到第二行、贴着处理范围，看着像放错地方 */
  .tbl-row {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "task status"
      "period period";
    gap: 6px 10px;
    padding: 12px 10px;
    align-items: start;
  }
  .cell-task { grid-area: task; }
  .tbl-row > span:nth-child(3) { grid-area: status; justify-self: end; align-self: center; }
  .cell-period { grid-area: period; }
  .tbl-row .num,
  .tbl-row .chev { display: none; }
  .d-grid { grid-template-columns: minmax(0, 1fr); }
  .d-foot { flex-direction: column-reverse; align-items: stretch; }
  .d-foot-actions { justify-content: flex-end; }
  .d-foot-note { text-align: center; }
}
</style>
