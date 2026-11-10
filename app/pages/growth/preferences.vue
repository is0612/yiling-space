<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "偏好系统" } });

type Kind = "LIKE" | "DISLIKE" | "INTEREST";
type Status = "ACTIVE" | "PENDING" | "DISABLED" | "REJECTED";
type SourceType = "MEMORY_EVENT" | "REFLECTION_SUGGESTION";
type Source = { type: SourceType; id: string; title: string; summary: string; hash: string; occurredAt?: string };
type Preference = {
  id: string; characterId: string; kind: Kind; topic: string; reason: string; status: Status; revision: number;
  sourceType: "MANUAL" | "SOURCES"; sourceRefs: Source[]; createdAt: string; updatedAt: string;
};
type Pagination = { page: number; pageSize: number; total: number; pageCount: number };
type Page<T> = { items: T[]; pagination: Pagination };
type Operation = "ACTIVATE" | "REJECT" | "DISABLE";
type Target = { role: string; generation: number; sequence: number };
type History = { id: string; revision: number; kind: Kind; topic: string; reason: string; status: Status; operation?: string; action?: string; createdAt: string };

const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const kindLabels: Record<Kind, string> = { LIKE: "喜欢", DISLIKE: "不喜欢", INTEREST: "感兴趣" };
const statusLabels: Record<Status, string> = { ACTIVE: "已生效", PENDING: "待确认", DISABLED: "已停用", REJECTED: "已驳回" };
const sourceLabels: Record<SourceType, string> = { MEMORY_EVENT: "公开忆泡", REFLECTION_SUGGESTION: "已接受反思" };
const operationLabels: Record<Operation, string> = { ACTIVATE: "确认生效", REJECT: "驳回候选", DISABLE: "停用偏好" };
const keyword = ref("");
const query = ref("");
const status = ref<Status | "ALL">("ACTIVE");
const items = ref<Preference[]>([]);
const page = ref(1);
const total = ref(0);
const pageCount = ref(1);
const loading = ref(false);
const loadError = ref("");
const editorOpen = ref(false);
const editorTarget = ref<(Target & { item: Preference | null }) | null>(null);
const editorMode = ref<"manual" | "sources">("manual");
const draft = ref<{ kind: Kind; topic: string; reason: string; activate: boolean }>({ kind: "LIKE", topic: "", reason: "", activate: true });
const saving = ref(false);
const suggesting = ref(false);
const suggestionMessage = ref("");
let suggestionSequence = 0;
let draftRevision = 0;
const editorError = ref("");
const sourceType = ref<SourceType>("MEMORY_EVENT");
const sourceKeyword = ref("");
const sources = ref<Source[]>([]);
const selectedSources = ref<Source[]>([]);
const sourcePage = ref(1);
const sourceTotal = ref(0);
const sourceLoading = ref(false);
const sourceError = ref("");
const actionOpen = ref(false);
const actionTarget = ref<(Target & { item: Preference; operation: Operation }) | null>(null);
const acting = ref(false);
const actionError = ref("");
const historyOpen = ref(false);
const historyTarget = ref<(Target & { item: Preference }) | null>(null);
const historyItems = ref<History[]>([]);
const historyPage = ref(1);
const historyTotal = ref(0);
const historyLoading = ref(false);
const historyError = ref("");
let generation = 0;
let listSequence = 0;
let editorSequence = 0;
let sourceSequence = 0;
let actionSequence = 0;
let historySequence = 0;
let historyRequest = 0;
let disposed = false;

function api(role: string) { return `/api/characters/${encodeURIComponent(role)}/growth/preferences`; }
function current(target: Target) { return !disposed && target.role === characterId.value && target.generation === generation; }
function editorCurrent(target: Target) { return current(target) && editorOpen.value && target.sequence === editorSequence; }
function actionCurrent(target: Target) { return current(target) && actionOpen.value && target.sequence === actionSequence; }
function historyCurrent(target: Target) { return current(target) && historyOpen.value && target.sequence === historySequence; }
function errorCode(error: unknown) {
  const e = error as { statusCode?: number; status?: number; response?: { status?: number } };
  return e?.statusCode ?? e?.status ?? e?.response?.status;
}
function errorText(error: unknown, fallback: string) {
  const code = errorCode(error);
  if (code === 409) return "记录版本或来源已变化，请刷新后重新操作。";
  if (code === 404) return "角色、偏好或来源已不存在，请刷新后重试。";
  if (code === 403) return "当前账号无权操作该角色。";
  const e = error as { data?: { statusMessage?: string } };
  return e?.data?.statusMessage || fallback;
}
function dateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false }); }
function statusTone(value: Status): "success" | "warning" | "info" { return value === "ACTIVE" ? "success" : value === "PENDING" ? "warning" : "info"; }
async function loadList() {
  const target = { role: characterId.value, generation, sequence: ++listSequence };
  if (!target.role || disposed) return;
  loading.value = true; loadError.value = "";
  // Empty the previous result so failed searches cannot display another filter's records.
  items.value = []; total.value = 0;
  try {
    const result = await $fetch<Page<Preference>>(api(target.role), { query: { status: status.value, q: query.value, page: page.value, pageSize: 20 } });
    if (!current(target) || target.sequence !== listSequence) return;
    items.value = result.items.filter(item => item.characterId === target.role && (status.value === "ALL" || item.status === status.value));
    total.value = result.pagination.total; page.value = result.pagination.page; pageCount.value = result.pagination.pageCount;
  } catch (error) {
    if (current(target) && target.sequence === listSequence) loadError.value = errorText(error, "读取偏好失败，请重试。");
  } finally { if (current(target) && target.sequence === listSequence) loading.value = false; }
}
function search() { query.value = keyword.value.trim(); page.value = 1; void loadList(); }
function changeStatus(value: string | number | boolean | undefined) {
  if (!["ALL", "ACTIVE", "PENDING", "DISABLED", "REJECTED"].includes(String(value))) return;
  status.value = value as Status | "ALL"; page.value = 1; void loadList();
}
function changePage(value: number) { page.value = value; void loadList(); }
function closeEditor() {
  editorSequence += 1; sourceSequence += 1; editorOpen.value = false; editorTarget.value = null;
  saving.value = false; suggesting.value = false; suggestionSequence += 1; suggestionMessage.value = ""; editorError.value = ""; sources.value = []; selectedSources.value = [];
  sourceLoading.value = false; sourceError.value = ""; sourceKeyword.value = ""; sourcePage.value = 1; sourceTotal.value = 0;
  draft.value = { kind: "LIKE", topic: "", reason: "", activate: true };
}
function openEditor(item: Preference | null = null, mode: "manual" | "sources" = "manual") {
  if (!characterId.value || disposed || (item && (item.characterId !== characterId.value || !["ACTIVE", "PENDING", "DISABLED"].includes(item.status)))) return;
  closeEditor();
  editorTarget.value = { role: characterId.value, generation, sequence: editorSequence, item };
  editorMode.value = mode;
  draft.value = { kind: item?.kind ?? "LIKE", topic: item?.topic ?? "", reason: item?.reason ?? "", activate: true };
  sourceType.value = "MEMORY_EVENT"; editorOpen.value = true;
  if (!item && mode === "sources") void loadSources();
}
async function loadSources() {
  const target = editorTarget.value;
  if (!target || !editorCurrent(target) || editorMode.value !== "sources") return;
  const request = ++sourceSequence;
  sourceLoading.value = true; sourceError.value = ""; sources.value = []; sourceTotal.value = 0;
  try {
    const result = await $fetch<Page<Source>>(`${api(target.role)}/sources`, { query: { type: sourceType.value, q: sourceKeyword.value.trim(), page: sourcePage.value, pageSize: 10 } });
    if (!editorCurrent(target) || request !== sourceSequence) return;
    sources.value = result.items; sourcePage.value = result.pagination.page; sourceTotal.value = result.pagination.total;
  } catch (error) {
    if (editorCurrent(target) && request === sourceSequence) sourceError.value = errorText(error, "读取来源失败，请重试。");
  } finally { if (editorCurrent(target) && request === sourceSequence) sourceLoading.value = false; }
}
function changeSourceType() { sourcePage.value = 1; void loadSources(); }
function searchSources() { sourcePage.value = 1; void loadSources(); }
function changeSourcePage(value: number) { sourcePage.value = value; void loadSources(); }
function sourceSelected(source: Source) { return selectedSources.value.some(item => item.type === source.type && item.id === source.id); }
function toggleSource(source: Source) {
  if (saving.value) return;
  suggestionSequence += 1; suggesting.value = false; suggestionMessage.value = "";
  if (sourceSelected(source)) selectedSources.value = selectedSources.value.filter(item => item.type !== source.type || item.id !== source.id);
  else if (selectedSources.value.length < 5) selectedSources.value = [...selectedSources.value, source];
  else ElMessage.warning("最多选择 5 个来源。");
}
function markDraftEdited() { draftRevision += 1; }
async function suggestPreference() {
  const target = editorTarget.value;
  if (!target || !editorCurrent(target) || saving.value || suggesting.value || !selectedSources.value.length || target.item || editorMode.value !== "sources") return;
  const request = ++suggestionSequence;
  const startingDraft = JSON.stringify(draft.value);
  const startingDraftRevision = draftRevision;
  const selected = selectedSources.value.map(({ type, id, hash }) => ({ type, id, hash }));
  const startingSources = JSON.stringify(selected);
  suggesting.value = true; suggestionMessage.value = "";
  try {
    const result = await $fetch<{ suggestion: { kind: Kind; topic: string; reason: string } | null }>(`${api(target.role)}/suggest`, { method: "POST", body: { sources: selected } });
    if (!editorCurrent(target) || request !== suggestionSequence) return;
    if (startingDraftRevision !== draftRevision || startingDraft !== JSON.stringify(draft.value) || startingSources !== JSON.stringify(selectedSources.value.map(({ type, id, hash }) => ({ type, id, hash })))) {
      suggestionMessage.value = "填写内容或来源已变化，本次建议未覆盖你的草稿。"; return;
    }
    if (!result.suggestion) { suggestionMessage.value = "所选来源还不足以支持一条属于她的偏好。可以自行填写判断，或更换依据。"; return; }
    draft.value = { ...draft.value, ...result.suggestion };
    suggestionMessage.value = "已填入可编辑建议，请核对推断与依据；保存后仍为待确认候选。";
  } catch (error) {
    if (editorCurrent(target) && request === suggestionSequence) suggestionMessage.value = errorText(error, "未能生成建议，已保留你的草稿，可继续手动填写。");
  } finally { if (editorCurrent(target) && request === suggestionSequence) suggesting.value = false; }
}
async function saveEditor() {
  const target = editorTarget.value;
  if (!target || !editorCurrent(target) || saving.value || suggesting.value) return;
  const topic = draft.value.topic.trim(); const reason = draft.value.reason.trim();
  if (!topic || !reason || topic.length > 100 || reason.length > 1000) { editorError.value = "请填写主题（1–100 字）与原因（1–1000 字）。"; return; }
  if (!target.item && editorMode.value === "sources" && !selectedSources.value.length) { editorError.value = "请至少选择一个来源；来源只作为依据，偏好主题与原因需要由你填写。"; return; }
  saving.value = true; editorError.value = "";
  try {
    const body = target.item
      ? { operation: "EDIT", expectedRevision: target.item.revision, kind: draft.value.kind, topic, reason }
      : { kind: draft.value.kind, topic, reason, status: editorMode.value === "sources" || !draft.value.activate ? "PENDING" : "ACTIVE", ...(editorMode.value === "sources" ? { sources: selectedSources.value.map(({ type, id, hash }) => ({ type, id, hash })) } : {}) };
    await $fetch(target.item ? `${api(target.role)}/${encodeURIComponent(target.item.id)}` : api(target.role), { method: target.item ? "PATCH" : "POST", body });
    if (!editorCurrent(target)) return;
    const nextStatus = target.item?.status ?? (editorMode.value === "sources" || !draft.value.activate ? "PENDING" : "ACTIVE");
    closeEditor(); status.value = nextStatus; page.value = 1;
    ElMessage.success(target.item ? "偏好已更新，历史版本已保留。" : nextStatus === "PENDING" ? "候选已保存，请审阅后确认生效。" : "偏好已保存并生效。");
    await loadList();
  } catch (error) {
    if (!editorCurrent(target)) return;
    const message = errorText(error, "保存失败，请稍后重试。");
    if (errorCode(error) === 409 || errorCode(error) === 404) { closeEditor(); ElMessage.warning(message); await loadList(); }
    else editorError.value = message;
  } finally { if (editorCurrent(target)) saving.value = false; }
}
function closeAction() { actionSequence += 1; actionOpen.value = false; actionTarget.value = null; acting.value = false; actionError.value = ""; }
function openAction(item: Preference, operation: Operation) {
  if (!characterId.value || disposed || item.characterId !== characterId.value) return;
  if ((operation === "ACTIVATE" && !["PENDING", "DISABLED"].includes(item.status)) || (operation === "REJECT" && item.status !== "PENDING") || (operation === "DISABLE" && item.status !== "ACTIVE")) return;
  closeAction(); actionTarget.value = { role: characterId.value, generation, sequence: actionSequence, item, operation }; actionOpen.value = true;
}
async function confirmAction() {
  const target = actionTarget.value;
  if (!target || !actionCurrent(target) || acting.value) return;
  acting.value = true; actionError.value = "";
  try {
    await $fetch(`${api(target.role)}/${encodeURIComponent(target.item.id)}`, { method: "PATCH", body: { operation: target.operation, expectedRevision: target.item.revision } });
    if (!actionCurrent(target)) return;
    closeAction(); ElMessage.success("偏好状态已更新，操作已留档。"); await loadList();
  } catch (error) {
    if (!actionCurrent(target)) return;
    const message = errorText(error, "操作失败，请稍后重试。");
    if (errorCode(error) === 409 || errorCode(error) === 404) { closeAction(); ElMessage.warning(message); await loadList(); }
    else actionError.value = message;
  } finally { if (actionCurrent(target)) acting.value = false; }
}
function closeHistory() { historySequence += 1; historyRequest += 1; historyOpen.value = false; historyTarget.value = null; historyItems.value = []; historyLoading.value = false; historyError.value = ""; historyTotal.value = 0; }
function openHistory(item: Preference) {
  if (!characterId.value || disposed || item.characterId !== characterId.value) return;
  closeHistory(); historyPage.value = 1;
  historyTarget.value = { role: characterId.value, generation, sequence: historySequence, item }; historyOpen.value = true; void loadHistory();
}
async function loadHistory() {
  const target = historyTarget.value;
  if (!target || !historyCurrent(target)) return;
  const request = ++historyRequest;
  historyLoading.value = true; historyError.value = ""; historyItems.value = []; historyTotal.value = 0;
  try {
    const result = await $fetch<Page<History>>(`${api(target.role)}/${encodeURIComponent(target.item.id)}/history`, { query: { page: historyPage.value, pageSize: 10 } });
    if (!historyCurrent(target) || request !== historyRequest) return;
    historyItems.value = result.items; historyPage.value = result.pagination.page; historyTotal.value = result.pagination.total;
  } catch (error) {
    if (historyCurrent(target) && request === historyRequest) historyError.value = errorText(error, "读取历史失败，请重试。");
  } finally { if (historyCurrent(target) && request === historyRequest) historyLoading.value = false; }
}
function changeHistoryPage(value: number) { historyPage.value = value; void loadHistory(); }
watch(characterId, () => {
  generation += 1; listSequence += 1; closeEditor(); closeAction(); closeHistory();
  keyword.value = ""; query.value = ""; status.value = "ACTIVE"; page.value = 1; pageCount.value = 1;
  items.value = []; total.value = 0; loading.value = false; loadError.value = "";
  if (characterId.value) void loadList();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation += 1; listSequence += 1; closeEditor(); closeAction(); closeHistory(); });
</script>

<template>
  <div class="preferences-page">
    <header class="page-heading">
      <div><h1>她自己的喜好与兴趣</h1><p>记录她喜欢什么、避开什么，以及这些偏好为什么形成。主人的喜好仍保留在记忆中。</p></div>
      <div class="toolbar">
        <el-button
          :disabled="!characterId"
          @click="openEditor(null, 'sources')"
        >
          从经历提出候选
        </el-button><el-button
          type="primary"
          :disabled="!characterId"
          @click="openEditor()"
        >
          手动添加偏好
        </el-button>
      </div>
    </header>
    <el-empty
      v-if="!characterId"
      description="请先在顶栏选择一个角色。"
    />
    <section
      v-else
      class="card preferences-workspace"
    >
      <el-alert
        title="来源提供依据，不自动证明她的喜恶。经历候选需要你填写主题与原因，确认后才会生效；停用后不再用于对话。"
        type="info"
        :closable="false"
        show-icon
      />
      <div class="filters">
        <el-radio-group
          :model-value="status"
          aria-label="偏好状态"
          @update:model-value="changeStatus"
        >
          <el-radio-button
            v-for="(label, key) in statusLabels"
            :key="key"
            :value="key"
          >
            {{ label }}
          </el-radio-button><el-radio-button value="ALL">
            全部
          </el-radio-button>
        </el-radio-group>
        <el-input
          v-model="keyword"
          placeholder="搜索主题或原因"
          clearable
          maxlength="200"
          aria-label="搜索偏好"
          @keyup.enter="search"
          @clear="search"
        >
          <template #append>
            <el-button @click="search">
              搜索
            </el-button>
          </template>
        </el-input>
        <el-button
          :loading="loading"
          @click="loadList"
        >
          刷新
        </el-button>
      </div>
      <el-alert
        v-if="loadError"
        :title="loadError"
        type="error"
        :closable="false"
      />
      <div
        v-loading="loading"
        class="preference-list"
      >
        <el-empty
          v-if="!items.length && !loading"
          :description="loadError ? '暂未加载成功，请刷新重试。' : '当前筛选下没有偏好记录。'"
        />
        <article
          v-for="item in items"
          :key="item.id"
          class="preference-card"
        >
          <header class="record-heading">
            <div class="record-title">
              <el-tag effect="plain">
                {{ kindLabels[item.kind] }}
              </el-tag><h2>{{ item.topic }}</h2>
            </div><el-tag :type="statusTone(item.status)">
              {{ statusLabels[item.status] }}
            </el-tag>
          </header>
          <p class="reason">
            {{ item.reason }}
          </p>
          <details
            v-if="item.sourceRefs.length"
            class="source-details"
          >
            <summary>来源依据 · {{ item.sourceRefs.length }} 条（保存时摘要）</summary><div
              v-for="source in item.sourceRefs"
              :key="`${source.type}:${source.id}`"
              class="source-snapshot"
            >
              <strong>{{ sourceLabels[source.type] }} · {{ source.title }}</strong><p>{{ source.summary }}</p>
            </div><p class="muted">
              摘要保留保存时的依据；候选确认时会重新核对来源。已确认的偏好独立保留，停用后可重新启用。
            </p>
          </details>
          <p
            v-else
            class="muted"
          >
            人工记录 · 由你确认她的偏好
          </p>
          <footer class="record-footer">
            <span class="muted">版本 {{ item.revision }} · 更新于 {{ dateTime(item.updatedAt) }}</span><div class="toolbar">
              <el-button
                v-if="item.status !== 'REJECTED'"
                text
                @click="openEditor(item)"
              >
                编辑
              </el-button><el-button
                text
                @click="openHistory(item)"
              >
                修订历史
              </el-button><el-button
                v-if="item.status === 'PENDING'"
                type="danger"
                plain
                @click="openAction(item, 'REJECT')"
              >
                驳回
              </el-button><el-button
                v-if="item.status === 'ACTIVE'"
                plain
                @click="openAction(item, 'DISABLE')"
              >
                停用
              </el-button><el-button
                v-if="item.status === 'PENDING' || item.status === 'DISABLED'"
                type="primary"
                plain
                @click="openAction(item, 'ACTIVATE')"
              >
                {{ item.status === 'DISABLED' ? '重新启用' : '确认生效' }}
              </el-button>
            </div>
          </footer>
        </article>
      </div>
      <div class="pagination">
        <span class="muted">共 {{ total }} 条</span><el-pagination
          :current-page="page"
          :page-size="20"
          :total="total"
          layout="prev, pager, next"
          :disabled="loading"
          @current-change="changePage"
        />
      </div>
    </section>

    <el-dialog
      :model-value="editorOpen"
      :title="editorTarget?.item ? '编辑偏好' : editorMode === 'sources' ? '从经历提出偏好候选' : '手动添加偏好'"
      width="760px"
      class="preferences-dialog"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @close="closeEditor"
    >
      <template v-if="editorTarget">
        <el-alert
          v-if="editorMode === 'sources' && !editorTarget.item"
          title="请先选择依据，再写出你认为属于她的偏好。也可以主动请求模型提出建议；保存后仍需确认生效。"
          type="info"
          :closable="false"
        />
        <el-form
          label-position="top"
          @submit.prevent="saveEditor"
        >
          <el-form-item label="偏好类型">
            <el-radio-group
              v-model="draft.kind"
              :disabled="saving"
              @change="markDraftEdited"
            >
              <el-radio-button
                v-for="(label, key) in kindLabels"
                :key="key"
                :value="key"
              >
                {{ label }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="主题">
            <el-input
              v-model="draft.topic"
              :disabled="saving"
              maxlength="100"
              show-word-limit
              placeholder="例如：一起观察星空"
              @input="markDraftEdited"
            />
          </el-form-item>
          <el-form-item label="为什么形成这个偏好">
            <el-input
              v-model="draft.reason"
              :disabled="saving"
              type="textarea"
              :rows="3"
              maxlength="1000"
              show-word-limit
              placeholder="写明她喜欢、不喜欢或感兴趣的原因，区分经历事实与你的判断。"
              @input="markDraftEdited"
            />
          </el-form-item>
          <el-form-item v-if="!editorTarget.item && editorMode === 'manual'">
            <el-checkbox
              v-model="draft.activate"
              :disabled="saving"
            >
              我已确认这是她自己的偏好，保存后生效
            </el-checkbox><span class="muted">不勾选时保存为待确认候选。</span>
          </el-form-item>
        </el-form>
        <section
          v-if="!editorTarget.item && editorMode === 'sources'"
          class="source-picker"
        >
          <div class="filters">
            <el-select
              v-model="sourceType"
              :disabled="saving"
              aria-label="来源类型"
              @change="changeSourceType"
            >
              <el-option
                v-for="(label, key) in sourceLabels"
                :key="key"
                :label="label"
                :value="key"
              />
            </el-select><el-input
              v-model="sourceKeyword"
              :disabled="saving"
              placeholder="搜索可选来源"
              maxlength="200"
              aria-label="搜索来源"
              @keyup.enter="searchSources"
            /><el-button
              :disabled="saving"
              :loading="sourceLoading"
              @click="searchSources"
            >
              搜索
            </el-button>
          </div>
          <p class="muted">
            只提供公开且有效的忆泡、已接受的反思。已选 {{ selectedSources.length }}/5 条，翻页后保留选择。
          </p>
          <div
            v-if="selectedSources.length"
            class="chosen-sources"
          >
            <el-tag
              v-for="source in selectedSources"
              :key="`${source.type}:${source.id}`"
              :closable="!saving"
              @close="toggleSource(source)"
            >
              {{ source.title }}
            </el-tag>
          </div>
          <el-alert
            v-if="sourceError"
            :title="sourceError"
            type="error"
            :closable="false"
          />
          <div
            v-loading="sourceLoading"
            class="source-list"
          >
            <el-empty
              v-if="!sources.length && !sourceLoading"
              :description="sourceError ? '来源暂未加载成功。' : '没有符合条件的来源，可更换类型或关键词。'"
              :image-size="50"
            /><div
              v-for="source in sources"
              :key="`${source.type}:${source.id}`"
              class="source-option"
            >
              <el-checkbox
                :model-value="sourceSelected(source)"
                :disabled="saving || (!sourceSelected(source) && selectedSources.length >= 5)"
                @change="toggleSource(source)"
              >
                {{ source.title }}
              </el-checkbox><p>{{ source.summary }}</p><span
                v-if="source.occurredAt"
                class="muted"
              >{{ dateTime(source.occurredAt) }}</span>
            </div>
          </div>
          <el-pagination
            :current-page="sourcePage"
            :page-size="10"
            :total="sourceTotal"
            layout="prev, pager, next"
            :disabled="sourceLoading || saving"
            @current-change="changeSourcePage"
          />
          <div class="suggestion-action">
            <el-button
              :disabled="saving || !selectedSources.length"
              :loading="suggesting"
              @click="suggestPreference"
            >
              根据所选来源提出建议
            </el-button><p class="muted">
              点击后使用当前角色的聊天模型，会产生模型调用费用；建议只填入草稿，不自动保存或生效。
            </p><el-alert
              v-if="suggestionMessage"
              :title="suggestionMessage"
              type="info"
              :closable="false"
            />
          </div>
        </section>
        <el-alert
          v-if="editorError"
          :title="editorError"
          type="error"
          :closable="false"
        />
      </template>
      <template #footer>
        <el-button
          :disabled="saving"
          @click="closeEditor"
        >
          取消
        </el-button><el-button
          type="primary"
          :loading="saving"
          :disabled="suggesting"
          @click="saveEditor"
        >
          {{ editorTarget?.item ? '保存修订' : editorMode === 'sources' || !draft.activate ? '保存候选' : '保存并生效' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      :model-value="actionOpen"
      :title="actionTarget ? actionTarget.item.status === 'DISABLED' ? '重新启用偏好' : operationLabels[actionTarget.operation] : '确认操作'"
      width="480px"
      class="preferences-dialog"
      :close-on-click-modal="false"
      :close-on-press-escape="!acting"
      :show-close="!acting"
      @close="closeAction"
    >
      <template v-if="actionTarget">
        <h3>{{ kindLabels[actionTarget.item.kind] }} · {{ actionTarget.item.topic }}</h3><p class="reason">
          {{ actionTarget.item.reason }}
        </p><p>{{ actionTarget.operation === 'ACTIVATE' ? '确认这属于她自己的偏好？生效后可在相关话题的对话中使用。待确认候选的来源会重新核验；已确认偏好的重新启用保留原有依据。' : actionTarget.operation === 'DISABLE' ? '停用后不再用于对话，记录与历史保留，之后可以重新启用。' : '驳回后不会生效，候选与处置历史仍保留。' }}</p><el-alert
          v-if="actionError"
          :title="actionError"
          type="error"
          :closable="false"
        />
      </template>
      <template #footer>
        <el-button
          :disabled="acting"
          @click="closeAction"
        >
          取消
        </el-button><el-button
          type="primary"
          :loading="acting"
          @click="confirmAction"
        >
          确认
        </el-button>
      </template>
    </el-dialog>

    <el-drawer
      :model-value="historyOpen"
      title="偏好修订历史"
      size="min(600px, 100vw)"
      class="preferences-history"
      @close="closeHistory"
    >
      <template v-if="historyTarget">
        <h2>{{ historyTarget.item.topic }}</h2><p class="muted">
          当前版本 {{ historyTarget.item.revision }}；以下记录保留每次变更的版本与状态。
        </p><el-alert
          v-if="historyError"
          :title="historyError"
          type="error"
          :closable="false"
        /><el-button
          :loading="historyLoading"
          @click="loadHistory"
        >
          刷新历史
        </el-button><div
          v-loading="historyLoading"
          class="history-list"
        >
          <el-empty
            v-if="!historyItems.length && !historyLoading"
            description="暂无历史记录，或历史尚未加载成功。"
          /><article
            v-for="entry in historyItems"
            :key="entry.id"
            class="source-snapshot"
          >
            <div class="record-heading">
              <strong>版本 {{ entry.revision }} · {{ kindLabels[entry.kind] }}</strong><el-tag :type="statusTone(entry.status)">
                {{ statusLabels[entry.status] }}
              </el-tag>
            </div><h3>{{ entry.topic }}</h3><p class="reason">
              {{ entry.reason }}
            </p><span class="muted">{{ dateTime(entry.createdAt) }}</span>
          </article>
        </div><el-pagination
          :current-page="historyPage"
          :page-size="10"
          :total="historyTotal"
          layout="prev, pager, next"
          :disabled="historyLoading"
          @current-change="changeHistoryPage"
        />
      </template>
    </el-drawer>
  </div>
</template>

<style scoped>
.preferences-page { display: grid; gap: 22px; padding: 28px; color: var(--text-2); }
.page-heading, .record-heading, .record-footer, .filters, .toolbar, .pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.page-heading { align-items: flex-start; }
.eyebrow { color: #728097; font-size: 12px; }
h1 { margin: 8px 0 10px; font-size: 25px; }
h2 { margin: 0; font-size: 17px; }
h3 { font-size: 15px; }
p { font-size: 14px; line-height: 1.7; }
.page-heading p { color: #758094; margin: 0; }
.preferences-workspace { padding: 22px; border: 0; box-shadow: none; background: var(--surface); border-radius: 12px; display: grid; gap: 20px; }
.filters { justify-content: flex-start; }
.filters > .el-input { flex: 1; min-width: 180px; max-width: 330px; }
.filters > .el-select { width: 160px; }
.preference-list, .history-list { display: grid; gap: 15px; min-height: 130px; }
.preference-card { padding: 20px; border: 0; border-radius: 12px; background: var(--surface-2); }
.record-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.record-title h2 { overflow-wrap: anywhere; }
.reason, .source-snapshot p, .source-option p { white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--dim); font-size: 12px; line-height: 1.7; }
.record-footer { border-top: 1px solid #eef1f5; margin-top: 16px; padding-top: 12px; }
.source-details { padding: 12px; border-radius: 8px; background: var(--surface-2); }
.source-details summary { cursor: pointer; font-size: 13px; color: #536a86; }
.source-snapshot { margin-top: 12px; padding: 12px; border: 0; border-radius: 8px; background: var(--surface); }
.source-snapshot strong { font-size: 13px; }
.source-snapshot p { margin: 8px 0; }
.source-picker { border-top: 1px solid #e8edf4; padding-top: 18px; margin-bottom: 18px; }
.source-list { min-height: 100px; max-height: 320px; overflow: auto; margin: 10px 0; }
.source-option { padding: 12px 8px; border-bottom: 1px solid #edf0f5; }
.source-option p { margin: 5px 0; font-size: 13px; }
.source-option :deep(.el-checkbox) { height: auto; max-width: 100%; }
.source-option :deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; }
.chosen-sources { display: flex; flex-wrap: wrap; gap: 8px; }
.chosen-sources :deep(.el-tag) { max-width: 100%; height: auto; min-height: 24px; white-space: normal; }
.preferences-dialog :deep(.el-form) { margin-top: 18px; }
.pagination { justify-content: flex-end; }
@media (max-width: 700px) { .preferences-page { padding: 16px; } .preferences-workspace, .preference-card { padding: 14px; } .record-footer .toolbar { width: 100%; justify-content: flex-start; } .filters > .el-input { max-width: none; } .pagination { justify-content: center; } .record-title { align-items: flex-start; } }
</style>
<style>
.preferences-dialog { max-width: calc(100vw - 24px); }
.preferences-dialog .el-dialog__body, .preferences-history .el-drawer__body { font-size: 14px; overflow-wrap: anywhere; }
.preferences-dialog .el-pagination, .preferences-history .el-pagination { flex-wrap: wrap; }
</style>
