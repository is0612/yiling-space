<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";

definePageMeta({
  topbar: {
    title: "互动经验",
    crumbs: [{ label: "记忆系统", to: "/growth/memory" }],
  },
});
type LearningKind = "UNDERSTANDING" | "REFERENCE" | "SITUATION" | "STRATEGY" | "EXPRESSION";
type Learning = { kind: LearningKind; situation: string; misunderstanding: string; correction: string; nextJudgment: string };
type Status = "PENDING" | "ACTIVE" | "DISABLED" | "REJECTED";
type Item = { id: string; content: string; context: string; feedbackQuote: string; status: string; revision: number; conversationId: string; weight: number; createdAt?: string; updatedAt?: string; learning?: unknown };
type Pagination = { page: number; pageSize: number; total: number; pageCount: number };
const learningKinds: Array<{ value: LearningKind; label: string }> = [
  { value: "UNDERSTANDING", label: "理解纠正" }, { value: "REFERENCE", label: "指代识别" },
  { value: "SITUATION", label: "场合判断" }, { value: "STRATEGY", label: "应对策略" },
  { value: "EXPRESSION", label: "表达经验" },
];
/** 与服务端 `parseInteractionExperienceListQuery` 的白名单一致。 */
const statusOptions: Array<{ value: Status | "ALL"; label: string }> = [
  { value: "ACTIVE", label: "已生效" },
  { value: "DISABLED", label: "已停用" },
  { value: "REJECTED", label: "已驳回" },
  { value: "PENDING", label: "待审核" },
  { value: "ALL", label: "全部" },
];
const PAGE_SIZE = 20;
function readLearning(value: unknown): Learning | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!learningKinds.some(kind => kind.value === row.kind)) return null;
  for (const key of ["situation", "misunderstanding", "correction", "nextJudgment"] as const) {
    if (typeof row[key] !== "string" || row[key].length > 400) return null;
  }
  return { kind: row.kind as LearningKind, situation: String(row.situation), misunderstanding: String(row.misunderstanding), correction: String(row.correction), nextJudgment: String(row.nextJudgment) };
}
function learningLabel(value: unknown) { return learningKinds.find(kind => kind.value === readLearning(value)?.kind)?.label ?? "旧版经验"; }
await useCharacterListData();
const route = useRoute();
const { character } = useCharacterSelection(route.path);
const characterId = computed(() => character.value?.id ?? "");
const items = ref<Item[]>([]);
const status = ref<Status | "ALL">("ACTIVE");
const page = ref(1);
const total = ref(0);
const pageCount = ref(1);
type Automation = { enabled: boolean; status: string; lastError: string | null; nextRunAt?: string | null; lastCompletedAt?: string | null };
const automation = ref<Automation | null>(null);
const automationLabel = computed(() => {
  if (!automation.value) return "正在读取自动收尾状态";
  if (!automation.value.enabled) return "互动经验自动整理已关闭";
  return ({ WAITING: "等待对话收尾", IDLE: "等待对话收尾", QUEUED: "等待后台收尾", RUNNING: "正在整理互动经验", RETRY_WAIT: "等待重试", FAILED: "自动收尾失败", SUCCEEDED: "最近收尾已完成", SKIPPED: "本次没有形成经验", CANCELLED: "收尾任务已取消" } as Record<string, string>)[automation.value.status.toUpperCase()] ?? "自动收尾已开启";
});
const automationError = computed(() => ({ MODEL_UNAVAILABLE: "模型暂不可用，请检查角色模型配置。", LEASE_LOST: "处理已交由新的后台任务继续。", SOURCE_CHANGED: "对话依据已变化，后台将重新检查。", MODEL_FAILED: "模型整理失败，等待后台重试。" } as Record<string, string>)[automation.value?.lastError ?? ""] ?? (automation.value?.lastError ? "自动整理暂未完成，请稍后刷新。" : ""));
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const editorError = ref("");
const editing = ref<Item | null>(null);
const draft = reactive({ content: "", context: "", structured: false, kind: "UNDERSTANDING" as LearningKind, situation: "", misunderstanding: "", correction: "", nextJudgment: "" });
let generation = 0;
let actionGeneration = 0;
let disposed = false;
const api = (id: string) => `/api/characters/${encodeURIComponent(id)}/growth/interaction-experiences`;
function fail(e: unknown) {
  const value = e as { data?: { statusMessage?: string; message?: string } };
  return value?.data?.statusMessage ?? value?.data?.message ?? "操作失败，请刷新后重试。";
}
async function load() {
  const id = characterId.value;
  const request = ++generation;
  error.value = "";
  loading.value = Boolean(id);
  if (!id) { items.value = []; total.value = 0; pageCount.value = 1; return; }
  try {
    const result = await $fetch<{ items: Item[]; pagination?: Pagination; automation?: Automation }>(api(id), { query: { status: status.value, page: page.value, pageSize: PAGE_SIZE } });
    if (disposed || request !== generation || id !== characterId.value) return;
    items.value = result.items;
    automation.value = result.automation ?? null;
    total.value = result.pagination?.total ?? result.items.length;
    pageCount.value = result.pagination?.pageCount ?? 1;
    page.value = result.pagination?.page ?? page.value;
    // 停用 / 驳回后本页可能空掉，回退到仍有效的最后一页，别让人停在白页上。
    if (page.value > pageCount.value) { page.value = pageCount.value; void load(); }
  } catch (e) {
    if (!disposed && request === generation && id === characterId.value) error.value = fail(e);
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}
function changeStatus(value: string | number | boolean | undefined) {
  if (!statusOptions.some(option => option.value === value)) return;
  status.value = value as Status | "ALL";
  page.value = 1;
  void load();
}
function changePage(value: number) { page.value = value; void load(); }
function closeEditor() { editing.value = null; editorError.value = ""; }
watch(characterId, () => {
  actionGeneration += 1;
  busy.value = false;
  items.value = [];
  total.value = 0;
  pageCount.value = 1;
  page.value = 1;
  automation.value = null;
  closeEditor();
  void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation += 1; actionGeneration += 1; });
async function operate(item: Item, operation: "EDIT" | "DISABLE" | "ACCEPT" | "REJECT") {
  if (busy.value || disposed) return;
  if (operation === "EDIT") {
    const fields = draft.structured ? [draft.situation, draft.misunderstanding, draft.correction, draft.nextJudgment] : [draft.content, draft.context];
    const required = draft.structured ? [draft.situation, draft.correction, draft.nextJudgment] : [draft.content, draft.context];
    if (required.some(value => !value.trim()) || fields.some(value => value.length > 400) || (draft.structured && !learningKinds.some(kind => kind.value === draft.kind))) {
      editorError.value = draft.structured ? "请填写当时情境、纠正和下次判断，每项最多 400 字；没有原误解可以留空。" : "请填写经验和适用场景，每项最多 400 字。";
      return;
    }
  }
  const learning = draft.structured ? { kind: draft.kind, situation: draft.situation.trim(), misunderstanding: draft.misunderstanding.trim(), correction: draft.correction.trim(), nextJudgment: draft.nextJudgment.trim() } : null;
  const id = characterId.value;
  const action = ++actionGeneration;
  busy.value = true;
  editorError.value = "";
  error.value = "";
  const isCurrent = () => !disposed && action === actionGeneration && id === characterId.value;
  try {
    await $fetch(`${api(id)}/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: { revision: item.revision, operation, ...(operation === "EDIT" ? { content: learning?.nextJudgment ?? draft.content.trim(), context: learning?.situation ?? draft.context.trim(), learning } : {}) },
    });
    if (isCurrent()) {
      closeEditor();
      ElMessage.success(operation === "DISABLE" ? "经验已停用" : operation === "EDIT" ? "经验已纠正" : "旧候选已处理");
      await load();
    }
  } catch (e) {
    if (isCurrent()) {
      if (operation === "EDIT") editorError.value = fail(e);
      else error.value = fail(e);
    }
  } finally { if (isCurrent()) busy.value = false; }
}
async function toggleAutomation() {
  if (busy.value || loading.value || !automation.value || disposed) return;
  const id = characterId.value;
  const action = ++actionGeneration;
  const enabled = !automation.value.enabled;
  busy.value = true;
  error.value = "";
  const isCurrent = () => !disposed && action === actionGeneration && id === characterId.value;
  try {
    await $fetch(`${api(id)}/settings`, { method: "PATCH", body: { enabled } });
    if (isCurrent()) {
      ElMessage.success(enabled ? "互动经验自动整理已开启" : "已停止新整理，已生效经验仍可使用");
      await load();
    }
  } catch (e) { if (isCurrent()) error.value = fail(e); }
  finally { if (isCurrent()) busy.value = false; }
}
function edit(item: Item) {
  if (busy.value) return;
  editing.value = { ...item };
  draft.content = item.content;
  draft.context = item.context;
  const learning = readLearning(item.learning);
  draft.structured = Boolean(learning);
  draft.kind = learning?.kind ?? "UNDERSTANDING";
  draft.situation = learning?.situation ?? "";
  draft.misunderstanding = learning?.misunderstanding ?? "";
  draft.correction = learning?.correction ?? "";
  draft.nextJudgment = learning?.nextJudgment ?? "";
  editorError.value = "";
}
function weight(value: number) { return Number.isFinite(value) ? value.toFixed(2) : "—"; }
function statusLabel(status: string) { return ({ ACTIVE: "已生效", DISABLED: "已停用", REJECTED: "已驳回", PENDING: "待审核" } as Record<string, string>)[status] ?? status; }
function statusTone(status: string): "success" | "warning" | "info" { return status === "ACTIVE" ? "success" : status === "PENDING" ? "warning" : "info"; }
/** 卡片标题取「下次判断」——经验真正的结论；旧版没有结构，用正文。 */
function headline(item: Item) { return readLearning(item.learning)?.nextJudgment || item.content; }
function dateTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="page-wrap experience-page">
    <MemorySectionNavigation active="interaction-experiences" />
    <PageHeader description="她从相处中的反馈里，记住理解、指代、场合与应对上的经验。">
      <template #actions>
        <el-button
          :icon="Refresh"
          :loading="loading"
          :disabled="busy || !characterId"
          @click="load"
        >
          刷新
        </el-button>
      </template>
    </PageHeader>

    <section class="domain-note">
      <p><strong>对话空闲 30 分钟后，后台自动收尾。</strong>有依据才形成经验，并自动生效。</p>
      <p>没有明确反馈，不对回应效果下结论。这是供类似情境参考的经验记忆，不是必须照做的语言规则。经验只在原私聊会话使用，随时间降低召回权重；隐私和明确底线不作为会衰减的临时经验。</p>
    </section>

    <el-empty
      v-if="!characterId"
      description="请先在顶栏选择一个角色。"
    />

    <template v-else>
      <section class="card automation-panel">
        <div class="panel-title-row">
          <div>
            <h2 class="panel-title">
              {{ automationLabel }}
            </h2>
            <p class="panel-sub">
              开启后会调用角色模型整理互动经验；关闭只停止新整理，已生效经验仍可读取。此开关不改变忆泡和阶段总结设置。
            </p>
          </div>
          <el-button
            :disabled="busy || loading || !automation"
            :loading="busy"
            @click="toggleAutomation"
          >
            {{ automation?.enabled ? "关闭自动整理" : "开启自动整理" }}
          </el-button>
        </div>
        <p
          v-if="automationError"
          class="panel-note"
          role="status"
        >
          最近处理提示：{{ automationError }}
        </p>
        <p
          v-if="automation?.nextRunAt"
          class="muted"
        >
          计划收尾时间：{{ dateTime(automation.nextRunAt) }}
        </p>
      </section>

      <section class="card experiences-workspace">
        <div class="filters">
          <div class="workspace-heading">
            <h2>经验档案</h2><span class="muted">{{ statusOptions.find(option => option.value === status)?.label }} · {{ total }} 条</span>
          </div>
          <el-radio-group
            :model-value="status"
            aria-label="互动经验状态"
            @update:model-value="changeStatus"
          >
            <el-radio-button
              v-for="option in statusOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
        </div>

        <p
          v-if="status === 'PENDING'"
          class="muted"
        >
          旧版待审核候选尚未生效；新经验由后台自动形成，无需在这里采纳。证据失效的候选会拒绝处理。
        </p>

        <el-alert
          v-if="error"
          :title="error"
          type="error"
          :closable="false"
          show-icon
        />

        <div
          v-loading="loading"
          class="experience-list"
        >
          <el-empty
            v-if="!items.length && !loading"
            :description="error ? '暂未加载成功，请刷新重试。' : status === 'PENDING' ? '没有待审核的旧候选。' : '暂时没有自动形成的经验；无需手动选择消息。'"
          />
          <article
            v-for="item in items"
            :key="item.id"
            class="experience-card"
          >
            <header class="record-heading">
              <div class="record-title">
                <el-tag effect="plain">
                  {{ learningLabel(item.learning) }}
                </el-tag>
                <h2>{{ headline(item) }}</h2>
              </div>
              <el-tag :type="statusTone(item.status)">
                {{ statusLabel(item.status) }}
              </el-tag>
            </header>
            <div
              v-if="readLearning(item.learning)"
              class="structured-experience"
            >
              <details class="experience-evidence">
                <summary>查看情境与纠正过程</summary>
                <dl class="learning-details">
                  <dt>当时情境</dt><dd>{{ readLearning(item.learning)?.situation || "未记录" }}</dd>
                  <dt>原误解</dt><dd>{{ readLearning(item.learning)?.misunderstanding || "未记录明确误解" }}</dd>
                  <dt>纠正</dt><dd>{{ readLearning(item.learning)?.correction || "未记录" }}</dd>
                </dl>
              </details>
            </div>
            <p
              v-else
              class="context"
            >
              <strong>适用场景：</strong>{{ item.context || "未记录" }}
            </p>
            <blockquote><strong>反馈依据：</strong>{{ item.feedbackQuote }}</blockquote>
            <footer class="record-footer">
              <span class="muted">
                召回权重 {{ weight(item.weight) }} · 仅原会话 · 形成于 {{ dateTime(item.createdAt) }}
              </span>
              <div class="toolbar">
                <el-button
                  v-if="item.status !== 'REJECTED'"
                  text
                  :disabled="busy || loading"
                  @click="edit(item)"
                >
                  纠正
                </el-button>
                <el-button
                  v-if="item.status === 'ACTIVE'"
                  plain
                  :disabled="busy || loading"
                  @click="operate(item, 'DISABLE')"
                >
                  停用
                </el-button>
                <el-button
                  v-if="item.status === 'PENDING'"
                  type="primary"
                  plain
                  :disabled="busy || loading"
                  @click="operate(item, 'ACCEPT')"
                >
                  使旧候选生效
                </el-button>
                <el-button
                  v-if="item.status === 'PENDING'"
                  type="danger"
                  plain
                  :disabled="busy || loading"
                  @click="operate(item, 'REJECT')"
                >
                  驳回
                </el-button>
              </div>
            </footer>
          </article>
        </div>

        <div class="pagination">
          <span class="muted">共 {{ total }} 条</span>
          <el-pagination
            :current-page="page"
            :page-size="PAGE_SIZE"
            :total="total"
            layout="prev, pager, next"
            :disabled="loading"
            @current-change="changePage"
          />
        </div>
      </section>

      <p class="muted">
        权重下降不会删除经验。你可以纠正不准确的内容，或停用不再适合的经验。
      </p>
    </template>

    <el-dialog
      :model-value="!!editing"
      width="min(680px, 94vw)"
      append-to-body
      title="纠正互动经验"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @close="closeEditor"
    >
      <el-alert
        v-if="editorError"
        :title="editorError"
        type="error"
        :closable="false"
        show-icon
      />
      <p v-if="draft.structured">
        纠正整条经验记忆；下次判断和当时情境会同步保存为摘要，不会留下两份冲突内容。
      </p>
      <el-form label-position="top">
        <template v-if="draft.structured">
          <el-form-item label="经验类别">
            <el-select
              v-model="draft.kind"
              :disabled="busy"
            >
              <el-option
                v-for="kind in learningKinds"
                :key="kind.value"
                :label="kind.label"
                :value="kind.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="当时情境">
            <el-input
              v-model="draft.situation"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="原误解（没有明确误解可留空）">
            <el-input
              v-model="draft.misunderstanding"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="纠正">
            <el-input
              v-model="draft.correction"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="下次判断">
            <el-input
              v-model="draft.nextJudgment"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="经验记忆（旧版）">
            <el-input
              v-model="draft.content"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="适用场景">
            <el-input
              v-model="draft.context"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button
          :disabled="busy"
          @click="closeEditor"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="busy"
          @click="editing && operate(editing, 'EDIT')"
        >
          保存纠正
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.experience-page { color: var(--text-2); }
.workspace-heading { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.workspace-heading h2 { margin: 0; font-size: 16px; color: var(--text); }
.experience-evidence { margin-top: 16px; }
.experience-evidence summary { display: list-item; width: fit-content; cursor: pointer; color: var(--dim); font-size: 13px; line-height: 1.8; }
.experience-evidence summary:hover { color: var(--brand); }
.experience-evidence summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 4px; border-radius: 3px; }
.experience-evidence[open] summary { color: var(--brand); }
.structured-experience { min-width: 0; }
.domain-note { margin: 0 0 18px; border-left: 3px solid var(--brand); padding: 2px 18px; }
.domain-note p { margin: 6px 0; font-size: 14px; line-height: 1.7; }
.domain-note p:first-child { color: var(--text-2); }
.domain-note p:last-child { color: var(--dim); }
.automation-panel, .experiences-workspace { border: 0; border-radius: 12px; background: var(--surface, #fff); box-shadow: none; }
.automation-panel { margin-bottom: 18px; padding: 18px 20px; display: grid; gap: 8px; }
.panel-title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.panel-title { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.panel-sub { max-width: 760px; margin: 5px 0 0; color: var(--dim); font-size: 13px; line-height: 1.7; }
.panel-note { margin: 0; color: var(--amber); font-size: 12px; line-height: 1.7; }
.experiences-workspace { margin-bottom: 12px; padding: 0; display: grid; gap: 0; min-width: 0; overflow: hidden; }
.filters { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; margin: 0; padding: 20px 24px; border-bottom: 1px solid var(--line); }
.filters :deep(.el-radio-group) { display: flex; flex-wrap: wrap; gap: 4px; }
.filters :deep(.el-radio-button__inner) { border: 0; border-radius: 6px; box-shadow: none; }
.experience-list { display: grid; gap: 0; min-height: 180px; }
.experience-card { padding: 24px; border-bottom: 1px solid var(--line); background: var(--surface); min-width: 0; }
.experience-card:last-child { border-bottom: 0; }
.experience-card:hover { background: var(--surface-2); }
.record-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.record-title { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; min-width: 0; flex: 1; max-width: 960px; }
.record-title h2 { margin: 0; color: var(--text); font-size: 16px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
.learning-details { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px 14px; margin: 14px 0 0; }
.learning-details dt { color: var(--dim); font-size: 12px; line-height: 1.7; }
.learning-details dd { margin: 0; color: var(--text-2); font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.context { margin: 14px 0 0; color: var(--text-2); font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
blockquote { margin: 12px 0 0; border-radius: var(--radius-sm); background: var(--surface); padding: 10px 12px; color: var(--dim); font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.record-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.muted { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 16px 24px; border-top: 1px solid var(--line); background: var(--surface-2); }
.el-select { width: 100%; }
@media (max-width: 700px) {
  .experience-card, .automation-panel, .filters { padding: 16px; }
  .filters { align-items: stretch; flex-direction: column; }
  .record-heading { align-items: flex-start; }
  .record-heading > .el-tag { flex-shrink: 0; }
  .pagination { padding: 14px; }
  .record-footer .toolbar { width: 100%; justify-content: flex-start; }
  .learning-details { grid-template-columns: minmax(0, 1fr); gap: 2px 0; }
  .learning-details dt { margin-top: 8px; }
  .pagination { justify-content: center; }
}
</style>
