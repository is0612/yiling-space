<script setup lang="ts">
import { ElMessage } from "element-plus";
type Status = "PENDING" | "ACTIVE" | "DISABLED" | "REJECTED";
type Operation = "ACTIVATE" | "REJECT" | "DISABLE";
type Item = { id: string; characterId: string; kind: "GROUP_AT_DISABLED"; chatScope: "GROUP"; content: string; status: Status; revision: number; sourceRefs?: unknown[]; createdAt: string; updatedAt?: string; action?: string };
type Page = { items: Item[]; pagination: { page: number; pageSize: number; total: number; pageCount: number } };
const props = defineProps<{ characterId: string }>();
const statuses: Record<Status, string> = { PENDING: "待审核", ACTIVE: "已生效", DISABLED: "已停用", REJECTED: "已驳回" };
const actions: Record<string, string> = { CREATE: "生成候选", ACTIVATE: "确认启用", REJECT: "驳回", DISABLE: "停用" };
const scopeText = "当前角色所有 QQ 绑定的被动群聊回复不再附带 @ 提醒；正文和引用照常发送。不影响主动好友联系或群公告。";
const status = ref<Status>("PENDING"), page = ref(1), total = ref(0), items = ref<Item[]>([]), loading = ref(false), error = ref("");
const target = ref<Item | null>(null), operation = ref<Operation | null>(null), reviewed = ref(false), busy = ref(false), dialogError = ref("");
const historyTarget = ref<Item | null>(null), historyItems = ref<Item[]>([]), historyPage = ref(1), historyTotal = ref(0), historyLoading = ref(false), historyError = ref("");
let generation = 0, sequence = 0, actionSequence = 0, historySequence = 0, disposed = false;
const api = (id: string) => `/api/characters/${encodeURIComponent(id)}/growth/channel-policies`;
const current = (id: string, epoch: number) => !disposed && props.characterId === id && generation === epoch;
const fail = (e: unknown) => (e as { data?: { statusMessage?: string; message?: string } })?.data?.statusMessage || (e as { data?: { message?: string } })?.data?.message || "操作未完成，请刷新后重试。";
function closeAction() { actionSequence++; target.value = null; operation.value = null; reviewed.value = false; busy.value = false; dialogError.value = ""; }
function closeHistory() { historySequence++; historyTarget.value = null; historyItems.value = []; historyTotal.value = 0; historyLoading.value = false; historyError.value = ""; }
async function load() {
  const id = props.characterId, epoch = generation, request = ++sequence;
  if (!id || disposed) return;
  loading.value = true; error.value = "";
  try {
    const result = await $fetch<Page>(api(id), { query: { status: status.value, page: page.value, pageSize: 20 } });
    if (!current(id, epoch) || request !== sequence) return;
    items.value = result.items.filter(item => item.characterId === id && item.kind === "GROUP_AT_DISABLED" && item.status === status.value); total.value = result.pagination.total;
    if (page.value > Math.max(1, result.pagination.pageCount)) { page.value = Math.max(1, result.pagination.pageCount); void load(); }
  } catch (e) { if (current(id, epoch) && request === sequence) error.value = fail(e); }
  finally { if (current(id, epoch) && request === sequence) loading.value = false; }
}
function filter(value: string | number | boolean | undefined) { if (!Object.hasOwn(statuses, String(value))) return; status.value = value as Status; page.value = 1; items.value = []; total.value = 0; void load(); }
function open(item: Item, next: Operation) {
  if (disposed || busy.value || item.characterId !== props.characterId || item.kind !== "GROUP_AT_DISABLED") return;
  if ((next === "ACTIVATE" && !["PENDING", "DISABLED"].includes(item.status)) || (next === "REJECT" && item.status !== "PENDING") || (next === "DISABLE" && item.status !== "ACTIVE")) return;
  closeAction(); target.value = { ...item }; operation.value = next;
}
async function submit() {
  const item = target.value, next = operation.value, id = props.characterId, epoch = generation;
  if (!item || !next || disposed || busy.value || item.characterId !== id || (next === "ACTIVATE" && !reviewed.value)) return;
  const request = ++actionSequence; busy.value = true; dialogError.value = "";
  try {
    await $fetch(`${api(id)}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { operation: next, expectedRevision: item.revision } });
    if (!current(id, epoch) || request !== actionSequence) return;
    closeAction(); ElMessage.success("渠道行为状态已更新，历史记录已保留。"); await load();
  } catch (e) { if (current(id, epoch) && request === actionSequence) dialogError.value = fail(e); }
  finally { if (current(id, epoch) && request === actionSequence) busy.value = false; }
}
async function loadHistory() {
  const item = historyTarget.value, id = props.characterId, epoch = generation, request = ++historySequence;
  if (!item || disposed || item.characterId !== id) return;
  historyLoading.value = true; historyError.value = "";
  try {
    const result = await $fetch<Page>(`${api(id)}/${encodeURIComponent(item.id)}/history`, { query: { page: historyPage.value, pageSize: 10 } });
    if (!current(id, epoch) || request !== historySequence || historyTarget.value?.id !== item.id) return;
    historyItems.value = result.items; historyTotal.value = result.pagination.total;
    if (historyPage.value > Math.max(1, result.pagination.pageCount)) { historyPage.value = Math.max(1, result.pagination.pageCount); void loadHistory(); }
  } catch (e) { if (current(id, epoch) && request === historySequence) historyError.value = fail(e); }
  finally { if (current(id, epoch) && request === historySequence) historyLoading.value = false; }
}
function showHistory(item: Item) { if (disposed || item.characterId !== props.characterId) return; closeHistory(); historyTarget.value = { ...item }; historyPage.value = 1; void loadHistory(); }
watch(() => props.characterId, () => { generation++; sequence++; closeAction(); closeHistory(); items.value = []; total.value = 0; page.value = 1; status.value = "PENDING"; loading.value = false; error.value = ""; void load(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; sequence++; closeAction(); closeHistory(); });
</script>

<template>
  <section class="channel-policy-workspace card">
    <header class="heading">
      <div>
        <h2>渠道行为审核</h2>
        <p>这是 QQ 渠道的发送行为设置，与上方表达习惯分开管理。候选只有经主人明确确认后才生效。</p>
      </div>
      <el-button
        :loading="loading"
        :disabled="!characterId || busy"
        @click="load"
      >
        刷新渠道行为
      </el-button>
    </header>
    <el-alert
      :title="scopeText"
      type="info"
      :closable="false"
    />
    <p class="muted">
      当前只支持明确的“被动群聊回复不附带 @ 提醒”。“少 @ 一点”等模糊要求不等于全面关闭，不能据此直接启用。
    </p>
    <el-radio-group
      :model-value="status"
      aria-label="渠道行为状态"
      @update:model-value="filter"
    >
      <el-radio-button
        v-for="(label, value) in statuses"
        :key="value"
        :value="value"
      >
        {{ label }}
      </el-radio-button>
    </el-radio-group>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <div v-loading="loading">
      <el-empty
        v-if="!items.length && !loading"
        :description="error ? '渠道行为暂未加载成功。' : '当前状态下没有渠道行为。'"
      />
      <article
        v-for="item in items"
        :key="item.id"
        class="policy-item"
      >
        <header class="heading">
          <h3>被动群聊回复不附带 @ 提醒</h3><el-tag>{{ statuses[item.status] }}</el-tag>
        </header>
        <p>{{ item.content }}</p>
        <p>{{ scopeText }}</p>
        <p class="muted">
          版本 {{ item.revision }} · 私人来源引用 {{ item.sourceRefs?.length ?? 0 }} 条；此处只展示数量，不展示私聊原文。
        </p>
        <div class="actions">
          <el-button
            v-if="item.status === 'PENDING' || item.status === 'DISABLED'"
            type="primary"
            @click="open(item, 'ACTIVATE')"
          >
            {{ item.status === 'PENDING' ? '审核启用' : '重新启用' }}
          </el-button>
          <el-button
            v-if="item.status === 'PENDING'"
            type="danger"
            plain
            @click="open(item, 'REJECT')"
          >
            驳回
          </el-button>
          <el-button
            v-if="item.status === 'ACTIVE'"
            @click="open(item, 'DISABLE')"
          >
            停用
          </el-button>
          <el-button
            text
            @click="showHistory(item)"
          >
            修订历史
          </el-button>
        </div>
      </article>
    </div>
    <el-pagination
      v-if="total > 20"
      v-model:current-page="page"
      :total="total"
      :page-size="20"
      layout="prev, pager, next, total"
      @current-change="load"
    />
    <el-dialog
      :model-value="!!target"
      :title="operation === 'ACTIVATE' ? '确认渠道行为作用范围' : '确认操作'"
      width="min(680px, 94vw)"
      append-to-body
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @close="closeAction"
    >
      <template v-if="target">
        <h3>被动群聊回复不附带 @ 提醒</h3><p>{{ target.content }}</p><p>{{ scopeText }}</p>
        <template v-if="operation === 'ACTIVATE'">
          <el-alert
            title="这是明确关闭被动群回复中的 @ 提醒，不是降低频率。请确认你确实希望按上述范围启用。"
            type="warning"
            :closable="false"
          />
          <el-checkbox v-model="reviewed">
            我理解：作用于当前角色所有 QQ 绑定的被动群聊回复，正文和引用照常，不影响主动好友联系或群公告。
          </el-checkbox>
        </template>
        <p v-if="operation === 'DISABLE'">
          停用后不再应用这条渠道行为设置；后续是否 @ 仍按原有回复逻辑判断。候选和历史保留。
        </p>
        <p v-if="operation === 'REJECT'">
          驳回后不会生效，候选和审核历史仍保留。
        </p>
        <el-alert
          v-if="dialogError"
          :title="dialogError"
          type="error"
          :closable="false"
        />
      </template>
      <template #footer>
        <el-button
          :disabled="busy"
          @click="closeAction"
        >
          取消
        </el-button><el-button
          type="primary"
          :loading="busy"
          :disabled="operation === 'ACTIVATE' && !reviewed"
          @click="submit"
        >
          确认
        </el-button>
      </template>
    </el-dialog>
    <el-dialog
      :model-value="!!historyTarget"
      title="渠道行为修订历史"
      width="min(720px, 94vw)"
      append-to-body
      @close="closeHistory"
    >
      <el-alert
        v-if="historyError"
        :title="historyError"
        type="error"
        :closable="false"
      />
      <div v-loading="historyLoading">
        <el-empty
          v-if="!historyItems.length && !historyLoading"
          description="暂无修订历史。"
        /><article
          v-for="entry in historyItems"
          :key="`${entry.id}:${entry.revision}`"
          class="policy-item"
        >
          <h3>版本 {{ entry.revision }} · {{ actions[entry.action ?? ''] || entry.action || statuses[entry.status] }}</h3><el-tag>{{ statuses[entry.status] }}</el-tag><p>{{ entry.content }}</p><p>{{ scopeText }}</p>
        </article>
      </div>
      <el-pagination
        v-if="historyTotal > 10"
        v-model:current-page="historyPage"
        :total="historyTotal"
        :page-size="10"
        layout="prev, pager, next, total"
        @current-change="loadHistory"
      />
    </el-dialog>
  </section>
</template>

<style scoped>
.channel-policy-workspace { margin-top: 24px; padding: 22px; display: grid; gap: 16px; min-width: 0; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h2 { margin: 0; color: var(--text); font-size: 18px; }
h3 { margin: 0; color: var(--text); font-size: 16px; line-height: 1.6; overflow-wrap: anywhere; }
p { margin: 8px 0; font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.muted { color: var(--dim); font-size: 12px; }
.policy-item { padding: 20px 0; border-bottom: 1px solid var(--line); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
:deep(.el-checkbox) { height: auto; align-items: flex-start; white-space: normal; margin: 16px 0; }
:deep(.el-checkbox__label) { line-height: 1.8; white-space: normal; font-size: 14px; }
@media (max-width: 700px) { .channel-policy-workspace { padding: 16px; } }
</style>
