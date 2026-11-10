<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "成长事件投递" } });

type DeliveryStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "RETRY_WAIT" | "FAILED" | "SKIPPED" | "CANCELLED";
type Delivery = {
  id: string; eventId: string; consumerKey: string; status: DeliveryStatus;
  attemptCount: number; maxAttempts: number; runAt: string;
  lockedAt: string | null; lockedBy: string | null; leaseExpiresAt: string | null;
  fencingToken: number; lastError: string | null; processedAt: string | null;
  createdAt: string; updatedAt: string; eventType: string; sourceDomain: string;
  aggregateType: string; aggregateId: string; occurredAt: string;
  leaseExpired: boolean; queueDelayMs: number;
};
type DeliveryDetail = Delivery & {
  audits: Array<{ id: string; actorType: string; actorId: string | null; createdAt: string; details: unknown }>;
};
type Summary = { statusCounts: Record<DeliveryStatus, number>; readyCount: number; stuckCount: number; oldestReadyAt: string | null };
type DeliveryList = { items: Delivery[]; total: number; page: number; pageSize: number; totalPages: number; hasMore: boolean; summary: Summary };
const statusLabels: Record<DeliveryStatus, string> = {
  QUEUED: "待执行", RUNNING: "运行中", SUCCEEDED: "成功", RETRY_WAIT: "等待重试",
  FAILED: "失败", SKIPPED: "已跳过", CANCELLED: "已取消",
};
const statuses = Object.keys(statusLabels) as DeliveryStatus[];
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const items = ref<Delivery[]>([]);
const summary = ref<Summary>(emptySummary());
const total = ref(0);
const page = ref(1);
const totalPages = ref(1);
const status = ref<DeliveryStatus | "">("");
const loading = ref(false);
const loadError = ref("");
const detailOpen = ref(false);
const detailId = ref("");
const detail = ref<DeliveryDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const confirmOpen = ref(false);
const retryTarget = ref<{ id: string; generation: number; characterId: string } | null>(null);
const retrying = ref(false);
const retryError = ref("");
let generation = 0;
let listVersion = 0;
let detailVersion = 0;
let retryVersion = 0;
let disposed = false;

function emptySummary(): Summary {
  return { statusCounts: { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, RETRY_WAIT: 0, FAILED: 0, SKIPPED: 0, CANCELLED: 0 }, readyCount: 0, stuckCount: 0, oldestReadyAt: null };
}
function current(id: string, version: number) {
  return !disposed && generation === version && characterId.value === id;
}
function api(id: string) { return `/api/characters/${encodeURIComponent(id)}/growth/deliveries`; }
function errorText(error: unknown, fallback: string) {
  const value = error as { statusCode?: number; status?: number; response?: { status?: number } };
  const code = value?.statusCode ?? value?.status ?? value?.response?.status;
  if (code === 403) return "无权访问当前角色的投递，请检查登录账号。";
  if (code === 404) return "投递或角色已不存在，请刷新列表。";
  if (code === 409) return "投递状态已变化，仅失败投递可以恢复，请刷新后重试。";
  return fallback;
}
async function loadList() {
  const id = characterId.value;
  if (!id) return;
  const roleVersion = generation;
  const request = ++listVersion;
  loading.value = true;
  loadError.value = "";
  try {
    const result = await $fetch<DeliveryList>(api(id), { query: { page: page.value, pageSize: 20, status: status.value } });
    if (!current(id, roleVersion) || request !== listVersion) return;
    items.value = result.items;
    total.value = result.total;
    page.value = result.page;
    totalPages.value = result.totalPages;
    summary.value = result.summary;
  } catch (error) {
    if (!current(id, roleVersion) || request !== listVersion) return;
    loadError.value = errorText(error, "读取投递列表失败，请重试。");
  } finally {
    if (current(id, roleVersion) && request === listVersion) loading.value = false;
  }
}
function changeStatus(value: DeliveryStatus | "") {
  status.value = value;
  page.value = 1;
  items.value = [];
  void loadList();
}
function changePage(value: number) {
  page.value = value;
  items.value = [];
  void loadList();
}
async function loadDetail(id: string) {
  const roleId = characterId.value;
  if (!roleId) return;
  const roleVersion = generation;
  const request = ++detailVersion;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const result = await $fetch<DeliveryDetail>(`${api(roleId)}/${encodeURIComponent(id)}`);
    if (!current(roleId, roleVersion) || request !== detailVersion || detailId.value !== id || !detailOpen.value) return;
    detail.value = result;
  } catch (error) {
    if (!current(roleId, roleVersion) || request !== detailVersion || detailId.value !== id || !detailOpen.value) return;
    detailError.value = errorText(error, "读取投递详情失败，请重试。");
  } finally {
    if (current(roleId, roleVersion) && request === detailVersion) detailLoading.value = false;
  }
}
function openDetail(item: Delivery) {
  retryVersion += 1;
  retrying.value = false;
  cancelRetry();
  detail.value = null;
  detailId.value = item.id;
  detailOpen.value = true;
  retryError.value = "";
  void loadDetail(item.id);
}
function closeDetail() {
  retryVersion += 1;
  retrying.value = false;
  detailVersion += 1;
  detailOpen.value = false;
  detailId.value = "";
  detail.value = null;
  detailLoading.value = false;
  detailError.value = "";
  cancelRetry();
}
function requestRetry() {
  if (!detail.value || detail.value.status !== "FAILED" || retrying.value) return;
  retryTarget.value = { id: detail.value.id, generation, characterId: characterId.value };
  retryError.value = "";
  confirmOpen.value = true;
}
function cancelRetry() {
  confirmOpen.value = false;
  retryTarget.value = null;
}
async function confirmRetry() {
  const target = retryTarget.value;
  if (!target || retrying.value || !current(target.characterId, target.generation)) return;
  const request = ++retryVersion;
  const selectedDetailVersion = detailVersion;
  retrying.value = true;
  retryError.value = "";
  try {
    await $fetch(`${api(target.characterId)}/${encodeURIComponent(target.id)}/retry`, { method: "POST" });
    if (!current(target.characterId, target.generation) || request !== retryVersion) return;
    cancelRetry();
    ElMessage.success("失败投递已恢复到队列。");
    const refreshes: Promise<void>[] = [loadList()];
    if (detailOpen.value && detailId.value === target.id && detailVersion === selectedDetailVersion) {
      detail.value = null;
      refreshes.push(loadDetail(target.id));
    }
    await Promise.all(refreshes);
  } catch (error) {
    if (!current(target.characterId, target.generation) || request !== retryVersion) return;
    retryError.value = errorText(error, "恢复投递失败，请重试。");
  } finally {
    if (current(target.characterId, target.generation) && request === retryVersion) retrying.value = false;
  }
}
function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
function duration(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "不足 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
  return `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时`;
}
function waitingSince(value: string | null) { return value ? duration(Date.now() - new Date(value).getTime()) : "无可执行积压"; }
function tagType(item: Delivery): "danger" | "success" | "warning" | "info" | "primary" {
  if (item.leaseExpired || item.status === "FAILED") return "danger";
  if (item.status === "SUCCEEDED") return "success";
  if (item.status === "RUNNING") return "primary";
  if (item.status === "QUEUED" || item.status === "RETRY_WAIT") return "warning";
  return "info";
}
function auditDetails(value: unknown) { return JSON.stringify(value, null, 2) ?? "—"; }

watch(characterId, () => {
  generation += 1;
  listVersion += 1;
  retryVersion += 1;
  closeDetail();
  retrying.value = false;
  retryError.value = "";
  items.value = [];
  summary.value = emptySummary();
  total.value = 0;
  totalPages.value = 1;
  page.value = 1;
  status.value = "";
  loadError.value = "";
  loading.value = false;
  void loadList();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation += 1; listVersion += 1; detailVersion += 1; retryVersion += 1; });
</script>

<template>
  <div class="page-wrap delivery-page">
    <PageHeader
      eyebrow="成长系统 / 事件投递"
      description="查看当前角色的领域事件投递、积压与恢复记录。"
    />
    <el-empty
      v-if="!activeCharacter"
      description="请先从左下角选择角色。"
    />
    <template v-else>
      <section
        class="card delivery-overview"
        aria-label="当前角色投递概况"
      >
        <div class="delivery-heading">
          <div><strong>{{ activeCharacter.name }}</strong><p>事件投递</p></div>
          <el-button
            :loading="loading"
            @click="loadList"
          >
            刷新
          </el-button>
        </div>
        <div class="delivery-metrics">
          <div><span>当前可执行</span><strong>{{ summary.readyCount }}</strong></div>
          <div><span>过期租约</span><strong>{{ summary.stuckCount }}</strong></div>
          <div><span>最早可执行等待</span><strong>{{ waitingSince(summary.oldestReadyAt) }}</strong><small>{{ formatDate(summary.oldestReadyAt) }}</small></div>
        </div>
        <p class="delivery-note">
          等待从本轮可执行时间计算；正常退避尚未到期的投递不计入可执行积压。过期租约由 Worker 回收。
        </p>
        <div
          class="delivery-statuses"
          aria-label="按投递状态筛选"
        >
          <el-button
            :type="status === '' ? 'primary' : 'default'"
            plain
            @click="changeStatus('')"
          >
            全部 {{ Object.values(summary.statusCounts).reduce((sum, count) => sum + count, 0) }}
          </el-button>
          <el-button
            v-for="state in statuses"
            :key="state"
            :type="status === state ? 'primary' : 'default'"
            plain
            @click="changeStatus(state)"
          >
            {{ statusLabels[state] }} {{ summary.statusCounts[state] }}
          </el-button>
        </div>
      </section>
      <section
        class="card delivery-list"
        aria-label="投递列表"
      >
        <el-alert
          v-if="loadError"
          :title="loadError"
          type="error"
          :closable="false"
          show-icon
        />
        <el-table
          v-loading="loading"
          :data="items"
          row-key="id"
          empty-text="当前筛选下没有投递记录"
          @row-click="openDetail"
        >
          <el-table-column
            label="事件 / 消费者"
            min-width="230"
          >
            <template #default="{ row }">
              <el-button
                link
                type="primary"
                @click.stop="openDetail(row as Delivery)"
              >
                {{ row.eventType }}
              </el-button><div class="delivery-secondary">
                {{ row.consumerKey }}
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="140"
          >
            <template #default="{ row }">
              <el-tag :type="tagType(row as Delivery)">
                {{ row.leaseExpired ? '运行中 · 租约过期' : statusLabels[row.status as DeliveryStatus] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="尝试次数"
            width="100"
          >
            <template #default="{ row }">
              {{ row.attemptCount }} / {{ row.maxAttempts }}
            </template>
          </el-table-column>
          <el-table-column
            label="本轮可执行时间"
            min-width="180"
          >
            <template #default="{ row }">
              {{ formatDate(row.runAt) }}<div
                v-if="row.status === 'QUEUED' || row.status === 'RETRY_WAIT'"
                class="delivery-secondary"
              >
                等待 {{ duration(row.queueDelayMs) }}
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="最近错误 / 跳过原因"
            min-width="220"
          >
            <template #default="{ row }">
              <span class="delivery-error-preview">{{ row.lastError || '—' }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="delivery-pagination">
          <span>共 {{ total }} 条 · 第 {{ page }} / {{ Math.max(1, totalPages) }} 页</span><el-pagination
            :current-page="page"
            :page-size="20"
            :total="total"
            layout="prev, pager, next"
            :disabled="loading"
            @current-change="changePage"
          />
        </div>
      </section>
    </template>
    <el-drawer
      :model-value="detailOpen"
      title="投递详情"
      size="min(680px, 100vw)"
      @update:model-value="value => { if (!value) closeDetail(); }"
    >
      <div
        v-loading="detailLoading"
        class="delivery-detail"
      >
        <el-alert
          v-if="detailError"
          :title="detailError"
          type="error"
          :closable="false"
          show-icon
        />
        <el-button
          v-if="detailError && detailId"
          @click="loadDetail(detailId)"
        >
          重试读取详情
        </el-button>
        <template v-if="detail">
          <div class="delivery-heading">
            <el-tag :type="tagType(detail)">
              {{ detail.leaseExpired ? '运行中 · 租约过期' : statusLabels[detail.status] }}
            </el-tag><el-button
              v-if="detail.status === 'FAILED'"
              type="primary"
              :loading="retrying"
              @click="requestRetry"
            >
              恢复到队列
            </el-button>
          </div>
          <el-alert
            v-if="detail.leaseExpired"
            title="租约已过期，等待 Worker 回收；此处不提供运行中投递的人工恢复。"
            type="warning"
            :closable="false"
          />
          <el-descriptions
            :column="1"
            border
          >
            <el-descriptions-item label="事件类型">
              {{ detail.eventType }}
            </el-descriptions-item>
            <el-descriptions-item label="投递 ID">
              {{ detail.id }}
            </el-descriptions-item>
            <el-descriptions-item label="事件 ID">
              {{ detail.eventId }}
            </el-descriptions-item>
            <el-descriptions-item label="消费者">
              {{ detail.consumerKey }}
            </el-descriptions-item>
            <el-descriptions-item label="来源领域">
              {{ detail.sourceDomain }}
            </el-descriptions-item>
            <el-descriptions-item label="来源引用">
              {{ detail.aggregateType }} · {{ detail.aggregateId }}
            </el-descriptions-item>
            <el-descriptions-item label="发生时间">
              {{ formatDate(detail.occurredAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="尝试次数">
              {{ detail.attemptCount }} / {{ detail.maxAttempts }}
            </el-descriptions-item>
            <el-descriptions-item label="本轮可执行">
              {{ formatDate(detail.runAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="本轮排队等待">
              {{ duration(detail.queueDelayMs) }}
            </el-descriptions-item>
            <el-descriptions-item label="Worker">
              {{ detail.lockedBy || '—' }}
            </el-descriptions-item>
            <el-descriptions-item label="Fencing token">
              {{ detail.fencingToken }}
            </el-descriptions-item>
            <el-descriptions-item label="领取 / 续租时间">
              {{ formatDate(detail.lockedAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="租约截止">
              {{ formatDate(detail.leaseExpiresAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="完成时间">
              {{ formatDate(detail.processedAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="创建时间">
              {{ formatDate(detail.createdAt) }}
            </el-descriptions-item>
            <el-descriptions-item label="更新时间">
              {{ formatDate(detail.updatedAt) }}
            </el-descriptions-item>
          </el-descriptions>
          <h3>最近错误 / 跳过原因</h3><pre class="delivery-text">{{ detail.lastError || '暂无错误记录。' }}</pre>
          <h3>恢复审计</h3>
          <el-empty
            v-if="!detail.audits.length"
            description="暂无恢复审计记录"
            :image-size="60"
          />
          <el-timeline v-else>
            <el-timeline-item
              v-for="audit in detail.audits"
              :key="audit.id"
              :timestamp="formatDate(audit.createdAt)"
            >
              <strong>{{ audit.actorType }} · {{ audit.actorId || '系统' }}</strong><pre class="delivery-text">{{ auditDetails(audit.details) }}</pre>
            </el-timeline-item>
          </el-timeline>
        </template>
      </div>
    </el-drawer>
    <el-dialog
      :model-value="confirmOpen"
      title="恢复失败投递"
      width="min(480px, 92vw)"
      :close-on-click-modal="!retrying"
      :close-on-press-escape="!retrying"
      :show-close="!retrying"
      @update:model-value="value => { if (!value && !retrying) cancelRetry(); }"
    >
      <p>确认将这条失败投递重新放回队列？新一轮尝试次数从零开始，历史错误与恢复审计仍可追溯。</p>
      <el-alert
        v-if="retryError"
        :title="retryError"
        type="error"
        :closable="false"
        show-icon
      />
      <template #footer>
        <el-button
          :disabled="retrying"
          @click="cancelRetry"
        >
          取消
        </el-button><el-button
          type="primary"
          :loading="retrying"
          @click="confirmRetry"
        >
          确认恢复
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.delivery-page { font-size: 14px; }
.delivery-overview, .delivery-list { margin-top: 18px; padding: 20px; }
.delivery-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.delivery-heading strong { font-size: 16px; }
.delivery-heading p { margin: 4px 0 0; color: var(--dim); }
.delivery-metrics { display: grid; grid-template-columns: 1fr 1fr 2fr; gap: 20px; }
.delivery-metrics > div { display: flex; flex-direction: column; gap: 8px; }
.delivery-metrics span, .delivery-metrics small, .delivery-note, .delivery-secondary { color: var(--dim); font-size: 12px; }
.delivery-metrics strong { color: var(--ink); font-size: 20px; }
.delivery-note { margin: 18px 0; line-height: 1.6; }
.delivery-statuses { display: flex; flex-wrap: wrap; gap: 8px; }
.delivery-statuses .el-button { margin: 0; }
.delivery-secondary { margin-top: 4px; overflow-wrap: anywhere; }
.delivery-error-preview { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
.delivery-pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 18px; color: var(--dim); font-size: 12px; }
.delivery-detail { min-height: 120px; display: grid; gap: 16px; overflow-wrap: anywhere; }
.delivery-detail h3 { margin: 8px 0 0; font-size: 14px; }
.delivery-text { margin: 0; padding: 12px; border-radius: 8px; background: var(--surface-alt, #f5f7fa); white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; line-height: 1.7; }
@media (max-width: 640px) { .delivery-metrics { grid-template-columns: 1fr 1fr; } .delivery-metrics > div:last-child { grid-column: 1 / -1; } .delivery-overview, .delivery-list { padding: 14px; } }
</style>
