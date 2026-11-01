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

/** 计数和筛选合成一行：状态分布就是筛选条件，不需要再排一张 KPI。 */
const statusChips = computed(() => [
  { value: "ALL", label: "全部", count: totalTasks.value },
  { value: "QUEUED", label: "待执行", count: statusCounts.value.QUEUED },
  { value: "RUNNING", label: "运行中", count: statusCounts.value.RUNNING },
  { value: "SUCCEEDED", label: "成功", count: statusCounts.value.SUCCEEDED },
  { value: "ISSUES", label: "失败 / 待重试", count: failedCount.value, alert: failedCount.value > 0 },
  { value: "SKIPPED", label: "已跳过", count: statusCounts.value.SKIPPED },
  { value: "CANCELLED", label: "已取消", count: statusCounts.value.CANCELLED },
]);

const filtered = computed(() => tasks.value.filter((task) => {
  const text = [task.id, task.characterName, task.characterId, taskTypeText(task.type)].join(" ").toLowerCase();
  const queryMatches = !query.value || text.includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "ALL"
    ? true
    : statusFilter.value === "ISSUES"
      ? task.status === "FAILED" || task.status === "RETRY_WAIT"
      : task.status === statusFilter.value;
  return queryMatches && statusMatches;
}));

function resetFilters() {
  query.value = "";
  statusFilter.value = "ALL";
}

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

function tone(status: MemoryTask["status"]) {
  if (status === "SUCCEEDED") return "pill-green";
  if (status === "FAILED") return "pill-rose";
  if (status === "QUEUED" || status === "RETRY_WAIT") return "pill-amber";
  if (status === "RUNNING") return "pill-blue";
  return "pill-gray";
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
  if (task.status === "RUNNING") return "Worker 正在执行该任务。";
  if (task.status === "SUCCEEDED") return "任务已完成，没有记录错误。";
  if (task.status === "SKIPPED") return "该任务没有需要处理的活动，已按规则跳过。";
  if (task.status === "RETRY_WAIT") return "任务执行未成功，系统会在计划时间再次尝试。";
  if (task.status === "CANCELLED") return "任务已取消，历史记录与审计信息会保留。";
  return "该任务已失败，请查看失败原因并在必要时重新入队。";
}

async function loadTasks() {
  loading.value = true;
  loadError.value = "";
  try {
    const result = await $fetch<TaskListResponse>("/api/tasks?limit=100");
    tasks.value = result.items;
    totalTasks.value = result.total;
    statusCounts.value = result.statusCounts;
  } catch (error) {
    tasks.value = [];
    totalTasks.value = 0;
    statusCounts.value = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0, RETRY_WAIT: 0, CANCELLED: 0 };
    loadError.value = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "任务列表读取失败。";
    ElMessage.error("真实任务列表读取失败，请确认开发 API 已启用。");
  } finally {
    loading.value = false;
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
  return !!task
    && ["FAILED", "RETRY_WAIT", "CANCELLED"].includes(task.status)
    && ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "CLEAN_EXPIRED_MESSAGES", "GENERATE_JOURNAL"].includes(task.type);
});
const canCancel = computed(() => !!selectedTask.value && ["QUEUED", "RETRY_WAIT"].includes(selectedTask.value.status));

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
  try {
    await ElMessageBox.confirm(
      "系统会清除本次任务的错误状态和尝试计数，并立即重新排队。历史审计记录会保留。",
      "重新入队任务",
      { confirmButtonText: "重新入队", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  taskActionLoading.value = true;
  try {
    await $fetch(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { method: "POST" });
    await loadTasks();
    selectedTask.value = tasks.value.find((item) => item.id === task.id) ?? null;
    ElMessage.success("任务已重新排队。");
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
    ElMessage.success("任务已取消，审计记录已保留。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "取消任务失败。"));
  } finally {
    taskActionLoading.value = false;
  }
}

onMounted(() => void loadTasks());
</script>

<template>
  <div class="page-wrap tasks-a">
    <PageHeader
      eyebrow="系统管理 / 任务监控"
      title="后台任务"
      description="持久化任务队列：扫描到期周期、手动跑一次 Worker，处理失败与待重试的任务。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadTasks"
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
      @click="statusFilter = 'ISSUES'"
    >
      <el-icon><Warning /></el-icon>
      <span><strong>{{ failedCount }} 项失败或待重试</strong>，点这里只看它们。</span>
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
          @click="statusFilter = chip.value"
        >
          {{ chip.label }}<span class="n">{{ chip.count }}</span>
        </button>
      </div>
      <div class="tools">
        <el-input
          v-model="query"
          class="search"
          clearable
          placeholder="搜索任务、角色或编号"
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
        v-else-if="!filtered.length"
        class="tbl-empty"
      >
        <span class="empty-icon"><el-icon><Files /></el-icon></span>
        <h3>{{ tasks.length ? "没有匹配的任务" : "还没有任务记录" }}</h3>
        <p>
          {{ tasks.length
            ? "换个关键词，或者把状态筛选切回「全部」。"
            : "启用角色的自动归档并到达周期边界后，「扫描到期周期」会在这里排入任务。" }}
        </p>
        <button
          v-if="tasks.length"
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
          v-for="task in filtered"
          :key="task.id"
          type="button"
          class="tbl-row"
          @click="openDetails(task)"
        >
          <span class="cell-task">
            <b>{{ taskTypeText(task.type) }}</b>
            <em>{{ task.characterName }} · #{{ task.id.slice(0, 8) }}</em>
          </span>
          <span class="cell-period">
            {{ periodText(task) }}
            <em v-if="cleanupText(task)">{{ cleanupText(task) }}</em>
          </span>
          <span>
            <span
              class="pill"
              :class="tone(task.status)"
            >{{ statusText(task.status) }}</span>
          </span>
          <span class="num">{{ task.attemptCount }} / {{ task.maxAttempts }}</span>
          <span class="time">{{ formatShort(task.updatedAt) }}</span>
          <span class="chev"><el-icon><ArrowRight /></el-icon></span>
        </button>
      </div>
    </div>

    <p class="footer-note">
      任务由独立 Worker 消费。生成总结与长期记忆会调用服务端配置的模型；重新入队与清理结果都会保留审计记录。
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
            :class="tone(selectedTask.status)"
          >{{ statusText(selectedTask.status) }}</span>
        </div>
        <p class="d-sub">
          {{ selectedTask.characterName }}
          <span class="sep">·</span>
          <code :title="selectedTask.id">#{{ selectedTask.id.slice(0, 8) }}</code>
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
            {{ canRetry ? "重新入队会清掉错误状态与尝试计数" : canCancel ? "只能取消尚未开始执行的任务" : "" }}
          </span>
          <span class="d-foot-actions">
            <el-button
              v-if="canRetry"
              :loading="taskActionLoading"
              @click="retrySelectedTask"
            >
              <el-icon><Refresh /></el-icon>重新入队
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
.search { width: 240px; }
.reset { border: 0; background: none; padding: 0 4px; color: var(--brand-strong); font-size: 12px; font-weight: 600; cursor: pointer; }
.reset:hover { text-decoration: underline; }

/* ── 表格：CSS grid 行，整行是按钮 ─────────────────── */
.tbl {
  border-radius: 10px;
  background: var(--surface);
  padding: 4px 8px 6px;
}
/* 列宽：任务 1.5、范围 1.4，其余按内容定宽 —— 状态药丸和「1 / 3」不该被拉伸 */
.tbl-head,
.tbl-row {
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(0, 1.4fr) 92px 60px 96px 20px;
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
  .tbl-row { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.2fr) 92px 56px; }
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
