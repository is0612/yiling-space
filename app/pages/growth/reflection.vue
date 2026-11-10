<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "反思系统" } });

type SourceRef = { key: string; type: "memory" | "knowledge" | "snapshot"; id: string; title: string; hash: string; excerpt: string };
type SuggestionStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "DEFERRED";
type Suggestion = {
  id: string; title: string; observation: string; inference: string; recommendation: string;
  sourceRefs: SourceRef[]; status: SuggestionStatus; reviewNote: string | null;
  reviewedAt: string | null; acceptedAt: string | null;
};
type ReflectionRun = {
  id: string; periodStart: string; periodEnd: string; status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  attemptCount: number; maxAttempts: number; runAt: string; lastError: string | null;
  model: string | null; promptVersion: string | null; createdAt: string; completedAt: string | null;
  suggestions: Suggestion[];
};
type ListResult = { items: ReflectionRun[]; total: number; page: number; pageSize: number; totalPages: number; hasMore: boolean };
type Decision = "ACCEPTED" | "REJECTED" | "DEFERRED";
type ActionTarget = { role: string; generation: number; sequence: number; id: string };

const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const runs = ref<ReflectionRun[]>([]);
const total = ref(0);
const page = ref(1);
const totalPages = ref(1);
const loading = ref(false);
const loadError = ref("");
const view = ref<"all" | "accepted">("all");
const days = ref<7 | 14 | 30>(7);
const requestKey = ref("");
const createOpen = ref(false);
const createSaving = ref(false);
const createError = ref("");
const createTarget = ref<ActionTarget | null>(null);
const retryOpen = ref(false);
const retrySaving = ref(false);
const retryError = ref("");
const retryTarget = ref<ActionTarget | null>(null);
const reviewOpen = ref(false);
const reviewSaving = ref(false);
const reviewError = ref("");
const reviewTarget = ref<(ActionTarget & { title: string; decision: Decision }) | null>(null);
const reviewNote = ref("");
const deleteOpen = ref(false);
const deleteSaving = ref(false);
const deleteError = ref("");
const deleteTarget = ref<(ActionTarget & { all: boolean; label: string }) | null>(null);
const deletingRoles = new Set<string>();
let generation = 0;
let listVersion = 0;
let confirmationVersion = 0;
let disposed = false;

const runLabels: Record<ReflectionRun["status"], string> = { QUEUED: "等待整理", RUNNING: "正在反思", SUCCEEDED: "已完成", FAILED: "执行失败" };
const suggestionLabels: Record<SuggestionStatus, string> = { PENDING: "待审阅", ACCEPTED: "成长结论", REJECTED: "已驳回", DEFERRED: "已暂缓" };
const sourceLabels: Record<SourceRef["type"], string> = { memory: "记忆经历", knowledge: "已确认知识", snapshot: "阶段总结" };
const acceptedCount = computed(() => runs.value.reduce((sum, run) => sum + run.suggestions.filter(suggestion => suggestion.status === "ACCEPTED").length, 0));
const pendingCount = computed(() => runs.value.reduce((sum, run) => sum + run.suggestions.filter(suggestion => suggestion.status === "PENDING" || suggestion.status === "DEFERRED").length, 0));
const visibleRuns = computed(() => view.value === "accepted" ? runs.value.filter(run => run.suggestions.some(suggestion => suggestion.status === "ACCEPTED")) : runs.value);
const hasActiveRun = computed(() => runs.value.some(run => run.status === "QUEUED" || run.status === "RUNNING"));

function api(role = characterId.value) { return `/api/characters/${encodeURIComponent(role)}/growth/reflections`; }
function current(role: string, version: number) { return !disposed && characterId.value === role && generation === version; }
function newRequestKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // The key identifies a request, not an authentication secret. Non-secure local browsers may lack randomUUID.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, char => {
    const digit = Math.floor(Math.random() * 16);
    return (char === "x" ? digit : (digit & 3) | 8).toString(16);
  });
}
function errorText(error: unknown, fallback: string) {
  const e = error as { statusCode?: number; status?: number; response?: { status?: number }; data?: { statusMessage?: string } };
  const status = e?.statusCode ?? e?.status ?? e?.response?.status;
  if (status === 404) return "角色、反思任务或建议已不存在，请刷新后重试。";
  if (status === 409) return "状态已发生变化，请刷新后查看最新结果。";
  if (status === 403) return "当前账号无权操作该角色，请检查登录状态。";
  return e?.data?.statusMessage || fallback;
}
function dateTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}
function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("zh-CN");
}
function runTone(status: ReflectionRun["status"]): "warning" | "primary" | "success" | "danger" {
  return ({ QUEUED: "warning", RUNNING: "primary", SUCCEEDED: "success", FAILED: "danger" } as const)[status];
}
function suggestionTone(status: SuggestionStatus): "warning" | "success" | "info" {
  return status === "ACCEPTED" ? "success" : status === "PENDING" ? "warning" : "info";
}
function shownSuggestions(run: ReflectionRun) { return view.value === "accepted" ? run.suggestions.filter(suggestion => suggestion.status === "ACCEPTED") : run.suggestions; }
function canReview(suggestion: Suggestion) { return suggestion.status === "PENDING" || suggestion.status === "DEFERRED"; }
function isActionCurrent(target: ActionTarget) { return current(target.role, target.generation) && target.sequence === confirmationVersion; }

async function load() {
  const role = characterId.value;
  if (!role || disposed) return;
  const roleGeneration = generation;
  const version = ++listVersion;
  loading.value = true;
  loadError.value = "";
  try {
    const result = await $fetch<ListResult>(api(role), { query: { page: page.value, pageSize: 20 } });
    if (!current(role, roleGeneration) || version !== listVersion) return;
    runs.value = result.items;
    total.value = result.total;
    page.value = result.page;
    totalPages.value = result.totalPages;
  } catch (error) {
    if (!current(role, roleGeneration) || version !== listVersion) return;
    loadError.value = errorText(error, "读取反思记录失败，请重试。");
  } finally {
    if (current(role, roleGeneration) && version === listVersion) loading.value = false;
  }
}
function changePage(value: number) { page.value = value; runs.value = []; void load(); }
function setView(value: "all" | "accepted") { view.value = value; }
function closeConfirmations() {
  confirmationVersion += 1;
  createOpen.value = false; retryOpen.value = false; reviewOpen.value = false; deleteOpen.value = false;
  createSaving.value = false; retrySaving.value = false; reviewSaving.value = false; deleteSaving.value = false;
  createTarget.value = null; retryTarget.value = null; reviewTarget.value = null; deleteTarget.value = null;
  createError.value = ""; retryError.value = ""; reviewError.value = ""; reviewNote.value = ""; deleteError.value = "";
}
function changeDays(value: number) {
  if (value !== 7 && value !== 14 && value !== 30) return;
  if (days.value !== value) {
    days.value = value;
    requestKey.value = newRequestKey();
    // A confirmation describes a particular period choice and must be opened again.
    closeConfirmations();
  }
}
function openCreate() {
  if (!characterId.value || disposed) return;
  closeConfirmations();
  if (!requestKey.value) requestKey.value = newRequestKey();
  createTarget.value = { role: characterId.value, generation, sequence: confirmationVersion, id: requestKey.value };
  createOpen.value = true;
}
async function confirmCreate() {
  const target = createTarget.value;
  if (!target || !createOpen.value || createSaving.value || !isActionCurrent(target)) return;
  const selectedDays = days.value;
  createSaving.value = true;
  createError.value = "";
  try {
    const result = await $fetch<{ run: ReflectionRun; created: boolean }>(api(target.role), {
      method: "POST", body: { requestKey: target.id, days: selectedDays },
    });
    if (!isActionCurrent(target)) return;
    requestKey.value = newRequestKey();
    closeConfirmations();
    page.value = 1;
    ElMessage.success(!result.created && result.run.status === "SUCCEEDED" ? "资料没有变化，已复用之前的反思结果，不会重复生成建议。" : "反思请求已提交，请刷新查看执行进度；建议仍需你审阅。");
    await load();
  } catch (error) {
    if (!isActionCurrent(target)) return;
    createError.value = errorText(error, "提交结果未确认，请重试。重试将沿用同一请求编号，避免重复创建。");
  } finally {
    if (isActionCurrent(target)) createSaving.value = false;
  }
}
function openRetry(run: ReflectionRun) {
  if (run.status !== "FAILED" || !characterId.value || disposed) return;
  closeConfirmations();
  retryTarget.value = { role: characterId.value, generation, sequence: confirmationVersion, id: run.id };
  retryOpen.value = true;
}
async function confirmRetry() {
  const target = retryTarget.value;
  if (!target || !retryOpen.value || retrySaving.value || !isActionCurrent(target)) return;
  retrySaving.value = true;
  retryError.value = "";
  try {
    await $fetch(`${api(target.role)}/${encodeURIComponent(target.id)}/retry`, { method: "POST", body: {} });
    if (!isActionCurrent(target)) return;
    closeConfirmations();
    ElMessage.success("失败任务已重新排队，恢复操作已记录。");
    await load();
  } catch (error) {
    if (!isActionCurrent(target)) return;
    retryError.value = errorText(error, "恢复任务失败，请稍后重试。");
  } finally {
    if (isActionCurrent(target)) retrySaving.value = false;
  }
}
function openReview(suggestion: Suggestion, decision: Decision) {
  if (!canReview(suggestion) || !characterId.value || disposed || !["ACCEPTED", "REJECTED", "DEFERRED"].includes(decision)) return;
  if (suggestion.status === "DEFERRED" && decision === "DEFERRED") return;
  closeConfirmations();
  reviewTarget.value = { role: characterId.value, generation, sequence: confirmationVersion, id: suggestion.id, title: suggestion.title, decision };
  reviewNote.value = "";
  reviewOpen.value = true;
}
async function confirmReview() {
  const target = reviewTarget.value;
  if (!target || !reviewOpen.value || reviewSaving.value || !isActionCurrent(target)) return;
  const note = reviewNote.value.trim();
  if (note.length > 500) { reviewError.value = "审阅备注不能超过 500 字。"; return; }
  reviewSaving.value = true;
  reviewError.value = "";
  try {
    await $fetch<{ suggestion: Suggestion }>(`${api(target.role)}/suggestions/${encodeURIComponent(target.id)}/review`, {
      method: "POST", body: { decision: target.decision, ...(note ? { note } : {}) },
    });
    if (!isActionCurrent(target)) return;
    closeConfirmations();
    ElMessage.success(target.decision === "ACCEPTED" ? "已保存为成长结论，不会修改人设或注入对话提示词。" : target.decision === "REJECTED" ? "已驳回建议，记录将保留。" : "已暂缓，可之后继续审阅。");
    await load();
  } catch (error) {
    if (!isActionCurrent(target)) return;
    reviewError.value = errorText(error, "提交审阅失败，请稍后重试。");
  } finally {
    if (isActionCurrent(target)) reviewSaving.value = false;
  }
}

function openDelete(run?: ReflectionRun) {
  const role = characterId.value;
  if (!role || disposed || deletingRoles.has(role) || (!run && total.value <= 0)) return;
  closeConfirmations();
  deleteTarget.value = { role, generation, sequence: confirmationVersion, id: run?.id ?? "", all: !run,
    label: run ? `${shortDate(run.periodStart)} — ${shortDate(run.periodEnd)} 的阶段反思` : "当前角色的全部反思记录" };
  deleteOpen.value = true;
}
async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target || !deleteOpen.value || deleteSaving.value || deletingRoles.has(target.role) || !isActionCurrent(target)) return;
  deleteSaving.value = true;
  deleteError.value = "";
  deletingRoles.add(target.role);
  try {
    const result = await $fetch<{ deletedRuns: number; deletedSuggestions: number }>(target.all ? api(target.role) : `${api(target.role)}/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    if (!isActionCurrent(target)) return;
    closeConfirmations();
    // Invalidate older list reads immediately, including a last-page read issued before deletion.
    listVersion += 1;
    page.value = 1;
    runs.value = [];
    total.value = Math.max(0, total.value - result.deletedRuns);
    requestKey.value = "";
    ElMessage.success(`已删除 ${result.deletedRuns} 次反思及 ${result.deletedSuggestions} 条建议（包括成长结论）。相同来源可重新发起反思。`);
    await load();
  } catch (error) {
    if (!isActionCurrent(target)) return;
    deleteError.value = errorText(error, "删除结果未确认，请刷新核对后重试。");
  } finally {
    deletingRoles.delete(target.role);
    if (isActionCurrent(target)) deleteSaving.value = false;
  }
}

watch(characterId, () => {
  generation += 1; listVersion += 1;
  closeConfirmations();
  runs.value = []; total.value = 0; page.value = 1; totalPages.value = 1;
  view.value = "all"; days.value = 7; requestKey.value = ""; loading.value = false; loadError.value = "";
  void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation += 1; listVersion += 1; closeConfirmations(); });
</script>

<template>
  <div class="page-wrap reflection-page">
    <PageHeader
      description="回看经历，分清事实与推断，再决定哪些值得留下。"
    />
    <el-empty
      v-if="!activeCharacter"
      description="请先从左下角选择角色。"
    />
    <template v-else>
      <section class="card reflection-intro">
        <div class="intro-copy">
          <span class="section-kicker">阶段回望</span>
          <h2>{{ activeCharacter.name }}，这段时间有什么变化？</h2>
          <p>反思只在你主动发起时运行。系统读取当前角色的公开事实、已确认知识与阶段总结，形成带来源的建议，交给你审阅。资料未变化时复用已有结果；新一轮只保留有新增或修改证据的建议。</p>
          <div class="intro-actions">
            <el-select
              :model-value="days"
              aria-label="反思时间范围"
              class="period-select"
              @update:model-value="changeDays"
            >
              <el-option
                :value="7"
                label="最近 7 天"
              />
              <el-option
                :value="14"
                label="最近 14 天"
              />
              <el-option
                :value="30"
                label="最近 30 天"
              />
            </el-select>
            <el-button
              type="primary"
              @click="openCreate"
            >
              发起一次反思
            </el-button>
          </div>
          <span class="muted-note">使用当前角色的聊天模型，会产生模型调用费用。不会自动改变人设。</span>
        </div>
        <div
          class="reflection-summary"
          aria-label="本页反思概况"
        >
          <div><strong>{{ total }}</strong><span>次反思记录</span></div>
          <div><strong>{{ pendingCount }}</strong><span>条本页待审阅</span></div>
          <div><strong>{{ acceptedCount }}</strong><span>条本页成长结论</span></div>
        </div>
      </section>
      <section
        class="reflection-records"
        aria-label="反思记录与成长结论"
      >
        <div class="records-toolbar">
          <el-radio-group
            :model-value="view"
            aria-label="反思记录筛选"
            @update:model-value="value => setView(value as 'all' | 'accepted')"
          >
            <el-radio-button value="all">
              反思记录
            </el-radio-button>
            <el-radio-button value="accepted">
              成长结论 · 本页 {{ acceptedCount }}
            </el-radio-button>
          </el-radio-group>
          <div class="record-actions">
            <el-button
              :loading="loading"
              @click="load"
            >
              刷新记录
            </el-button>
            <el-button
              v-if="total > 0"
              type="danger"
              plain
              :disabled="deleteSaving"
              @click="openDelete()"
            >
              清空全部反思
            </el-button>
          </div>
        </div>
        <p
          v-if="view === 'accepted'"
          class="muted-note"
        >
          只显示当前页已采纳的成长结论；可翻页查看更早记录。结论仅保存留档，不会自动注入聊天或修改人设。
        </p>
        <el-alert
          v-if="hasActiveRun"
          title="有反思正在排队或执行，点击刷新查看进度；离开页面不会取消后台任务。"
          type="info"
          :closable="false"
          show-icon
        />
        <el-alert
          v-if="loadError"
          :title="loadError"
          type="error"
          :closable="false"
          show-icon
        />
        <div
          v-loading="loading"
          class="run-list"
        >
          <el-empty
            v-if="!visibleRuns.length && !loading"
            :description="loadError ? '记录暂未加载成功，请刷新重试。' : view === 'accepted' ? '本页还没有已采纳的成长结论。' : '还没有反思记录，从一次阶段回望开始。'"
          />
          <article
            v-for="run in visibleRuns"
            :key="run.id"
            class="card reflection-run"
          >
            <header class="run-heading">
              <div><span class="section-kicker">{{ shortDate(run.periodStart) }} — {{ shortDate(run.periodEnd) }}</span><h3>阶段反思</h3></div>
              <div class="record-actions">
                <el-tag :type="runTone(run.status)">
                  {{ runLabels[run.status] }}
                </el-tag>
                <el-button
                  type="danger"
                  text
                  :disabled="deleteSaving"
                  @click="openDelete(run)"
                >
                  删除本次反思
                </el-button>
              </div>
            </header>
            <div class="run-meta">
              <span>提交于 {{ dateTime(run.createdAt) }}</span><span>尝试 {{ run.attemptCount }} / {{ run.maxAttempts }}</span><span v-if="run.model">模型 {{ run.model }}</span><span v-if="run.promptVersion">版本 {{ run.promptVersion }}</span>
            </div>
            <div
              v-if="run.status === 'FAILED'"
              class="run-failure"
            >
              <el-alert
                :title="run.lastError || '反思未能完成，可检查模型配置后重试。'"
                type="error"
                :closable="false"
              /><el-button
                type="warning"
                plain
                @click="openRetry(run)"
              >
                重新排队
              </el-button>
            </div>
            <p
              v-else-if="run.status === 'QUEUED' || run.status === 'RUNNING'"
              class="muted-note"
            >
              {{ run.status === 'QUEUED' ? '等待后台执行' : '正在整理来源与形成建议' }} · 本轮可执行时间 {{ dateTime(run.runAt) }}
            </p>
            <p
              v-else-if="run.status === 'SUCCEEDED' && !run.suggestions.length"
              class="reflection-empty"
            >
              这次没有形成足够有依据的建议。没有结论也可以是一份诚实的回望。
            </p>
            <div
              v-for="suggestion in shownSuggestions(run)"
              :key="suggestion.id"
              class="suggestion-card"
            >
              <div class="suggestion-heading">
                <h4>{{ suggestion.title }}</h4><el-tag
                  :type="suggestionTone(suggestion.status)"
                  effect="plain"
                >
                  {{ suggestionLabels[suggestion.status] }}
                </el-tag>
              </div>
              <dl class="reflection-reasoning">
                <div><dt>观察到的事实</dt><dd>{{ suggestion.observation }}</dd></div>
                <div><dt>可能的推断</dt><dd>{{ suggestion.inference }}</dd></div>
                <div><dt>建议如何行动</dt><dd>{{ suggestion.recommendation }}</dd></div>
              </dl>
              <details class="reflection-sources">
                <summary>查看依据 · {{ suggestion.sourceRefs.length }} 条来源</summary>
                <div
                  v-for="source in suggestion.sourceRefs"
                  :key="source.key"
                  class="source-card"
                >
                  <div class="source-heading">
                    <el-tag
                      size="small"
                      type="info"
                    >
                      {{ sourceLabels[source.type] }}
                    </el-tag><strong>{{ source.title || '未命名来源' }}</strong>
                  </div>
                  <blockquote>{{ source.excerpt || '未提供摘录' }}</blockquote>
                  <div class="source-identifiers">
                    引用 {{ source.key }} · {{ source.id }}<br>版本摘要 {{ source.hash }}
                  </div>
                </div>
                <p
                  v-if="!suggestion.sourceRefs.length"
                  class="muted-note"
                >
                  没有附带来源，请谨慎核对这条建议。
                </p>
              </details>
              <div
                v-if="suggestion.reviewedAt || suggestion.reviewNote"
                class="review-record"
              >
                <span>{{ suggestion.status === 'ACCEPTED' ? '采纳于' : '审阅于' }} {{ dateTime(suggestion.acceptedAt || suggestion.reviewedAt) }}</span><p v-if="suggestion.reviewNote">
                  备注：{{ suggestion.reviewNote }}
                </p>
              </div>
              <div
                v-if="canReview(suggestion)"
                class="suggestion-actions"
              >
                <el-button
                  type="primary"
                  plain
                  @click="openReview(suggestion, 'ACCEPTED')"
                >
                  保存为成长结论
                </el-button><el-button @click="openReview(suggestion, 'REJECTED')">
                  驳回
                </el-button><el-button
                  v-if="suggestion.status === 'PENDING'"
                  text
                  @click="openReview(suggestion, 'DEFERRED')"
                >
                  暂缓
                </el-button>
              </div>
            </div>
          </article>
        </div>
        <div class="reflection-pagination">
          <span>共 {{ total }} 次反思 · 第 {{ page }} / {{ Math.max(1, totalPages) }} 页</span><el-pagination
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
    <el-dialog
      :model-value="createOpen"
      title="发起一次阶段反思"
      width="min(540px, 94vw)"
      @update:model-value="value => { if (!value) closeConfirmations(); }"
    >
      <p class="dialog-copy">
        将使用当前角色 <strong>{{ activeCharacter?.name }}</strong> 的聊天模型，分析最近 <strong>{{ days }} 天</strong>的公开事实、已确认知识与阶段总结。时间区间由服务端在提交时确定。
      </p>
      <el-alert
        title="这会产生模型调用费用。结果是待审阅建议，不会自动改变人格、人设或对话提示词。"
        type="warning"
        :closable="false"
        show-icon
      />
      <p class="muted-note">
        网络失败后可直接重试，将沿用同一个请求编号，避免重复创建。
      </p>
      <el-alert
        v-if="createError"
        :title="createError"
        type="error"
        :closable="false"
      />
      <template #footer>
        <el-button @click="closeConfirmations">
          取消
        </el-button><el-button
          type="primary"
          :loading="createSaving"
          @click="confirmCreate"
        >
          确认发起
        </el-button>
      </template>
    </el-dialog>
    <el-dialog
      :model-value="retryOpen"
      title="重新执行失败反思"
      width="min(500px, 94vw)"
      @update:model-value="value => { if (!value) closeConfirmations(); }"
    >
      <p class="dialog-copy">
        重新排队后会使用当前角色的模型执行，可能产生调用费用。恢复操作会留有审计记录。
      </p>
      <el-alert
        v-if="retryError"
        :title="retryError"
        type="error"
        :closable="false"
      />
      <template #footer>
        <el-button @click="closeConfirmations">
          取消
        </el-button><el-button
          type="primary"
          :loading="retrySaving"
          @click="confirmRetry"
        >
          确认重新排队
        </el-button>
      </template>
    </el-dialog>
    <el-dialog
      :model-value="reviewOpen"
      :title="reviewTarget?.decision === 'ACCEPTED' ? '保存为成长结论' : reviewTarget?.decision === 'REJECTED' ? '驳回建议' : '暂缓审阅'"
      width="min(540px, 94vw)"
      @update:model-value="value => { if (!value) closeConfirmations(); }"
    >
      <p class="dialog-copy">
        {{ reviewTarget?.title }}
      </p>
      <el-alert
        v-if="reviewTarget?.decision === 'ACCEPTED'"
        title="采纳只保存成长结论，不注入对话提示词，也不修改角色人设。采纳后不能在这里再次审阅。"
        type="info"
        :closable="false"
      />
      <p
        v-else
        class="muted-note"
      >
        {{ reviewTarget?.decision === 'REJECTED' ? '驳回后记录保留，不再提供审阅按钮。' : '暂缓后仍可回来采纳或驳回。' }}
      </p>
      <el-input
        v-model="reviewNote"
        type="textarea"
        :rows="3"
        :maxlength="500"
        show-word-limit
        placeholder="审阅备注（可选，最多 500 字）"
        aria-label="审阅备注"
      />
      <el-alert
        v-if="reviewError"
        :title="reviewError"
        type="error"
        :closable="false"
      />
      <template #footer>
        <el-button @click="closeConfirmations">
          取消
        </el-button><el-button
          type="primary"
          :loading="reviewSaving"
          @click="confirmReview"
        >
          确认{{ reviewTarget?.decision === 'ACCEPTED' ? '采纳' : reviewTarget?.decision === 'REJECTED' ? '驳回' : '暂缓' }}
        </el-button>
      </template>
    </el-dialog>
    <el-dialog
      :model-value="deleteOpen"
      :title="deleteTarget?.all ? '清空全部反思' : '删除本次反思'"
      width="min(540px, 94vw)"
      @update:model-value="value => { if (!value) closeConfirmations(); }"
    >
      <p class="dialog-copy">
        将删除角色 <strong>{{ activeCharacter?.name }}</strong> 的{{ deleteTarget?.label }}。
      </p>
      <el-alert
        title="删除包括所有建议、审核记录与已保存的成长结论，且不可撤销。正在排队或运行的反思也会删除，后台旧结果不会恢复这些记录。"
        type="warning"
        :closable="false"
        show-icon
      />
      <p class="muted-note">
        删除后，相同来源可重新发起反思；原始记忆、知识与阶段总结保留。
      </p>
      <el-alert
        v-if="deleteError"
        :title="deleteError"
        type="error"
        :closable="false"
      />
      <template #footer>
        <el-button @click="closeConfirmations">
          取消
        </el-button><el-button
          type="danger"
          :loading="deleteSaving"
          @click="confirmDelete"
        >
          {{ deleteTarget?.all ? '确认清空全部' : '确认删除' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.reflection-page { display: grid; gap: 22px; font-size: 14px; }
.reflection-intro { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 32px; padding: 28px; background: linear-gradient(115deg, #fff 35%, #f0f6f5); }
.section-kicker { color: #647b78; font-size: 12px; font-weight: 600; letter-spacing: .04em; }
.intro-copy h2 { margin: 9px 0 12px; color: #293e3b; font-size: 23px; line-height: 1.45; }
.intro-copy p { max-width: 670px; margin: 0 0 20px; color: var(--dim); line-height: 1.85; }
.intro-actions { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.period-select { width: 145px; }
.muted-note { display: block; margin: 10px 0; color: var(--dim); font-size: 12px; line-height: 1.8; }
.reflection-summary { display: grid; gap: 18px; min-width: 128px; align-content: center; padding-left: 25px; border-left: 1px solid #dfe9e6; }
.reflection-summary div { display: grid; grid-template-columns: 45px 1fr; align-items: baseline; gap: 8px; }
.reflection-summary strong { color: #496d63; font-size: 25px; font-weight: 600; }
.reflection-summary span { color: var(--dim); font-size: 12px; }
.reflection-records, .run-list { display: grid; gap: 16px; min-width: 0; }
.records-toolbar, .run-heading, .suggestion-heading, .reflection-pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.record-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.record-actions :deep(.el-button + .el-button) { margin-left: 0; }
.reflection-intro, .reflection-run { border: 0; border-radius: 12px; box-shadow: none; }
.reflection-run { padding: 22px; min-width: 0; }
.run-heading h3 { margin: 6px 0 0; color: #30463f; font-size: 18px; }
.run-meta { display: flex; gap: 8px 18px; flex-wrap: wrap; margin: 15px 0; color: var(--dim); font-size: 12px; }
.run-failure { display: grid; gap: 12px; justify-items: start; }
.reflection-empty { margin: 20px 0 3px; color: var(--dim); font-size: 14px; line-height: 1.8; }
.suggestion-card { margin-top: 18px; padding: 20px; border: 0; border-radius: 12px; background: var(--surface-2); }
.suggestion-heading h4 { margin: 0; color: #30463f; font-size: 16px; line-height: 1.6; }
.reflection-reasoning { display: grid; gap: 14px; margin: 20px 0; }
.reflection-reasoning div { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 16px; }
.reflection-reasoning dt { color: #5f766d; font-size: 12px; font-weight: 600; line-height: 1.9; }
.reflection-reasoning dd { margin: 0; line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; }
.reflection-sources { border-top: 1px solid #e8eeea; padding-top: 14px; }
.reflection-sources summary { cursor: pointer; font-size: 12px; color: #647b71; line-height: 1.8; }
.source-card { padding: 14px; margin-top: 12px; border-radius: 8px; background: var(--surface); }
.source-heading { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.source-heading strong { font-size: 13px; }
.source-card blockquote { margin: 12px 0; padding-left: 12px; border-left: 2px solid #bacfc3; font-size: 13px; line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
.source-identifiers { color: var(--dim); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.review-record { margin-top: 16px; font-size: 12px; color: var(--dim); }
.review-record p { margin: 6px 0; line-height: 1.7; white-space: pre-wrap; }
.suggestion-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 18px; }
.suggestion-actions :deep(.el-button + .el-button) { margin-left: 0; }
.reflection-pagination { color: var(--dim); font-size: 12px; }
.dialog-copy { margin: 0 0 18px; line-height: 1.9; font-size: 14px; }
:deep(.el-dialog__body) { display: grid; gap: 12px; }
@media (max-width: 760px) {
  .reflection-intro { grid-template-columns: 1fr; padding: 20px; gap: 20px; }
  .intro-copy h2 { font-size: 20px; }
  .reflection-summary { grid-template-columns: repeat(3, 1fr); border-left: 0; border-top: 1px solid #dfe9e6; padding: 18px 0 0; gap: 12px; }
  .reflection-summary div { grid-template-columns: 1fr; gap: 4px; }
  .reflection-run { padding: 18px; }
  .suggestion-card { padding: 16px; }
  .reflection-reasoning div { grid-template-columns: 1fr; gap: 4px; }
}
</style>
