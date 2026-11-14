<script setup lang="ts">
import { ElMessage } from "element-plus";
type Status = "PENDING" | "ACTIVE" | "DISABLED" | "REJECTED";
type ChatScope = "ALL" | "GROUP" | "PRIVATE";
type Kind = "UNDERSTANDING" | "REFERENCE" | "SITUATION" | "STRATEGY";
type Item = { id: string; characterId: string; kind: Kind; content: string; context: string; chatScope: ChatScope; reason: string; status: Status; revision: number; sourceRefs?: unknown[]; createdAt: string; updatedAt: string; action?: string };
type Page = { items: Item[]; pagination: { page: number; pageSize: number; total: number; pageCount: number } };
const props = defineProps<{ characterId: string }>();
const labels: Record<Kind, string> = { UNDERSTANDING: "理解纠正", REFERENCE: "指代识别", SITUATION: "场合判断", STRATEGY: "应对策略" };
const statuses: Record<Status, string> = { PENDING: "待审核", ACTIVE: "已生效", DISABLED: "已停用", REJECTED: "已驳回" };
const scopes: Record<ChatScope, string> = { ALL: "所有聊天", GROUP: "仅群聊", PRIVATE: "仅私聊" };
const status = ref<Status>("PENDING"), page = ref(1), total = ref(0), loading = ref(false), error = ref("");
const items = ref<Item[]>([]), target = ref<Item | null>(null), mode = ref<"EDIT" | "ACTIVATE" | "REJECT" | "DISABLE" | null>(null), busy = ref(false), dialogError = ref("");
const draft = reactive({ content: "", context: "", chatScope: "ALL" as ChatScope });
const reviewed = ref(false), historyTarget = ref<Item | null>(null), historyItems = ref<Item[]>([]), historyPage = ref(1), historyTotal = ref(0), historyLoading = ref(false), historyError = ref("");
let generation = 0, sequence = 0, actionSequence = 0, historySequence = 0, disposed = false;
const api = (id: string) => `/api/characters/${encodeURIComponent(id)}/growth/interaction-guidance`;
const fail = (e: unknown) => (e as { data?: { statusMessage?: string; message?: string } })?.data?.statusMessage || (e as { data?: { message?: string } })?.data?.message || "操作未完成，请刷新后重试。";
const current = (id: string, epoch: number) => !disposed && props.characterId === id && generation === epoch;
function closeAction() { actionSequence++; target.value = null; mode.value = null; busy.value = false; dialogError.value = ""; reviewed.value = false; }
function closeHistory() { historySequence++; historyTarget.value = null; historyItems.value = []; historyLoading.value = false; historyError.value = ""; }
async function load() {
  const id = props.characterId, epoch = generation, request = ++sequence;
  if (!id || disposed) return;
  loading.value = true; error.value = "";
  try {
    const result = await $fetch<Page>(api(id), { query: { status: status.value, page: page.value, pageSize: 20 } });
    if (!current(id, epoch) || sequence !== request) return;
    items.value = result.items.filter(item => item.characterId === id && item.status === status.value); total.value = result.pagination.total;
    if (page.value > Math.max(1, result.pagination.pageCount)) { page.value = Math.max(1, result.pagination.pageCount); void load(); }
  } catch (e) { if (current(id, epoch) && sequence === request) error.value = fail(e); }
  finally { if (current(id, epoch) && sequence === request) loading.value = false; }
}
function filter(value: string | number | boolean | undefined) { if (!Object.hasOwn(statuses, String(value))) return; status.value = value as Status; page.value = 1; items.value = []; total.value = 0; void load(); }
function open(item: Item, operation: NonNullable<typeof mode.value>) {
  if (item.characterId !== props.characterId || busy.value) return;
  closeAction(); target.value = { ...item }; mode.value = operation; draft.content = item.content; draft.context = item.context; draft.chatScope = item.chatScope ?? "ALL";
}
async function submit() {
  const item = target.value, operation = mode.value, id = props.characterId, epoch = generation;
  if (!item || !operation || busy.value || (operation === "ACTIVATE" && !reviewed.value)) return;
  if (operation === "EDIT" && (!draft.content.trim() || draft.content.length > 400 || draft.context.length > 400 || !Object.hasOwn(scopes, draft.chatScope))) { dialogError.value = "请填写指导正文（最多400字）及有效范围，场景最多400字。"; return; }
  const request = ++actionSequence; busy.value = true; dialogError.value = "";
  try {
    await $fetch(`${api(id)}/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { operation, expectedRevision: item.revision, ...(operation === "EDIT" ? { content: draft.content.trim(), context: draft.context.trim(), chatScope: draft.chatScope } : {}) } });
    if (!current(id, epoch) || request !== actionSequence) return;
    closeAction(); ElMessage.success("长期指导已更新，历史版本已保留。"); await load();
  } catch (e) { if (current(id, epoch) && request === actionSequence) dialogError.value = fail(e); }
  finally { if (current(id, epoch) && request === actionSequence) busy.value = false; }
}
async function loadHistory() {
  const item = historyTarget.value, id = props.characterId, epoch = generation, request = ++historySequence;
  if (!item) return;
  historyLoading.value = true; historyError.value = "";
  try {
    const result = await $fetch<Page>(`${api(id)}/${encodeURIComponent(item.id)}/history`, { query: { page: historyPage.value, pageSize: 10 } });
    if (!current(id, epoch) || request !== historySequence || historyTarget.value?.id !== item.id) return;
    historyItems.value = result.items; historyTotal.value = result.pagination.total;
  } catch (e) { if (current(id, epoch) && request === historySequence) historyError.value = fail(e); }
  finally { if (current(id, epoch) && request === historySequence) historyLoading.value = false; }
}
function showHistory(item: Item) { closeHistory(); historyTarget.value = item; historyPage.value = 1; void loadHistory(); }
watch(() => props.characterId, () => { generation++; sequence++; closeAction(); closeHistory(); items.value = []; total.value = 0; page.value = 1; status.value = "PENDING"; error.value = ""; loading.value = false; void load(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; sequence++; closeAction(); closeHistory(); });
</script>

<template>
  <section class="guidance-workspace card">
    <header class="heading">
      <div><h2>跨会话长期指导</h2><p>从获授权的教育反馈中提炼理解与应对经验。候选须由主人审核后才生效；原私聊经验仍保留在下方。</p></div>
      <el-button
        :loading="loading"
        :disabled="!characterId || busy"
        @click="load"
      >
        刷新指导
      </el-button>
    </header>
    <el-alert
      title="仅共享已采纳的抽象正文和适用场景，不共享私人原文。指导供判断参考，不覆盖当前明确要求、人设、渠道约束和隐私边界。"
      type="info"
      :closable="false"
    />
    <el-radio-group
      :model-value="status"
      aria-label="长期指导状态"
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
        :description="error ? '指导暂未加载成功。' : '当前状态下没有长期指导。'"
      />
      <article
        v-for="item in items"
        :key="item.id"
        class="guidance-item"
      >
        <header class="heading">
          <h3>{{ item.content }}</h3><el-tag>{{ statuses[item.status] }}</el-tag>
        </header>
        <p>
          <el-tag effect="plain">
            {{ labels[item.kind] }}
          </el-tag> · {{ scopes[item.chatScope ?? 'ALL'] }} · 版本 {{ item.revision }}
        </p>
        <p><strong>适用场景：</strong>{{ item.context || '通用，仍需结合当前对话判断。' }}</p>
        <p><strong>形成原因：</strong>{{ item.reason }}</p>
        <p class="muted">
          私人来源引用 {{ item.sourceRefs?.length ?? 0 }} 条；此处不展示原文，也不因来源引用授予私聊访问权。
        </p>
        <div class="actions">
          <el-button
            v-if="item.status !== 'REJECTED'"
            @click="open(item, 'EDIT')"
          >
            编辑
          </el-button>
          <el-button
            v-if="item.status === 'PENDING' || item.status === 'DISABLED'"
            type="primary"
            @click="open(item, 'ACTIVATE')"
          >
            {{ item.status === 'PENDING' ? '审核采纳' : '重新启用' }}
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
      :title="mode === 'EDIT' ? '编辑长期指导' : mode === 'ACTIVATE' ? '审核并启用长期指导' : '确认操作'"
      width="min(680px, 94vw)"
      append-to-body
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @close="closeAction"
    >
      <template v-if="target">
        <el-form
          v-if="mode === 'EDIT'"
          label-position="top"
        >
          <el-form-item label="抽象指导正文">
            <el-input
              v-model="draft.content"
              type="textarea"
              :rows="3"
              :maxlength="400"
              show-word-limit
            />
          </el-form-item>
          <el-form-item label="适用场景">
            <el-input
              v-model="draft.context"
              type="textarea"
              :rows="2"
              :maxlength="400"
              show-word-limit
              placeholder="仅保留可公开复用的情境，不填私人经历。"
            />
          </el-form-item>
          <el-form-item label="聊天范围">
            <el-select v-model="draft.chatScope">
              <el-option
                v-for="(label, value) in scopes"
                :key="value"
                :label="label"
                :value="value"
              />
            </el-select>
          </el-form-item>
        </el-form>
        <template v-else>
          <h3>{{ target.content }}</h3><p>适用场景：{{ target.context || '通用' }}</p><p>聊天范围：{{ scopes[target.chatScope ?? 'ALL'] }}</p><p>形成原因：{{ target.reason }}</p>
        </template>
        <template v-if="mode === 'ACTIVATE'">
          <el-alert
            title="请核对正文、场景及形成原因均已脱敏。启用后当前角色可在所选范围内跨会话使用；私人来源仍不共享。"
            type="warning"
            :closable="false"
          />
          <el-checkbox v-model="reviewed">
            我已核对全部字段，确认不含私人信息并允许按此范围使用。
          </el-checkbox>
        </template>
        <p v-if="mode === 'DISABLE'">
          停用后不再注入后续聊天，指导及历史保留；原私聊经验不受影响。
        </p>
        <p v-if="mode === 'REJECT'">
          驳回后不生效，保留候选和处置历史。
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
          :disabled="mode === 'ACTIVATE' && !reviewed"
          @click="submit"
        >
          确认
        </el-button>
      </template>
    </el-dialog>
    <el-dialog
      :model-value="!!historyTarget"
      title="长期指导修订历史"
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
        <article
          v-for="item in historyItems"
          :key="`${item.id}:${item.revision}`"
          class="guidance-item"
        >
          <h3>版本 {{ item.revision }} · {{ statuses[item.status] }}</h3><p>{{ item.content }}</p><p>场景：{{ item.context || '通用' }} · {{ scopes[item.chatScope ?? 'ALL'] }}</p><p>原因：{{ item.reason }}</p>
        </article>
      </div>
      <el-pagination
        v-if="historyTotal > 10"
        v-model:current-page="historyPage"
        :total="historyTotal"
        :page-size="10"
        layout="prev, pager, next"
        @current-change="loadHistory"
      />
    </el-dialog>
  </section>
</template>

<style scoped>
.guidance-workspace { padding: 24px; margin-bottom: 24px; display: grid; gap: 18px; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
h2, h3 { margin: 0; color: var(--text); font-size: 16px; line-height: 1.6; overflow-wrap: anywhere; }
p { font-size: 14px; line-height: 1.8; margin: 8px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--dim); font-size: 12px; }
.guidance-item { border-bottom: 1px solid var(--line); padding: 18px 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
@media (max-width: 700px) { .guidance-workspace { padding: 16px; } }
</style>
