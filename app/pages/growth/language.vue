<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "语料 / 表达习惯" } });
type Kind = "TONE" | "WORDING" | "LENGTH";
type Status = "ACTIVE" | "PENDING" | "DISABLED" | "REJECTED";
type SourceType = "MEMORY_EVENT" | "REFLECTION_SUGGESTION";
type Source = { type: SourceType; id: string; title: string; summary: string; hash: string; occurredAt?: string };
type Habit = { id: string; characterId: string; kind: Kind; content: string; context: string; reason: string; status: Status; revision: number; sourceType: "MANUAL" | "SOURCES"; sourceRefs: Source[]; createdAt: string; updatedAt: string };
type History = Habit & { action: string };
type Page<T> = { items: T[]; pagination: { page: number; pageSize: number; total: number; pageCount: number } };
type Operation = "ACTIVATE" | "REJECT" | "DISABLE";
type Target = { role: string; generation: number; sequence: number };
type Draft = { kind: Kind; content: string; context: string; reason: string; activate: boolean };
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const kindLabels: Record<Kind, string> = { TONE: "语气", WORDING: "用词", LENGTH: "回复长短" };
const statusLabels: Record<Status, string> = { ACTIVE: "已生效", PENDING: "待确认", DISABLED: "已停用", REJECTED: "已驳回" };
const sourceLabels: Record<SourceType, string> = { MEMORY_EVENT: "公开忆泡", REFLECTION_SUGGESTION: "已接受反思" };
const actionLabels: Record<string, string> = { CREATE: "创建", EDIT: "编辑", ACTIVATE: "确认生效", REJECT: "驳回", DISABLE: "停用" };
const examples: Record<Kind, string> = { TONE: "例如：对方正在难过时，先温和回应，不急着开玩笑。", WORDING: "例如：解释步骤时，多用日常说法，少堆专业术语。", LENGTH: "例如：日常问候简短回应，需要解释时再展开。" };
const blankDraft = (): Draft => ({ kind: "TONE", content: "", context: "", reason: "", activate: true });
const keyword = ref(""); const query = ref(""); const status = ref<Status | "ALL">("ACTIVE");
const items = ref<Habit[]>([]); const page = ref(1); const total = ref(0); const loading = ref(false); const loadError = ref("");
const editorOpen = ref(false); const editorTarget = ref<(Target & { item: Habit | null }) | null>(null);
const editorMode = ref<"manual" | "sources">("manual"); const draft = ref<Draft>(blankDraft());
const saving = ref(false); const editorError = ref(""); const suggesting = ref(false); const suggestionMessage = ref("");
const sourceType = ref<SourceType>("MEMORY_EVENT"); const sourceKeyword = ref(""); const sources = ref<Source[]>([]); const selectedSources = ref<Source[]>([]);
const sourcePage = ref(1); const sourceTotal = ref(0); const sourceLoading = ref(false); const sourceError = ref("");
const actionOpen = ref(false); const actionTarget = ref<(Target & { item: Habit; operation: Operation }) | null>(null); const acting = ref(false); const actionError = ref("");
const historyOpen = ref(false); const historyTarget = ref<(Target & { item: Habit }) | null>(null); const historyItems = ref<History[]>([]); const historyPage = ref(1); const historyTotal = ref(0); const historyLoading = ref(false); const historyError = ref("");
let generation = 0; let listSequence = 0; let editorSequence = 0; let sourceSequence = 0; let suggestionSequence = 0; let draftRevision = 0; let actionSequence = 0; let historySequence = 0; let historyRequest = 0; let disposed = false;
function api(role: string) { return `/api/characters/${encodeURIComponent(role)}/growth/language`; }
function settingsHref(section: "model" | "catchphrases") { return `/characters/${encodeURIComponent(characterId.value)}/settings/${section}`; }
function current(target: Target) { return !disposed && target.role === characterId.value && target.generation === generation; }
function editorCurrent(target: Target) { return current(target) && editorOpen.value && target.sequence === editorSequence; }
function actionCurrent(target: Target) { return current(target) && actionOpen.value && target.sequence === actionSequence; }
function historyCurrent(target: Target) { return current(target) && historyOpen.value && target.sequence === historySequence; }
function errorCode(error: unknown) { const e = error as { statusCode?: number; status?: number; response?: { status?: number } }; return e?.statusCode ?? e?.status ?? e?.response?.status; }
function errorText(error: unknown, fallback: string) {
  const code = errorCode(error);
  if (code === 409) return "记录版本或来源已变化，请刷新后重新操作。";
  if (code === 404) return "角色、表达习惯或来源已不存在，请刷新后重试。";
  if (code === 403) return "当前账号无权操作该角色。";
  return (error as { data?: { statusMessage?: string } })?.data?.statusMessage || fallback;
}
function dateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false }); }
function statusTone(value: Status): "success" | "warning" | "info" { return value === "ACTIVE" ? "success" : value === "PENDING" ? "warning" : "info"; }
async function loadList() {
  const target = { role: characterId.value, generation, sequence: ++listSequence };
  if (!target.role || disposed) return;
  loading.value = true; loadError.value = ""; items.value = []; total.value = 0;
  try {
    const result = await $fetch<Page<Habit>>(api(target.role), { query: { status: status.value, q: query.value, page: page.value, pageSize: 20 } });
    if (!current(target) || target.sequence !== listSequence) return;
    items.value = result.items.filter(item => item.characterId === target.role && (status.value === "ALL" || item.status === status.value));
    total.value = result.pagination.total; page.value = result.pagination.page;
  } catch (error) { if (current(target) && target.sequence === listSequence) loadError.value = errorText(error, "读取表达习惯失败，请重试。"); }
  finally { if (current(target) && target.sequence === listSequence) loading.value = false; }
}
function search() { query.value = keyword.value.trim(); page.value = 1; void loadList(); }
function changeStatus(value: string | number | boolean | undefined) { if (!["ALL", "ACTIVE", "PENDING", "DISABLED", "REJECTED"].includes(String(value))) return; status.value = value as Status | "ALL"; page.value = 1; void loadList(); }
function changePage(value: number) { page.value = value; void loadList(); }
function closeEditor() {
  editorSequence += 1; sourceSequence += 1; suggestionSequence += 1; editorOpen.value = false; editorTarget.value = null;
  saving.value = false; suggesting.value = false; editorError.value = ""; suggestionMessage.value = ""; draft.value = blankDraft();
  sources.value = []; selectedSources.value = []; sourceLoading.value = false; sourceError.value = ""; sourceKeyword.value = ""; sourcePage.value = 1; sourceTotal.value = 0;
}
function openEditor(item: Habit | null = null, mode: "manual" | "sources" = "manual") {
  if (!characterId.value || disposed || (item && (item.characterId !== characterId.value || !["ACTIVE", "PENDING", "DISABLED"].includes(item.status)))) return;
  closeEditor(); editorTarget.value = { role: characterId.value, generation, sequence: editorSequence, item }; editorMode.value = mode;
  draft.value = { kind: item?.kind ?? "TONE", content: item?.content ?? "", context: item?.context ?? "", reason: item?.reason ?? "", activate: true };
  sourceType.value = "MEMORY_EVENT"; editorOpen.value = true;
  if (!item && mode === "sources") void loadSources();
}
async function loadSources() {
  const target = editorTarget.value;
  if (!target || !editorCurrent(target) || editorMode.value !== "sources") return;
  const request = ++sourceSequence; sourceLoading.value = true; sourceError.value = ""; sources.value = []; sourceTotal.value = 0;
  try {
    const result = await $fetch<Page<Source>>(`${api(target.role)}/sources`, { query: { type: sourceType.value, q: sourceKeyword.value.trim(), page: sourcePage.value, pageSize: 10 } });
    if (!editorCurrent(target) || request !== sourceSequence) return;
    sources.value = result.items; sourcePage.value = result.pagination.page; sourceTotal.value = result.pagination.total;
  } catch (error) { if (editorCurrent(target) && request === sourceSequence) sourceError.value = errorText(error, "读取来源失败，请重试。"); }
  finally { if (editorCurrent(target) && request === sourceSequence) sourceLoading.value = false; }
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
async function suggestHabit() {
  const target = editorTarget.value;
  if (!target || !editorCurrent(target) || saving.value || suggesting.value || !selectedSources.value.length || target.item || editorMode.value !== "sources") return;
  const request = ++suggestionSequence; const startingDraft = JSON.stringify(draft.value); const startingDraftRevision = draftRevision;
  const selected = selectedSources.value.map(({ type, id, hash }) => ({ type, id, hash })); const startingSources = JSON.stringify(selected);
  suggesting.value = true; suggestionMessage.value = "";
  try {
    const result = await $fetch<{ suggestion: { kind: Kind; content: string; context: string; reason: string } | null }>(`${api(target.role)}/suggest`, { method: "POST", body: { sources: selected } });
    if (!editorCurrent(target) || request !== suggestionSequence) return;
    if (startingDraftRevision !== draftRevision || startingDraft !== JSON.stringify(draft.value) || startingSources !== JSON.stringify(selectedSources.value.map(({ type, id, hash }) => ({ type, id, hash })))) { suggestionMessage.value = "填写内容或来源已变化，本次建议未覆盖你的草稿。"; return; }
    if (!result.suggestion) { suggestionMessage.value = "这些来源还不足以支持一条表达习惯。可以补充依据，或自行填写观察。"; return; }
    draft.value = { ...draft.value, ...result.suggestion }; suggestionMessage.value = "建议已填入草稿，请核对和修改；保存候选后还需要人工确认。";
  } catch (error) { if (editorCurrent(target) && request === suggestionSequence) suggestionMessage.value = errorText(error, "未能生成建议，已保留你的草稿，可继续手动填写。"); }
  finally { if (editorCurrent(target) && request === suggestionSequence) suggesting.value = false; }
}
async function saveEditor() {
  const target = editorTarget.value;
  if (!target || !editorCurrent(target) || saving.value || suggesting.value) return;
  const content = draft.value.content.trim(); const context = draft.value.context.trim(); const reason = draft.value.reason.trim();
  if (!content || content.length > 300 || context.length > 200 || !reason || reason.length > 1000) { editorError.value = "请填写习惯（1–300 字）与原因（1–1000 字）；适用场景可留空，最多 200 字。"; return; }
  if (!target.item && editorMode.value === "sources" && !selectedSources.value.length) { editorError.value = "请至少选择一个来源，再填写习惯、适用场景与判断依据。"; return; }
  saving.value = true; editorError.value = "";
  try {
    const body = target.item ? { operation: "EDIT", expectedRevision: target.item.revision, kind: draft.value.kind, content, context, reason }
      : { kind: draft.value.kind, content, context, reason, status: editorMode.value === "sources" || !draft.value.activate ? "PENDING" : "ACTIVE", ...(editorMode.value === "sources" ? { sources: selectedSources.value.map(({ type, id, hash }) => ({ type, id, hash })) } : {}) };
    await $fetch(target.item ? `${api(target.role)}/${encodeURIComponent(target.item.id)}` : api(target.role), { method: target.item ? "PATCH" : "POST", body });
    if (!editorCurrent(target)) return;
    const nextStatus = target.item?.status ?? (editorMode.value === "sources" || !draft.value.activate ? "PENDING" : "ACTIVE");
    closeEditor(); status.value = nextStatus; page.value = 1;
    ElMessage.success(target.item ? "表达习惯已更新，历史版本已保留。" : nextStatus === "PENDING" ? "候选已保存，请审阅后确认生效。" : "表达习惯已保存并生效。"); await loadList();
  } catch (error) {
    if (!editorCurrent(target)) return;
    const message = errorText(error, "保存失败，请稍后重试。");
    if (errorCode(error) === 409 || errorCode(error) === 404) { closeEditor(); ElMessage.warning(message); await loadList(); } else editorError.value = message;
  } finally { if (editorCurrent(target)) saving.value = false; }
}
function closeAction() { actionSequence += 1; actionOpen.value = false; actionTarget.value = null; acting.value = false; actionError.value = ""; }
function openAction(item: Habit, operation: Operation) {
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
    closeAction(); ElMessage.success("表达习惯状态已更新，操作已留档。"); await loadList();
  } catch (error) {
    if (!actionCurrent(target)) return;
    const message = errorText(error, "操作失败，请稍后重试。");
    if (errorCode(error) === 409 || errorCode(error) === 404) { closeAction(); ElMessage.warning(message); await loadList(); } else actionError.value = message;
  } finally { if (actionCurrent(target)) acting.value = false; }
}
function closeHistory() { historySequence += 1; historyRequest += 1; historyOpen.value = false; historyTarget.value = null; historyItems.value = []; historyLoading.value = false; historyError.value = ""; historyTotal.value = 0; }
function openHistory(item: Habit) {
  if (!characterId.value || disposed || item.characterId !== characterId.value) return;
  closeHistory(); historyPage.value = 1; historyTarget.value = { role: characterId.value, generation, sequence: historySequence, item }; historyOpen.value = true; void loadHistory();
}
async function loadHistory() {
  const target = historyTarget.value;
  if (!target || !historyCurrent(target)) return;
  const request = ++historyRequest; historyLoading.value = true; historyError.value = ""; historyItems.value = []; historyTotal.value = 0;
  try {
    const result = await $fetch<Page<History>>(`${api(target.role)}/${encodeURIComponent(target.item.id)}/history`, { query: { page: historyPage.value, pageSize: 10 } });
    if (!historyCurrent(target) || request !== historyRequest) return;
    historyItems.value = result.items; historyPage.value = result.pagination.page; historyTotal.value = result.pagination.total;
  } catch (error) { if (historyCurrent(target) && request === historyRequest) historyError.value = errorText(error, "读取历史失败，请重试。"); }
  finally { if (historyCurrent(target) && request === historyRequest) historyLoading.value = false; }
}
function changeHistoryPage(value: number) { historyPage.value = value; void loadHistory(); }
watch(characterId, () => {
  generation += 1; listSequence += 1; closeEditor(); closeAction(); closeHistory(); keyword.value = ""; query.value = ""; status.value = "ACTIVE"; page.value = 1;
  items.value = []; total.value = 0; loading.value = false; loadError.value = ""; if (characterId.value) void loadList();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation += 1; listSequence += 1; closeEditor(); closeAction(); closeHistory(); });
</script>

<template>
  <div class="expression-page">
    <header class="page-heading">
      <div><h1>慢慢形成她的说话方式</h1><p>把交流中值得留下的语气、用词和回复长短，整理成有依据的表达习惯。</p></div>
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
          手动添加习惯
        </el-button>
      </div>
    </header>
    <section class="domain-note">
      <p><strong>这里记录「怎么说」。</strong>例如：安慰时先接住情绪；讲步骤时用日常词；闲聊简短，解释再展开。</p>
      <p>喜欢聊什么属于偏好；需要原样说出的句子放在梗语录；基础语气与对话示例仍在角色资料中维护。</p>
      <div
        v-if="characterId"
        class="related-links"
      >
        <NuxtLink :to="settingsHref('catchphrases')">
          管理梗语录
        </NuxtLink><NuxtLink :to="settingsHref('model')">
          模型设置
        </NuxtLink>
      </div>
    </section>
    <el-empty
      v-if="!characterId"
      description="请先在顶栏选择一个角色。"
    />
    <section
      v-else
      class="card expression-workspace"
    >
      <el-alert
        title="来源是观察依据，候选需要人工确认才生效。写清适用场景，避免每一轮都用同一种说法。"
        type="info"
        :closable="false"
        show-icon
      />
      <div class="filters">
        <el-radio-group
          :model-value="status"
          aria-label="表达习惯状态"
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
          placeholder="搜索习惯、场景或原因"
          clearable
          maxlength="100"
          aria-label="搜索表达习惯"
          @keyup.enter="search"
          @clear="search"
        >
          <template #append>
            <el-button @click="search">
              搜索
            </el-button>
          </template>
        </el-input><el-button
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
        class="habit-list"
      >
        <el-empty
          v-if="!items.length && !loading"
          :description="loadError ? '暂未加载成功，请刷新重试。' : '当前筛选下没有表达习惯。可以先记录一条你观察到的说话方式。'"
        />
        <article
          v-for="item in items"
          :key="item.id"
          class="habit-card"
        >
          <header class="record-heading">
            <div class="record-title">
              <el-tag effect="plain">
                {{ kindLabels[item.kind] }}
              </el-tag><h2>{{ item.content }}</h2>
            </div><el-tag :type="statusTone(item.status)">
              {{ statusLabels[item.status] }}
            </el-tag>
          </header>
          <p class="context">
            <strong>适用场景：</strong>{{ item.context || '通用；仍需根据当下对话自然使用。' }}
          </p><p class="reason">
            <strong>形成原因：</strong>{{ item.reason }}
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
              候选确认时会重新核对来源；已确认的表达习惯独立保留。
            </p>
          </details><p
            v-else
            class="muted"
          >
            人工记录 · 由你确认她的表达方式
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
      :title="editorTarget?.item ? '编辑表达习惯' : editorMode === 'sources' ? '从经历提出表达习惯候选' : '手动添加表达习惯'"
      width="760px"
      class="expression-dialog"
      :close-on-click-modal="false"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      @close="closeEditor"
    >
      <template v-if="editorTarget">
        <el-alert
          v-if="editorMode === 'sources' && !editorTarget.item"
          title="选择公开依据，再写出观察到的说话方式。可以主动请求模型提出建议，保存后仍需人工确认。"
          type="info"
          :closable="false"
        />
        <el-form
          label-position="top"
          @submit.prevent="saveEditor"
        >
          <el-form-item label="习惯类型">
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
          <el-form-item label="她通常怎么说">
            <el-input
              v-model="draft.content"
              type="textarea"
              :rows="2"
              :disabled="saving"
              maxlength="300"
              show-word-limit
              :placeholder="examples[draft.kind]"
              @input="markDraftEdited"
            />
          </el-form-item>
          <el-form-item label="适用场景（可选）">
            <el-input
              v-model="draft.context"
              :disabled="saving"
              maxlength="200"
              show-word-limit
              placeholder="例如：朋友倾诉烦恼。留空作为通用习惯。"
              @input="markDraftEdited"
            />
            <span class="muted">留空时作为每轮可选的通用习惯；填写场景时，第一批按场景关键词匹配。是否采用仍取决于当前对话。</span>
          </el-form-item>
          <el-form-item label="为什么留下这个习惯">
            <el-input
              v-model="draft.reason"
              :disabled="saving"
              type="textarea"
              :rows="3"
              maxlength="1000"
              show-word-limit
              placeholder="记录观察到的变化和依据，推断的部分请写明。不要把别人喜欢的话题当成她的表达习惯。"
              @input="markDraftEdited"
            />
          </el-form-item>
          <el-form-item v-if="!editorTarget.item && editorMode === 'manual'">
            <el-checkbox
              v-model="draft.activate"
              :disabled="saving"
            >
              我已确认这是她的表达习惯，保存后生效
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
              maxlength="100"
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
            只列出公开有效忆泡和已接受反思。已选 {{ selectedSources.length }}/5 条，翻页后保留选择。
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
              @click="suggestHabit"
            >
              根据所选来源提出建议
            </el-button><p class="muted">
              点击才调用当前角色的聊天模型，可能产生费用。建议只填入可编辑草稿，不自动保存或生效；没有足够依据时可以不给建议。
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
      :title="actionTarget ? actionTarget.item.status === 'DISABLED' ? '重新启用表达习惯' : actionLabels[actionTarget.operation] : '确认操作'"
      width="480px"
      class="expression-dialog"
      :close-on-click-modal="false"
      :close-on-press-escape="!acting"
      :show-close="!acting"
      @close="closeAction"
    >
      <template v-if="actionTarget">
        <h3>{{ kindLabels[actionTarget.item.kind] }} · {{ actionTarget.item.content }}</h3><p class="context">
          适用场景：{{ actionTarget.item.context || '通用' }}
        </p><p class="reason">
          {{ actionTarget.item.reason }}
        </p><p>{{ actionTarget.operation === 'ACTIVATE' ? '确认这属于她的表达习惯？生效后可用于适合的对话场景。待确认候选的来源会重新核验；重新启用保留原有依据。' : actionTarget.operation === 'DISABLE' ? '停用后不再用于对话，记录和历史保留，之后可以重新启用。' : '驳回后不会生效，候选与处置历史仍保留。' }}</p><el-alert
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
      title="表达习惯修订历史"
      size="min(600px, 100vw)"
      class="expression-history"
      @close="closeHistory"
    >
      <template v-if="historyTarget">
        <h2>{{ historyTarget.item.content }}</h2><p class="muted">
          当前版本 {{ historyTarget.item.revision }}；以下是每次操作后的完整记录。
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
              <strong>版本 {{ entry.revision }} · {{ actionLabels[entry.action] || entry.action }} · {{ kindLabels[entry.kind] }}</strong><el-tag :type="statusTone(entry.status)">
                {{ statusLabels[entry.status] }}
              </el-tag>
            </div><h3>{{ entry.content }}</h3><p class="context">
              适用场景：{{ entry.context || '通用' }}
            </p><p class="reason">
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
.expression-page { display: grid; gap: 22px; padding: 28px; color: var(--text-2); }
.page-heading, .record-heading, .record-footer, .filters, .toolbar, .pagination, .related-links { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.page-heading { align-items: flex-start; }
h1 { margin: 8px 0 10px; font-size: 25px; }
h2 { margin: 0; font-size: 17px; }
h3 { font-size: 15px; }
p { font-size: 14px; line-height: 1.7; }
.page-heading p { color: var(--dim); margin: 0; }
.domain-note { border-left: 3px solid var(--brand); padding: 2px 18px; }
.domain-note p { margin: 6px 0; }
.related-links { justify-content: flex-start; font-size: 13px; margin-top: 10px; }
.related-links a { color: var(--brand-strong); }
.expression-workspace { padding: 22px; border: 0; box-shadow: none; background: var(--surface); border-radius: 12px; display: grid; gap: 20px; min-width: 0; }
.filters { justify-content: flex-start; }
.filters > .el-input { flex: 1; min-width: 180px; max-width: 330px; }
.filters > .el-select { width: 160px; }
.habit-list, .history-list { display: grid; gap: 15px; min-height: 130px; }
.habit-card { padding: 20px; border-radius: 12px; background: var(--surface-2); min-width: 0; }
.record-title { display: flex; align-items: flex-start; gap: 10px; min-width: 0; flex: 1; }
.record-title h2 { overflow-wrap: anywhere; white-space: pre-wrap; }
.reason, .context, .source-snapshot p, .source-option p { white-space: pre-wrap; overflow-wrap: anywhere; }
.muted { color: var(--dim); font-size: 12px; line-height: 1.7; }
.record-footer { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 12px; }
.source-details { padding: 12px; border-radius: 8px; background: var(--surface); }
.source-details summary { cursor: pointer; font-size: 13px; color: var(--dim); }
.source-snapshot { margin-top: 12px; padding: 12px; border-radius: 8px; background: var(--surface); }
.source-snapshot strong { font-size: 13px; }
.source-snapshot p { margin: 8px 0; }
.source-picker { border-top: 1px solid var(--line); padding-top: 18px; margin-bottom: 18px; }
.source-list { min-height: 100px; max-height: 320px; overflow: auto; margin: 10px 0; }
.source-option { padding: 12px 8px; border-bottom: 1px solid var(--line); }
.source-option p { margin: 5px 0; font-size: 13px; }
.source-option :deep(.el-checkbox) { height: auto; max-width: 100%; }
.source-option :deep(.el-checkbox__label) { white-space: normal; overflow-wrap: anywhere; }
.chosen-sources { display: flex; flex-wrap: wrap; gap: 8px; }
.chosen-sources :deep(.el-tag) { max-width: 100%; height: auto; min-height: 24px; white-space: normal; }
.suggestion-action { margin-top: 16px; }
.expression-dialog :deep(.el-form) { margin-top: 18px; }
.pagination { justify-content: flex-end; }
@media (max-width: 700px) { .expression-page { padding: 16px; } .expression-workspace, .habit-card { padding: 14px; } .record-footer .toolbar { width: 100%; justify-content: flex-start; } .filters > .el-input { max-width: none; } .pagination { justify-content: center; } }
</style>
<style>
.expression-dialog { max-width: calc(100vw - 24px); }
.expression-dialog .el-dialog__body, .expression-history .el-drawer__body { font-size: 14px; overflow-wrap: anywhere; }
.expression-dialog .el-pagination, .expression-history .el-pagination { flex-wrap: wrap; }
</style>
