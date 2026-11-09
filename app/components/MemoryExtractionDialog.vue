<script setup lang="ts">
import { ensureMemoryProgressPolling, type MemoryProgressRow } from "~/composables/useMemoryProgress";
import { useMemoryActions } from "~/composables/useMemoryActions";

type ExtractionPreview = {
  characterId: string;
  characterName: string;
  timeZone: string;
  checkedAt: string;
  totalMessages: number;
  rows: Array<{ key: string; dayKey: string; conversationLabel: string; scopeLabel: string; pendingMessages: number }>;
  truncated: boolean;
  hasLegacyOwnerChats: boolean;
  notice: string | null;
};

const props = defineProps<{ modelValue: boolean; characterId: string; characterName: string }>();
const emit = defineEmits<{ "update:modelValue": [value: boolean] }>();
const visible = computed({ get: () => props.modelValue, set: (value: boolean) => emit("update:modelValue", value) });
// 每次打开或切角色都是独立查看会话。操作调用时由 composable 再捕获这里的 ID。
const sessionCharacterId = ref("");
const sessionCharacterName = ref("");
const preview = ref<ExtractionPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
const jobs = ref<MemoryProgressRow[]>([]);
const progressLoading = ref(false);
const progressError = ref("");
const progressCheckedAt = ref<string | null>(null);
const { eventExtracting, runEventExtraction } = useMemoryActions(
  () => sessionCharacterId.value,
  () => sessionCharacterName.value,
);
let epoch = 0;
let previewRequest = 0;
let progressRequest = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
function current(token: number, characterId: string) {
  return props.modelValue && token === epoch && characterId === sessionCharacterId.value;
}
function message(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error && error.statusMessage) return String(error.statusMessage);
  return error instanceof Error && error.message ? error.message : fallback;
}
async function loadPreview() {
  const token = epoch;
  const characterId = sessionCharacterId.value;
  const request = ++previewRequest;
  if (!characterId || !props.modelValue) return;
  previewLoading.value = true;
  previewError.value = "";
  try {
    const result = await $fetch<ExtractionPreview>(`/api/characters/${encodeURIComponent(characterId)}/memory-events/preview`);
    if (!current(token, characterId) || request !== previewRequest) return;
    if (result.characterId !== characterId) throw new Error("预览角色不一致，请重新加载。");
    preview.value = result;
  } catch (error) {
    if (current(token, characterId) && request === previewRequest) {
      preview.value = null;
      previewError.value = message(error, "待整理对话读取失败，请重试。");
    }
  } finally {
    if (current(token, characterId) && request === previewRequest) previewLoading.value = false;
  }
}
async function loadProgress() {
  const token = epoch;
  const characterId = sessionCharacterId.value;
  const request = ++progressRequest;
  if (!characterId || !props.modelValue) return;
  progressLoading.value = true;
  try {
    const result = await $fetch<{ jobs: MemoryProgressRow[]; checkedAt: string }>("/api/memory-progress", {
      query: { characterId, type: "EXTRACT_EVENTS" },
    });
    if (!current(token, characterId) || request !== progressRequest) return;
    jobs.value = result.jobs.filter(job => job.characterId === characterId && job.type === "EXTRACT_EVENTS");
    progressCheckedAt.value = result.checkedAt;
    progressError.value = "";
  } catch (error) {
    if (current(token, characterId) && request === progressRequest) progressError.value = message(error, "任务进度读取失败，请刷新。");
  } finally {
    if (current(token, characterId) && request === progressRequest) progressLoading.value = false;
  }
}
function schedulePoll() {
  stopPolling();
  if (!props.modelValue || !sessionCharacterId.value) return;
  const token = epoch;
  pollTimer = setTimeout(async () => {
    await loadProgress();
    if (token === epoch && props.modelValue) schedulePoll();
  }, 5_000);
}
async function refresh() {
  const token = epoch;
  await Promise.all([loadPreview(), loadProgress()]);
  if (token === epoch && props.modelValue) schedulePoll();
}
watch(() => [props.modelValue, props.characterId] as const, ([open, characterId]) => {
  epoch++;
  previewRequest++;
  progressRequest++;
  stopPolling();
  preview.value = null;
  jobs.value = [];
  previewError.value = "";
  progressError.value = "";
  progressCheckedAt.value = null;
  previewLoading.value = false;
  progressLoading.value = false;
  sessionCharacterId.value = open ? characterId : "";
  sessionCharacterName.value = open ? props.characterName : "";
  if (open && characterId) {
    ensureMemoryProgressPolling();
    void refresh();
  }
}, { immediate: true });
onBeforeUnmount(() => {
  epoch++;
  stopPolling();
});

const retryable = computed(() => jobs.value.some(job => ["QUEUED", "RETRY_WAIT", "FAILED", "CANCELLED"].includes(job.status)
  || job.status === "RUNNING" && job.leaseExpired));
const running = computed(() => jobs.value.some(job => job.status === "RUNNING" && !job.leaseExpired));
const pendingRelocation = computed(() => preview.value?.hasLegacyOwnerChats === true);
const canStart = computed(() => Boolean(sessionCharacterId.value && preview.value && !previewLoading.value
  && !eventExtracting.value && (preview.value.totalMessages > 0 || pendingRelocation.value)));
async function startExtraction() {
  if (!canStart.value) return;
  const token = epoch;
  const characterId = sessionCharacterId.value;
  await runEventExtraction();
  if (current(token, characterId)) await refresh();
}
function statusLabel(job: MemoryProgressRow) {
  if (job.status === "RUNNING") return job.leaseExpired ? "运行中 · 租约已过期" : "正在整理";
  return ({ QUEUED: "排队中", RETRY_WAIT: "等待重试", FAILED: "失败", CANCELLED: "已取消", SUCCEEDED: "已完成", SKIPPED: "已完成 · 无新内容" } as Record<string, string>)[job.status] ?? job.status;
}
function percentage(job: MemoryProgressRow) {
  if (job.done === null || job.total === null || job.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(job.done / job.total * 100)));
}
function formatCheckedAt(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN") : value;
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="`整理忆泡 · ${sessionCharacterName || '当前角色'}`"
    width="min(900px, 94vw)"
    class="memory-extraction-dialog"
  >
    <div class="extraction-content">
      <el-alert
        title="本次整理昨天和今天尚未处理的对话，按日期与会话列出；开始后会调用模型，产生用量。"
        type="info"
        :closable="false"
        show-icon
      />
      <section aria-label="待整理对话">
        <div class="extraction-section-head">
          <h3>待整理范围</h3>
          <el-button
            :loading="previewLoading || progressLoading"
            @click="refresh"
          >
            刷新预览与进度
          </el-button>
        </div>
        <div
          v-if="previewError"
          class="extraction-error"
          role="alert"
        >
          <p>{{ previewError }}</p>
          <el-button
            :loading="previewLoading"
            @click="loadPreview"
          >
            重试预览
          </el-button>
        </div>
        <p
          v-else-if="previewLoading && !preview"
          class="extraction-note"
          role="status"
        >
          正在读取待整理对话……
        </p>
        <template v-else-if="preview">
          <p class="extraction-summary">
            共 <strong>{{ preview.totalMessages }}</strong> 条待处理消息 · 角色时区：{{ preview.timeZone }}
          </p>
          <p class="extraction-note">
            预览时间：{{ formatCheckedAt(preview.checkedAt) }}。数量可能随新消息和已保存进度变化，正在执行的范围不计入待整理数量。
          </p>
          <el-table
            v-if="preview.rows.length"
            :data="preview.rows"
            row-key="key"
            max-height="280"
            empty-text="昨天和今天没有待整理对话"
          >
            <el-table-column
              prop="dayKey"
              label="日期"
              width="120"
            />
            <el-table-column
              prop="conversationLabel"
              label="会话"
              min-width="180"
            />
            <el-table-column
              prop="scopeLabel"
              label="记忆范围"
              min-width="130"
            />
            <el-table-column
              prop="pendingMessages"
              label="待处理消息"
              width="120"
              align="right"
            />
          </el-table>
          <el-empty
            v-else
            description="本次预览没有可启动的待整理对话"
            :image-size="64"
          />
          <p
            v-if="preview.truncated"
            class="extraction-note"
          >
            会话明细较多，表格未全部列出；开始整理会按服务端范围处理，不只处理表中行。
          </p>
          <p
            v-if="preview.notice"
            class="extraction-note"
          >
            {{ preview.notice }}
          </p>
          <p class="extraction-note">
            此处仅供预览，不支持选择部分日期或会话；开始整理会处理服务端可整理的昨天和今天全部范围。
          </p>
        </template>
      </section>
      <section aria-label="忆泡任务进度">
        <div class="extraction-section-head">
          <h3>整理进度</h3>
          <span class="extraction-note">最近最多 20 个任务</span>
          <span
            v-if="progressCheckedAt"
            class="extraction-note"
          >更新于 {{ formatCheckedAt(progressCheckedAt) }}</span>
        </div>
        <p
          v-if="progressError"
          class="extraction-error"
          role="alert"
        >
          {{ progressError }} 已显示的进度可能不是最新状态。
        </p>
        <p
          v-if="!jobs.length && !progressError"
          class="extraction-note"
        >
          {{ progressLoading ? '正在读取任务状态……' : '暂未查询到该角色的忆泡任务。' }}
        </p>
        <ul
          v-else
          class="extraction-jobs"
        >
          <li
            v-for="job in jobs"
            :key="job.id"
            class="extraction-job"
          >
            <div class="extraction-job-head">
              <strong>{{ job.label }}</strong><span>{{ statusLabel(job) }}</span>
            </div>
            <template v-if="percentage(job) !== null">
              <el-progress
                :percentage="percentage(job) ?? 0"
                :show-text="false"
              />
              <p class="extraction-note">
                已处理 {{ job.done }} / {{ job.total }} 条对话<span v-if="job.eventCount !== null"> · 已保存 {{ job.eventCount }} 条忆泡</span>
              </p>
            </template>
            <p
              v-else
              class="extraction-note"
            >
              {{ job.status === 'SUCCEEDED' || job.status === 'SKIPPED' ? '本次任务已结束，可在忆泡日历查看结果。' : '当前没有可计算的消息进度，等待服务端更新。' }}
            </p>
            <p
              v-if="job.leaseExpired"
              class="extraction-error"
            >
              执行租约已过期，任务可能已中断。已保存进度保留，可继续整理昨天和今天；历史任务请到任务监控处理。
            </p>
            <p
              v-if="job.lastError"
              class="extraction-error"
            >
              最近失败原因：{{ job.lastError }}
            </p>
          </li>
        </ul>
      </section>
      <el-alert
        title="已保存的整理进度会保留。后台持续执行和到点重试依赖 Worker；Web 服务重启可能中断当前执行，刷新页面不代表任务一定继续。"
        type="warning"
        :closable="false"
        show-icon
      />
      <p class="extraction-note">
        “继续整理”只会唤醒昨天和今天的可重试任务；更早的历史任务请前往 <NuxtLink
          to="/tasks"
          @click="visible = false"
        >
          任务监控
        </NuxtLink>，重新入队后仍需 Worker 领取。
      </p>
    </div>
    <template #footer>
      <el-button @click="visible = false">
        关闭
      </el-button>
      <el-button
        type="primary"
        :loading="eventExtracting"
        :disabled="!canStart"
        @click="startExtraction"
      >
        {{ pendingRelocation ? '检查并整理（昨天和今天）' : retryable || running ? '继续整理（昨天和今天）' : '开始整理' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.extraction-content { display: flex; flex-direction: column; gap: 20px; }
.extraction-section-head, .extraction-job-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.extraction-section-head h3 { margin: 0; font-size: 15px; color: var(--text-2); }
.extraction-summary { margin: 12px 0 6px; font-size: 14px; }
.extraction-note { margin: 8px 0; font-size: 12px; line-height: 1.7; color: var(--dim); }
.extraction-error { margin: 8px 0; font-size: 13px; line-height: 1.7; color: var(--el-color-danger); overflow-wrap: anywhere; }
.extraction-jobs { display: grid; gap: 10px; margin: 12px 0 0; padding: 0; list-style: none; }
.extraction-job { padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.extraction-job-head { margin-bottom: 10px; font-size: 13px; }
.extraction-job-head strong { overflow-wrap: anywhere; }
.extraction-job-head span { flex-shrink: 0; color: var(--dim); }
@media (max-width: 600px) {
  .extraction-section-head, .extraction-job-head { align-items: flex-start; flex-direction: column; gap: 8px; }
}
</style>
