<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Refresh } from "@element-plus/icons-vue";
import ModelTurnDetail, { type ModelTurnDetailResponse } from "./ModelTurnDetail.vue";

type CallLog = {
  id: string;
  turnId: string | null;
  hasTurnDetail: boolean;
  createdAt: string;
  kind: string;
  model: string;
  status: "success" | "failed" | "unknown";
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  usageReported: boolean;
  attempts: number | null;
  durationMs?: number | null;
  finishReason: string | null;
  httpStatus: number | null;
  reason: string | null;
  costCny: number | null;
};
type CallLogsResponse = {
  items: CallLog[];
  page: number;
  pageSize: number;
  total: number;
  summary: { records: number; totalTokens: number; failed: number; unknown: number; usageMissingRecords: number };
  models: string[];
  kinds: string[];
  note: string;
};

const props = defineProps<{ characterId: string }>();
const opened = defineModel<boolean>({ default: false });
const days = ref<1 | 7 | 30>(7);
const kind = ref("");
const model = ref("");
const page = ref(1);
const pageSize = ref<20 | 50>(20);
const report = ref<CallLogsResponse | null>(null);
const availableKinds = ref<string[]>([]);
const availableModels = ref<string[]>([]);
const total = ref(0);
const loading = ref(false);
const errorMessage = ref("");
let requestSequence = 0;
let controller: AbortController | undefined;
const detailOpened = ref(false);
const selectedLog = ref<{ id: string; turnId: string } | null>(null);
const turnDetail = ref<ModelTurnDetailResponse | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const detailMissing = ref(false);
let detailSequence = 0;
let detailController: AbortController | undefined;
const detailKey = computed(() => JSON.stringify([
  opened.value, detailOpened.value, props.characterId, selectedLog.value?.id, selectedLog.value?.turnId,
]));

function clearTurnDetail() {
  detailSequence++;
  detailController?.abort();
  turnDetail.value = null;
  detailLoading.value = false;
  detailError.value = "";
  detailMissing.value = false;
}
function closeTurnDetail() {
  detailOpened.value = false;
  selectedLog.value = null;
  clearTurnDetail();
}
function openTurnDetail(row: CallLog) {
  if (!opened.value || !props.characterId || !row.turnId) return;
  selectedLog.value = { id: row.id, turnId: row.turnId };
  detailOpened.value = true;
}
async function loadTurnDetail() {
  if (!opened.value || !detailOpened.value || !props.characterId || !selectedLog.value) return;
  clearTurnDetail();
  const sequence = ++detailSequence;
  const key = detailKey.value;
  const selection = selectedLog.value;
  detailController = new AbortController();
  detailLoading.value = true;
  try {
    const response = await $fetch<ModelTurnDetailResponse>(`/api/characters/${encodeURIComponent(props.characterId)}/usage/logs/${encodeURIComponent(selection.id)}/turn`, {
      signal: detailController.signal,
    });
    if (sequence !== detailSequence || key !== detailKey.value) return;
    if (response.turnId !== selection.turnId || response.detail.version !== 1) {
      detailError.value = "本轮详情暂时不可用，请刷新后重试。";
      return;
    }
    turnDetail.value = response;
  } catch (error: unknown) {
    if (sequence !== detailSequence || key !== detailKey.value) return;
    const status = error && typeof error === "object" && "statusCode" in error ? error.statusCode : undefined;
    detailMissing.value = status === 404;
    // Only show fixed messages: API/provider errors can include sensitive request data.
    detailError.value = status === 404 ? "历史记录未保存详情，或本轮详情已不可用。" : "暂时读不到本轮详情，请稍后重试。";
  } finally {
    if (sequence === detailSequence && key === detailKey.value) detailLoading.value = false;
  }
}

const kindLabels: Record<string, string> = {
  chat: "对话接口", channel: "QQ 回复", snapshot: "阶段总结", events: "忆泡整理",
  journal: "日记 / 手账", "bili-screening": "值班初筛", "bili-judge": "值班判断",
  proactive: "主动找话", vision: "看图", "sticker-label": "表情包识别",
  "memory-assistant": "记忆助手", "context-assistant": "语境助手", "knowledge-assistant": "知识处理助手",
  "catchphrase-mine": "捡梗", "bili-owner": "主人内容挑选", other: "其他",
};
const statusLabels = { success: "已完成", failed: "失败", unknown: "未记录状态" };
const statusTypes = { success: "success", failed: "danger", unknown: "info" } as const;
const requestKey = computed(() => JSON.stringify([
  opened.value, props.characterId, days.value, kind.value, model.value, page.value, pageSize.value,
]));
const summaries = computed(() => [
  { label: "记录数", value: report.value?.summary.records },
  { label: "已记录 Token", value: report.value?.summary.totalTokens },
  { label: "失败记录", value: report.value?.summary.failed },
  { label: "结果未知", value: report.value?.summary.unknown },
]);
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : timeFormatter.format(date);
}
function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
}
function formatTokens(row: CallLog, value: number | null) {
  return row.usageReported ? formatNumber(value) : "—";
}
function formatDuration(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value < 1000 ? `${formatNumber(value)} 毫秒` : `${(value / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 秒`;
}
function formatCost(row: CallLog) {
  if (!row.usageReported || row.costCny === null || !Number.isFinite(row.costCny)) return "—";
  if (row.costCny > 0 && row.costCny < 0.0001) return "< ¥0.0001";
  return `¥${row.costCny.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}
function finishLabel(value: string | null) {
  if (!value) return "—";
  return ({ stop: "正常结束", length: "达到输出上限", tool_calls: "请求工具", function_call: "请求工具", content_filter: "内容被拦截" } as Record<string, string>)[value] ?? "其他结束方式";
}
function reasonLabel(row: CallLog) {
  // Never render raw provider messages: they can contain request details or credentials.
  if (!row.reason) return "—";
  if (row.httpStatus === 401 || row.httpStatus === 403) return "服务商拒绝访问，请检查连接配置";
  if (row.httpStatus === 429) return "服务商限流或额度不足";
  if (row.httpStatus && row.httpStatus >= 500) return "服务商暂时不可用";
  if (row.status === "failed") return "调用未完成，请检查连接或稍后重试";
  return "结果信息不完整";
}
function resetPage() {
  page.value = 1;
}
async function loadLogs() {
  if (!opened.value || !props.characterId) return;
  controller?.abort();
  controller = new AbortController();
  const sequence = ++requestSequence;
  const key = requestKey.value;
  loading.value = true;
  errorMessage.value = "";
  report.value = null;
  try {
    const response = await $fetch<CallLogsResponse>(`/api/characters/${encodeURIComponent(props.characterId)}/usage/logs`, {
      query: { days: days.value, kind: kind.value || undefined, model: model.value || undefined, page: page.value, pageSize: pageSize.value },
      signal: controller.signal,
    });
    if (sequence !== requestSequence || key !== requestKey.value) return;
    report.value = response;
    total.value = response.total;
    availableKinds.value = response.kinds;
    availableModels.value = response.models;
  } catch {
    if (sequence !== requestSequence || key !== requestKey.value) return;
    errorMessage.value = "暂时读不到调用日志，请稍后重试。";
  } finally {
    if (sequence === requestSequence && key === requestKey.value) loading.value = false;
  }
}

watch([() => props.characterId, opened], () => {
  closeTurnDetail();
}, { flush: "sync" });
watch(detailKey, () => {
  clearTurnDetail();
  if (opened.value && detailOpened.value && selectedLog.value) void loadTurnDetail();
}, { flush: "sync" });
watch(() => props.characterId, () => {
  controller?.abort();
  requestSequence++;
  days.value = 7;
  kind.value = "";
  model.value = "";
  page.value = 1;
  pageSize.value = 20;
  availableKinds.value = [];
  availableModels.value = [];
  total.value = 0;
  report.value = null;
  errorMessage.value = "";
  loading.value = false;
});
watch(requestKey, () => {
  if (opened.value && props.characterId) void loadLogs();
  else {
    controller?.abort();
    requestSequence++;
    loading.value = false;
  }
}, { immediate: true });
onBeforeUnmount(() => {
  clearTurnDetail();
  requestSequence++;
  controller?.abort();
});
</script>

<template>
  <el-dialog
    v-model="opened"
    title="调用日志"
    width="min(1120px, calc(100vw - 32px))"
    top="5vh"
    class="model-call-logs-dialog"
    append-to-body
  >
    <div class="call-logs">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="这里只记录当前应用的模型使用情况"
        description="记录数不等于 HTTP 请求次数或 API Key 调用次数，重试可能合并为一条记录。较早的失败或未上报用量的调用可能缺失；这里无法查看服务商账号的其他使用情况或 Key 剩余额度。"
      />
      <div class="log-filters">
        <label class="log-filter">
          <span>时间范围</span>
          <el-select
            v-model="days"
            aria-label="时间范围"
            @change="resetPage"
          >
            <el-option
              label="最近 1 天"
              :value="1"
            />
            <el-option
              label="最近 7 天"
              :value="7"
            />
            <el-option
              label="最近 30 天"
              :value="30"
            />
          </el-select>
        </label>
        <label class="log-filter">
          <span>用途</span>
          <el-select
            v-model="kind"
            clearable
            aria-label="用途"
            placeholder="全部用途"
            @change="resetPage"
          >
            <el-option
              v-for="value in availableKinds"
              :key="value"
              :label="kindLabels[value] ?? '其他用途'"
              :value="value"
            />
          </el-select>
        </label>
        <label class="log-filter model-filter">
          <span>模型</span>
          <el-select
            v-model="model"
            clearable
            filterable
            aria-label="模型"
            placeholder="全部模型"
            @change="resetPage"
          >
            <el-option
              v-for="value in availableModels"
              :key="value"
              :label="value"
              :value="value"
            />
          </el-select>
        </label>
        <el-button
          :icon="Refresh"
          :loading="loading"
          @click="loadLogs"
        >
          刷新
        </el-button>
      </div>
      <div
        class="log-summary"
        aria-live="polite"
      >
        <div
          v-for="item in summaries"
          :key="item.label"
          class="log-stat"
        >
          <span>{{ item.label }}</span>
          <strong>{{ formatNumber(item.value) }}</strong>
        </div>
      </div>
      <p class="log-note">
        统计随筛选条件变化，覆盖全部分页。时间为北京时间（Asia/Shanghai）。金额仅为参考估算，缺少用量或未定价时显示 —。
        <template v-if="report?.summary.usageMissingRecords">
          其中 {{ formatNumber(report.summary.usageMissingRecords) }} 条记录未上报用量，Token 统计不完整。
        </template>
      </p>
      <el-alert
        v-if="errorMessage"
        type="error"
        :closable="false"
        show-icon
      >
        <template #title>
          {{ errorMessage }}
          <el-button
            link
            type="primary"
            @click="loadLogs"
          >
            重试
          </el-button>
        </template>
      </el-alert>
      <div
        v-loading="loading"
        class="log-table"
        :aria-busy="loading"
      >
        <el-table
          :data="report?.items ?? []"
          row-key="id"
          max-height="440"
          :empty-text="loading ? '正在读取调用记录…' : errorMessage ? '日志读取失败，请重试' : '这个范围内还没有调用记录'"
        >
          <el-table-column type="expand">
            <template #default="{ row }">
              <dl class="log-details">
                <div><dt>用量上报</dt><dd>{{ row.usageReported ? '已上报' : '未上报，Token 与金额不可确认' }}</dd></div>
                <div><dt>缓存命中 Token</dt><dd>{{ formatTokens(row as CallLog, row.cacheHitTokens) }}</dd></div>
                <div><dt>缓存未命中 Token</dt><dd>{{ formatTokens(row as CallLog, row.cacheMissTokens) }}</dd></div>
                <div><dt>思考 Token</dt><dd>{{ formatTokens(row as CallLog, row.reasoningTokens) }}</dd></div>
                <div><dt>尝试次数</dt><dd>{{ formatNumber(row.attempts) }}</dd></div>
                <div><dt>生成总耗时</dt><dd>{{ formatDuration(row.durationMs) }}（含助手处理与重试）</dd></div>
                <div><dt>HTTP 状态</dt><dd>{{ formatNumber(row.httpStatus) }}</dd></div>
                <div><dt>结束方式</dt><dd>{{ finishLabel(row.finishReason) }}</dd></div>
                <div><dt>结果说明</dt><dd>{{ reasonLabel(row as CallLog) }}</dd></div>
              </dl>
            </template>
          </el-table-column>
          <el-table-column
            label="时间"
            min-width="172"
          >
            <template #default="{ row }">
              {{ formatTime(row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column
            label="用途"
            min-width="100"
          >
            <template #default="{ row }">
              {{ kindLabels[row.kind] ?? '其他用途' }}
            </template>
          </el-table-column>
          <el-table-column
            prop="model"
            label="模型"
            min-width="160"
            show-overflow-tooltip
          />
          <el-table-column
            label="结果"
            width="108"
          >
            <template #default="{ row }">
              <el-tag
                :type="statusTypes[row.status as CallLog['status']] ?? 'info'"
                effect="light"
              >
                {{ statusLabels[row.status as CallLog['status']] ?? '未知' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="输入 Token"
            min-width="105"
            align="right"
          >
            <template #default="{ row }">
              {{ formatTokens(row as CallLog, row.promptTokens) }}
            </template>
          </el-table-column>
          <el-table-column
            label="输出 Token"
            min-width="105"
            align="right"
          >
            <template #default="{ row }">
              {{ formatTokens(row as CallLog, row.completionTokens) }}
            </template>
          </el-table-column>
          <el-table-column
            label="总 Token"
            min-width="100"
            align="right"
          >
            <template #default="{ row }">
              {{ formatTokens(row as CallLog, row.totalTokens) }}
            </template>
          </el-table-column>
          <el-table-column
            label="估算花费"
            min-width="115"
            align="right"
          >
            <template #default="{ row }">
              {{ formatCost(row as CallLog) }}
            </template>
          </el-table-column>
          <el-table-column
            label="本轮详情"
            width="190"
            fixed="right"
          >
            <template #default="{ row }">
              <el-button
                v-if="row.turnId != null"
                link
                type="primary"
                @click="openTurnDetail(row as CallLog)"
              >
                查看本轮详情
              </el-button>
              <el-button
                v-else
                link
                disabled
              >
                历史记录未保存详情
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        class="log-pagination"
        :page-sizes="[20, 50]"
        :total="total"
        :disabled="loading || !!errorMessage"
        layout="total, sizes, prev, pager, next"
        @size-change="resetPage"
      />
    </div>
  </el-dialog>
  <el-dialog
    v-model="detailOpened"
    title="本轮详情"
    width="min(900px, calc(100vw - 32px))"
    top="5vh"
    append-to-body
    @close="closeTurnDetail"
  >
    <div
      v-loading="detailLoading"
      class="turn-detail-body"
      :aria-busy="detailLoading"
      aria-live="polite"
    >
      <p v-if="detailLoading">
        正在读取本轮详情…
      </p>
      <el-alert
        v-else-if="detailError"
        :title="detailError"
        :type="detailMissing ? 'info' : 'error'"
        :closable="false"
        show-icon
      >
        <el-button
          v-if="!detailMissing"
          link
          type="primary"
          @click="loadTurnDetail"
        >
          重试
        </el-button>
      </el-alert>
      <ModelTurnDetail
        v-else-if="turnDetail"
        :result="turnDetail"
      />
    </div>
    <template #footer>
      <el-button @click="closeTurnDetail">
        返回调用日志
      </el-button>
      <el-button
        type="primary"
        @click="opened = false"
      >
        关闭
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.turn-detail-body { min-height: 150px; max-height: 70vh; overflow-y: auto; font-size: 14px; }
.call-logs { display: flex; flex-direction: column; gap: 16px; color: var(--text-2); font-size: 14px; }
.log-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.log-filter { display: flex; flex: 1; min-width: 150px; flex-direction: column; gap: 6px; font-size: 12px; }
.model-filter { flex: 2; min-width: 200px; }
.log-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.log-stat { display: flex; flex-direction: column; gap: 6px; border-radius: 8px; background: var(--surface-2, #f7f8fa); padding: 14px 16px; }
.log-stat span, .log-note { color: var(--dim); font-size: 12px; line-height: 1.7; }
.log-stat strong { color: var(--text); font-size: 22px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.log-note { margin: 0; }
.log-table { min-height: 130px; }
.log-table :deep(.el-table) { font-size: 12px; }
.log-details { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 24px; margin: 0; padding: 16px 28px; background: var(--surface-2, #f7f8fa); font-size: 12px; }
.log-details > div { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.log-details dt { color: var(--dim); }
.log-details dd { margin: 0; color: var(--text-2); overflow-wrap: anywhere; }
.log-pagination { align-self: flex-end; max-width: 100%; overflow-x: auto; padding-bottom: 4px; }
@media (max-width: 640px) {
  .log-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .log-details { grid-template-columns: 1fr; padding: 16px; }
  .log-pagination { align-self: stretch; }
}
</style>
