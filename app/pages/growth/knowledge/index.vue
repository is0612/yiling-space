<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "知识系统" } });

type KnowledgeResult = {
  isKnowledge: boolean;
  recommendation: "CREATE" | "DUPLICATE" | "CONFLICT" | "DISCARD";
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number;
  reason: string;
  relatedItemIds: string[];
  confirmedRelatedItemIds?: string[];
};
type KnowledgeRelatedItem = { id: string; title: string; content: string; category: string; tags: string[]; revision: number };
type KnowledgeRelationView = {
  id: string; sourceItemId: string; targetItemId: string; relationType: string; status: string; resolution: string | null; metadata: unknown; updatedAt: string;
  relatedItem: { id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null; status: string; revision: number; sourceType: string; sourceRef: unknown };
};
type KnowledgeMergeDraft = {
  sourceItemId: string; targetItemId: string; expectedSourceRevision: number; expectedTargetRevision: number;
  sourceTitle: string; sourceContent: string; sourceCategory: string; sourceConfidence: number | null; sourceTags: string[];
  sourceType: string; sourceRef: unknown;
  targetTitle: string; targetContent: string; targetCategory: string; targetConfidence: number | null; targetTags: string[];
  targetSourceType: string; targetSourceRef: unknown;
  title: string; content: string; category: string; tagsText: string; confidence: string;
};
type Candidate = {
  id: string; sourceType: string; sourceRef: unknown; rawContent: string; status: string;
  processedResult: KnowledgeResult | null; processingError: string | null; processedAt: string | null; createdAt: string;
  relatedItems: KnowledgeRelatedItem[];
};
type KnowledgeEntry = {
  id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null;
  status: string; sourceType: string; sourceRef: unknown; revision: number; createdAt: string; updatedAt: string;
  /** 回收站接口给的展示派生字段：参与过合并审计链时为 false。只用于禁用按钮，不能当作删除依据。 */
  canPermanentlyDelete?: boolean;
};
type KnowledgeItem = KnowledgeEntry & { relations: KnowledgeRelationView[] };
type KnowledgeItemRevision = {
  id: string; revision: number; title: string; content: string; category: string; tags: string[];
  confidence: number | null; status: string; sourceType: string; sourceRef: unknown; createdAt: string;
};
type KnowledgeItemDraft = { title: string; content: string; category: string; tagsText: string; confidence: string };
type WorkspaceData = { candidates: Candidate[]; items: KnowledgeItem[]; candidateCount: number; itemCount: number };

/** 生命周期操作只需要标识、标题、版本号和状态，弹窗里保存这份最小快照即可。 */
type LifecycleTarget = { id: string; title: string; revision: number; status: string; canPermanentlyDelete?: boolean };

/** 三个分区各自只显示一种状态；分区之间不共享列表数据。 */
type KnowledgeTab = "library" | "archive" | "trash";
type ActionOutcome = "done" | "conflict" | "failed";
type LifecycleOperation = "ARCHIVE" | "UNARCHIVE" | "TRASH" | "RESTORE";
type ConfirmKind = "TRASH" | "ARCHIVED_TRASH" | "PURGE" | "CANDIDATE_DELETE" | "CANDIDATE_BATCH_DELETE" | "CANDIDATE_PURGE_ALL";
type ConfirmState = {
  kind: ConfirmKind;
  title: string;
  message: string;
  detail: string;
  confirmLabel: string;
  danger: boolean;
  item?: LifecycleTarget;
  candidate?: { id: string; rawContent: string; status: string };
  candidateIds?: string[];
};

const LIFECYCLE_PATHS: Record<LifecycleOperation, string> = {
  ARCHIVE: "archive", UNARCHIVE: "unarchive", TRASH: "trash", RESTORE: "restore",
};
const LIFECYCLE_FALLBACK_MESSAGES: Record<LifecycleOperation, string> = {
  ARCHIVE: "知识已归档，不再参与检索。",
  UNARCHIVE: "知识已恢复到知识库。",
  TRASH: "知识已移入回收站，不再参与检索。",
  RESTORE: "知识已从回收站恢复到知识库。",
};
const LIFECYCLE_FAILURES: Record<LifecycleOperation, string> = {
  ARCHIVE: "归档失败。", UNARCHIVE: "恢复失败。", TRASH: "移入回收站失败。", RESTORE: "恢复失败。",
};
/** 永久删除的二次确认口令与后端 knowledge-lifecycle.ts 保持一致。 */
const PURGE_CONFIRMATION = "PERMANENT_DELETE";
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const loading = ref(false);
const savingCandidate = ref(false);
const importingFile = ref(false);
const importingWeb = ref(false);
const webImportUrl = ref("");
const importFileInput = ref<HTMLInputElement | null>(null);
const rawContent = ref("");
const keyword = ref("");
const data = ref<WorkspaceData>({ candidates: [], items: [], candidateCount: 0, itemCount: 0 });
const busyIds = ref<string[]>([]);
const editingItemId = ref("");
const editDraft = ref<KnowledgeItemDraft>({ title: "", content: "", category: "", tagsText: "", confidence: "" });
const savingItem = ref(false);
const historyItemId = ref("");
const historyLoading = ref(false);
const historyItems = ref<KnowledgeItemRevision[]>([]);
const mergeDraft = ref<KnowledgeMergeDraft | null>(null);
const mergingKnowledge = ref(false);
const resolvingRelationIds = ref<string[]>([]);
const activeTab = ref<KnowledgeTab>("library");
const archivedItems = ref<KnowledgeEntry[]>([]);
const trashItems = ref<KnowledgeEntry[]>([]);
const archiveLoaded = ref(false);
const trashLoaded = ref(false);
const archivePage = ref(1);
const trashPage = ref(1);
const archivePageCount = ref(1);
const trashPageCount = ref(1);
const archiveTotalCount = ref(0);
const trashTotalCount = ref(0);
const selectedCandidateIds = ref<string[]>([]);
const workspaceView = ref<"candidates" | "library">("candidates");
const collectorOpen = ref(false);
const candidateFilter = ref("TODO");
const candidateKeyword = ref("");
const selectedProcessIds = ref<string[]>([]);
const batchRunning = ref(false);
const batchStopRequested = ref(false);
const batchProgress = ref({ total: 0, completed: 0, succeeded: 0, failed: 0 });
const batchFailures = ref<Array<{ id: string; message: string }>>([]);
const expandedCandidateIds = ref<string[]>([]);
const confirmDialog = ref<ConfirmState | null>(null);
const actionBusy = ref(false);
let historyRequestVersion = 0;

let loadVersion = 0;
let roleVersion = 0;
let pageDisposed = false;

function emptyWorkspaceData(): WorkspaceData {
  return { candidates: [], items: [], candidateCount: 0, itemCount: 0 };
}

function isCurrentRole(targetCharacterId: string, expectedRoleVersion: number): boolean {
  return !pageDisposed
    && characterId.value === targetCharacterId
    && roleVersion === expectedRoleVersion;
}

function knowledgeBase(targetCharacterId: string) {
  return `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge`;
}

/** 知识库只显示 ACTIVE；接口层面已经过滤，这里再挡一次，避免查询参数出错时混入其它状态。 */
const libraryItems = computed(() => (data.value.items ?? []).filter(item => item.status === "ACTIVE"));
const candidateFilters = [
  { value: "TODO", label: "待整理", statuses: ["PENDING", "FAILED"] },
  { value: "REVIEW", label: "待确认", statuses: ["REVIEW"] },
  { value: "PROCESSING", label: "处理中", statuses: ["PROCESSING"] },
  { value: "ACCEPTED", label: "已入库", statuses: ["ACCEPTED"] },
  { value: "DISMISSED", label: "已忽略", statuses: ["DISMISSED"] },
  { value: "ALL", label: "全部", statuses: [] },
];
const visibleCandidates = computed(() => {
  const statuses = candidateFilters.find(filter => filter.value === candidateFilter.value)?.statuses ?? [];
  const query = candidateKeyword.value.trim().toLocaleLowerCase();
  return data.value.candidates.filter(candidate => (!statuses.length || statuses.includes(candidate.status))
    && (!query || [candidate.rawContent, candidate.processedResult?.title ?? ""].some(text => text.toLocaleLowerCase().includes(query))));
});
const processableCandidates = computed(() => visibleCandidates.value.filter(candidate => ["PENDING", "FAILED", "REVIEW"].includes(candidate.status) && !busyIds.value.includes(candidate.id)));
const selectedProcessCandidates = computed(() => processableCandidates.value.filter(candidate => selectedProcessIds.value.includes(candidate.id)));
const allProcessSelected = computed(() => processableCandidates.value.length > 0 && selectedProcessCandidates.value.length === processableCandidates.value.length);
function toggleProcessSelection(id: string) {
  if (batchRunning.value) return;
  selectedProcessIds.value = selectedProcessIds.value.includes(id) ? selectedProcessIds.value.filter(value => value !== id) : [...selectedProcessIds.value, id];
}
function toggleAllProcess() {
  if (batchRunning.value) return;
  selectedProcessIds.value = allProcessSelected.value ? [] : processableCandidates.value.map(candidate => candidate.id);
}
function toggleCandidateExpanded(id: string) {
  expandedCandidateIds.value = expandedCandidateIds.value.includes(id) ? expandedCandidateIds.value.filter(value => value !== id) : [...expandedCandidateIds.value, id];
}
const dismissedCandidates = computed(() => (data.value.candidates ?? []).filter(candidate => candidate.status === "DISMISSED"));
const selectedDismissedCandidates = computed(
  () => dismissedCandidates.value.filter(candidate => selectedCandidateIds.value.includes(candidate.id)),
);
const allDismissedSelected = computed(
  () => dismissedCandidates.value.length > 0 && selectedDismissedCandidates.value.length === dismissedCandidates.value.length,
);
const knowledgeTabs = computed(() => [
  { key: "library" as KnowledgeTab, label: "知识库", count: data.value.itemCount, known: true },
  { key: "archive" as KnowledgeTab, label: "归档知识", count: archiveTotalCount.value, known: archiveLoaded.value },
  { key: "trash" as KnowledgeTab, label: "回收站", count: trashTotalCount.value, known: trashLoaded.value },
]);

/**
 * 读取当前角色的数据。
 *
 * 工作区（候选 + ACTIVE 知识 + 计数）每次都要读，用来更新计数和候选区；
 * 归档 / 回收站只在对应分区被打开时额外读一次，避免每次操作都打三个接口。
 * 所有请求共用同一个版本号：任一分区的旧响应都不能写进新角色或新分区。
 */
async function load(
  requestedCharacterId: string = characterId.value,
  requestedKeyword: string = keyword.value.trim(),
  requestedTab: KnowledgeTab = activeTab.value,
) {
  const requestVersion = ++loadVersion;
  const requestedRoleVersion = roleVersion;
  if (pageDisposed || requestedCharacterId !== characterId.value) return;
  if (!requestedCharacterId) {
    data.value = emptyWorkspaceData();
    archivedItems.value = [];
    trashItems.value = [];
    archiveLoaded.value = false;
    trashLoaded.value = false;
    loading.value = false;
    return;
  }

  loading.value = true;
  const base = knowledgeBase(requestedCharacterId);
  try {
    const workspacePromise = $fetch<WorkspaceData>(
      base,
      { query: requestedKeyword ? { q: requestedKeyword } : {} },
    );
    const archivePromise = requestedTab === "archive"
      ? $fetch<{ items: KnowledgeEntry[]; itemPagination: { page: number; pageSize: number; total: number; pageCount: number } }>(
          base,
          { query: { itemStatus: "ARCHIVED", ...(requestedKeyword ? { q: requestedKeyword } : {}), page: archivePage.value } },
        )
      : null;
    const trashPromise = requestedTab === "trash"
      ? $fetch<{ items: KnowledgeEntry[]; pagination: { page: number; pageSize: number; total: number; pageCount: number } }>(
          `${base}/trash`,
          { query: { ...(requestedKeyword ? { q: requestedKeyword } : {}), page: trashPage.value } },
        )
      : null;
    const [workspace, archived, trash] = await Promise.all([workspacePromise, archivePromise, trashPromise]);
    if (requestVersion !== loadVersion || !isCurrentRole(requestedCharacterId, requestedRoleVersion)) return;
    data.value = workspace;
    if (archived && archivePage.value > archived.itemPagination.pageCount) {
      archivePage.value = archived.itemPagination.pageCount;
      void load(requestedCharacterId, requestedKeyword, requestedTab);
      return;
    }
    if (trash && trashPage.value > trash.pagination.pageCount) {
      trashPage.value = trash.pagination.pageCount;
      void load(requestedCharacterId, requestedKeyword, requestedTab);
      return;
    }
    if (archived) {
      archivedItems.value = (archived.items ?? []).filter(item => item.status === "ARCHIVED");
      archiveTotalCount.value = archived.itemPagination.total;
      archivePageCount.value = archived.itemPagination.pageCount;
      archiveLoaded.value = true;
    }
    if (trash) {
      trashItems.value = (trash.items ?? []).filter(item => item.status === "TRASHED");
      trashTotalCount.value = trash.pagination.total;
      trashPageCount.value = trash.pagination.pageCount;
      trashLoaded.value = true;
    }
    // 候选被删除后，选择集合里不能留下已经不存在的 ID。
    const candidateIds = new Set((workspace.candidates ?? []).map(candidate => candidate.id));
    selectedCandidateIds.value = selectedCandidateIds.value.filter(id => candidateIds.has(id));
  } catch (error) {
    if (requestVersion !== loadVersion || !isCurrentRole(requestedCharacterId, requestedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "读取知识系统失败。");
  } finally {
    if (requestVersion === loadVersion && isCurrentRole(requestedCharacterId, requestedRoleVersion)) {
      loading.value = false;
    }
  }
}

function changeArchivePage(page: number) {
  if (page < 1 || page > archivePageCount.value || page === archivePage.value || loading.value) return;
  archivePage.value = page;
  void load(characterId.value, keyword.value.trim(), "archive");
}

function changeTrashPage(page: number) {
  if (page < 1 || page > trashPageCount.value || page === trashPage.value || loading.value) return;
  trashPage.value = page;
  void load(characterId.value, keyword.value.trim(), "trash");
}

function selectTab(tab: KnowledgeTab) {
  if (activeTab.value === tab) return;
  activeTab.value = tab;
  // 切分区时收起编辑、历史和确认框，避免上一个分区的草稿出现在新分区。
  editingItemId.value = "";
  historyRequestVersion += 1;
  historyItemId.value = "";
  historyItems.value = [];
  historyLoading.value = false;
  confirmDialog.value = null;
  void load(characterId.value, keyword.value.trim(), tab);
}

watch(characterId, (nextCharacterId: string) => {
  // 切换角色立即作废旧请求，并清空旧角色内容，避免旧资料短暂显示在新角色名下。
  roleVersion += 1;
  loadVersion += 1;
  data.value = emptyWorkspaceData();
  rawContent.value = "";
  busyIds.value = [];
  savingCandidate.value = false;
  importingFile.value = false;
  importingWeb.value = false;
  webImportUrl.value = "";
  if (importFileInput.value) importFileInput.value.value = "";
  editingItemId.value = "";
  editDraft.value = { title: "", content: "", category: "", tagsText: "", confidence: "" };
  savingItem.value = false;
  historyItemId.value = "";
  historyLoading.value = false;
  historyItems.value = [];
  historyRequestVersion += 1;
  mergeDraft.value = null;
  mergingKnowledge.value = false;
  resolvingRelationIds.value = [];
  activeTab.value = "library";
  archivedItems.value = [];
  trashItems.value = [];
  archiveLoaded.value = false;
  trashLoaded.value = false;
  archivePage.value = 1;
  trashPage.value = 1;
  archivePageCount.value = 1;
  trashPageCount.value = 1;
  archiveTotalCount.value = 0;
  trashTotalCount.value = 0;
  selectedCandidateIds.value = [];
  selectedProcessIds.value = [];
  expandedCandidateIds.value = [];
  candidateFilter.value = "TODO";
  candidateKeyword.value = "";
  workspaceView.value = "candidates";
  collectorOpen.value = false;
  batchRunning.value = false;
  batchStopRequested.value = false;
  batchProgress.value = { total: 0, completed: 0, succeeded: 0, failed: 0 };
  batchFailures.value = [];
  confirmDialog.value = null;
  actionBusy.value = false;
  loading.value = false;
  if (nextCharacterId) void load(nextCharacterId);
}, { immediate: true, flush: "sync" });
watch(keyword, () => {
  archivePage.value = 1;
  trashPage.value = 1;
  void load();
});

onBeforeUnmount(() => {
  pageDisposed = true;
  roleVersion += 1;
  loadVersion += 1;
  historyRequestVersion += 1;
});

async function addCandidate() {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  const content = rawContent.value.trim();
  if (!targetCharacterId || savingCandidate.value || !content || pageDisposed) return;
  savingCandidate.value = true;
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates`,
      { method: "POST", body: { rawContent: content, sourceType: "MANUAL" } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    rawContent.value = "";
    ElMessage.success("已加入知识候选。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "添加候选失败。");
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) savingCandidate.value = false;
  }
}

async function importDocument(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!file || !targetCharacterId || importingFile.value || pageDisposed) return;
  if (file.size > 2 * 1024 * 1024) {
    ElMessage.error("单个文件不能超过 2 MB。");
    input.value = "";
    return;
  }
  const form = new FormData();
  form.append("file", file, file.name);
  importingFile.value = true;
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/import`,
      { method: "POST", body: form },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("文件已加入知识候选，请运行知识处理助手整理。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "文件导入失败。");
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) importingFile.value = false;
    if (input) input.value = "";
  }
}

async function importWebPage() {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  const url = webImportUrl.value.trim();
  if (!targetCharacterId || !url || importingWeb.value || pageDisposed) return;
  importingWeb.value = true;
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/web-import`,
      { method: "POST", body: { url } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    webImportUrl.value = "";
    ElMessage.success("网页正文已加入知识候选，请运行知识处理助手整理。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "网页导入失败。");
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) importingWeb.value = false;
  }
}

/** 快照当前所选，逐条复用已有鉴权与原子认领接口；停止仅影响尚未开始的条目。 */
async function runBatchCandidates() {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || batchRunning.value || busyIds.value.length || actionBusy.value) return;
  const candidates = [...(selectedProcessCandidates.value.length ? selectedProcessCandidates.value : processableCandidates.value)];
  if (!candidates.length) return;
  batchRunning.value = true;
  batchStopRequested.value = false;
  batchFailures.value = [];
  batchProgress.value = { total: candidates.length, completed: 0, succeeded: 0, failed: 0 };
  try {
    for (const candidate of candidates) {
      if (!isCurrentRole(targetCharacterId, expectedRoleVersion) || batchStopRequested.value) break;
      busyIds.value = [...busyIds.value, candidate.id];
      try {
        const response = await $fetch<{ candidate: Pick<Candidate, "status" | "processedResult" | "processedAt"> }>(
          knowledgeBase(targetCharacterId) + "/candidates/" + encodeURIComponent(candidate.id) + "/process",
          { method: "POST" },
        );
        if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
        const current = data.value.candidates.find(item => item.id === candidate.id);
        if (current) Object.assign(current, response.candidate, { processingError: null });
        batchProgress.value.succeeded += 1;
      } catch (error) {
        if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
        const e = error as { data?: { statusMessage?: string } };
        batchFailures.value.push({ id: candidate.id, message: e.data?.statusMessage || "知识处理失败。" });
        batchProgress.value.failed += 1;
      } finally {
        if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
          busyIds.value = busyIds.value.filter(id => id !== candidate.id);
          batchProgress.value.completed += 1;
        }
      }
    }
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const unfinishedIds = candidates.slice(batchProgress.value.completed).map(candidate => candidate.id);
    selectedProcessIds.value = [...batchFailures.value.map(item => item.id), ...unfinishedIds];
    await load(targetCharacterId);
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const message = `${batchStopRequested.value ? "已停止后续整理" : "整理完成"}：成功 ${batchProgress.value.succeeded} 条，失败 ${batchProgress.value.failed} 条。请在待确认中检查建议。`;
    if (batchProgress.value.failed) ElMessage.warning(message);
    else ElMessage.success(message);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) batchRunning.value = false;
  }
}

async function runCandidate(candidate: Candidate) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || busyIds.value.includes(candidate.id) || batchRunning.value) return;
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/process`,
      { method: "POST" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("知识处理完成，请检查结果后决定是否入库。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "知识处理失败。");
    await load(targetCharacterId);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      busyIds.value = busyIds.value.filter(id => id !== candidate.id);
    }
  }
}

async function acceptCandidate(candidate: Candidate) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || busyIds.value.includes(candidate.id)) return;
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/accept`,
      { method: "POST" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("已正式加入知识库。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "入库失败。");
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      busyIds.value = busyIds.value.filter(id => id !== candidate.id);
    }
  }
}

async function toggleCandidateRelation(candidate: Candidate, target: KnowledgeRelatedItem) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || !isCurrentRole(targetCharacterId, expectedRoleVersion) || busyIds.value.includes(candidate.id)) return;
  const current = candidate.processedResult?.confirmedRelatedItemIds ?? [];
  const confirmed = !current.includes(target.id);
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/relations`,
      { method: "POST", body: { targetItemId: target.id, confirmed } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success(confirmed ? "已确认这条关联。" : "已取消这条关联。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "调整关联失败。");
    await load(targetCharacterId);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      busyIds.value = busyIds.value.filter(id => id !== candidate.id);
    }
  }
}

async function dismissCandidate(candidate: Candidate) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed) return;
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/dismiss`,
      { method: "POST" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("已忽略这条候选。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "操作失败。");
  }
}
/**
 * 所有会改数据的操作统一走这里：同一时刻只跑一个，期间按钮全部禁用，
 * 避免连点或键盘连按发出第二个请求。
 */
async function withAction(run: () => Promise<ActionOutcome>): Promise<ActionOutcome> {
  if (pageDisposed || actionBusy.value) return "failed";
  actionBusy.value = true;
  try {
    return await run();
  } finally {
    actionBusy.value = false;
  }
}

/** 统一失败反馈：服务端有话说就用服务端的话，409 交给调用方决定是否关闭弹窗。 */
function actionError(error: unknown, fallback: string): ActionOutcome {
  const e = error as { data?: { statusCode?: number; statusMessage?: string } };
  ElMessage.error(e.data?.statusMessage || fallback);
  return e.data?.statusCode === 409 ? "conflict" : "failed";
}

/** 操作后一律重新拉取；非当前分区的计数先标成「未知」，等用户真的打开那个分区再读。 */
async function refreshAfterAction(targetCharacterId: string) {
  if (!isCurrentRole(targetCharacterId, roleVersion)) return;
  if (activeTab.value !== "archive") archiveLoaded.value = false;
  if (activeTab.value !== "trash") trashLoaded.value = false;
  await load(targetCharacterId);
}

async function performLifecycle(item: LifecycleTarget, operation: LifecycleOperation): Promise<ActionOutcome> {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  try {
    const result = await $fetch<{ item: { revision: number }; message?: string }>(
      `${knowledgeBase(targetCharacterId)}/items/${encodeURIComponent(item.id)}/${LIFECYCLE_PATHS[operation]}`,
      { method: "POST", body: { expectedRevision: item.revision } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "done";
    ElMessage.success(result.message || LIFECYCLE_FALLBACK_MESSAGES[operation]);
    await refreshAfterAction(targetCharacterId);
    return "done";
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    const outcome = actionError(error, LIFECYCLE_FAILURES[operation]);
    await refreshAfterAction(targetCharacterId);
    return outcome;
  }
}

/**
 * 归档知识移入回收站。
 *
 * 生命周期规则只允许 ACTIVE → TRASHED，ARCHIVED → TRASHED 会被后端拒绝，
 * 所以这里按「先取消归档，再移入回收站」两步执行，并在确认框里明说这一点。
 * 第二步失败时知识已经回到知识库，提示必须讲清楚它现在在哪。
 */
async function performArchivedTrash(item: LifecycleTarget): Promise<ActionOutcome> {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  const base = knowledgeBase(targetCharacterId);
  let revision = item.revision;
  try {
    const unarchived = await $fetch<{ item: { revision: number } }>(
      `${base}/items/${encodeURIComponent(item.id)}/unarchive`,
      { method: "POST", body: { expectedRevision: revision } },
    );
    revision = unarchived.item.revision;
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    const outcome = actionError(error, "取消归档失败，知识仍在归档区。");
    await refreshAfterAction(targetCharacterId);
    return outcome;
  }
  // 角色已经切换：第一步已经改了 A 的状态，但不再替用户把 A 的知识继续移入回收站。
  if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  try {
    await $fetch(
      `${base}/items/${encodeURIComponent(item.id)}/trash`,
      { method: "POST", body: { expectedRevision: revision } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "done";
    ElMessage.success("已取消归档，并把知识移入回收站。");
    await refreshAfterAction(targetCharacterId);
    return "done";
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    const e = error as { data?: { statusCode?: number; statusMessage?: string } };
    ElMessage.error(`已取消归档，知识现在在知识库；移入回收站失败：${e.data?.statusMessage || "请稍后重试。"}`);
    await refreshAfterAction(targetCharacterId);
    return e.data?.statusCode === 409 ? "conflict" : "failed";
  }
}

async function performPurge(item: LifecycleTarget): Promise<ActionOutcome> {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  try {
    const result = await $fetch<{ message?: string }>(
      `${knowledgeBase(targetCharacterId)}/items/${encodeURIComponent(item.id)}`,
      { method: "DELETE", body: { expectedRevision: item.revision, confirm: PURGE_CONFIRMATION } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "done";
    ElMessage.success(result.message || "知识已永久删除。");
    await refreshAfterAction(targetCharacterId);
    return "done";
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    const outcome = actionError(error, "永久删除失败。");
    await refreshAfterAction(targetCharacterId);
    return outcome;
  }
}

async function performDeleteCandidate(candidate: { id: string }): Promise<ActionOutcome> {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  try {
    const result = await $fetch<{ knowledgeItemRetained?: boolean }>(
      `${knowledgeBase(targetCharacterId)}/candidates/${encodeURIComponent(candidate.id)}`,
      { method: "DELETE" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "done";
    ElMessage.success(result.knowledgeItemRetained ? "候选已删除，已入库的正式知识保留。" : "候选已删除。");
    await refreshAfterAction(targetCharacterId);
    return "done";
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    const outcome = actionError(error, "删除候选失败。");
    await refreshAfterAction(targetCharacterId);
    return outcome;
  }
}

/** 逐条删除选中的已忽略候选：状态校验放在这里，切换角色后立即停止后续请求。 */
async function performBatchDeleteCandidates(): Promise<ActionOutcome> {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  const selected = new Set(selectedCandidateIds.value);
  const targets = (data.value.candidates ?? []).filter(
    candidate => selected.has(candidate.id) && candidate.status === "DISMISSED",
  );
  if (!targets.length) {
    ElMessage.warning("没有可删除的已忽略候选。待处理和已入库的候选不会参与批量清理。");
    return "failed";
  }
  let deleted = 0;
  let failed = 0;
  let lastFailure = "";
  for (const candidate of targets) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    try {
      await $fetch(
        `${knowledgeBase(targetCharacterId)}/candidates/${encodeURIComponent(candidate.id)}`,
        { method: "DELETE" },
      );
      deleted += 1;
    } catch (error) {
      failed += 1;
      const e = error as { data?: { statusMessage?: string } };
      lastFailure = e.data?.statusMessage || "删除失败。";
    }
  }
  if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  selectedCandidateIds.value = [];
  if (failed) ElMessage.error(`已删除 ${deleted} 条已忽略候选，${failed} 条失败：${lastFailure}`);
  else ElMessage.success(`已删除 ${deleted} 条已忽略候选。`);
  await refreshAfterAction(targetCharacterId);
  return failed ? "failed" : "done";
}

async function performPurgeDismissedCandidates(): Promise<ActionOutcome> {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
  try {
    const result = await $fetch<{ deletedCount: number }>(
      `${knowledgeBase(targetCharacterId)}/candidates/purge-dismissed`,
      { method: "POST", body: {} },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "done";
    selectedCandidateIds.value = [];
    ElMessage.success(`已清理 ${result.deletedCount} 条已忽略候选。`);
    await refreshAfterAction(targetCharacterId);
    return "done";
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return "failed";
    const outcome = actionError(error, "清理已忽略候选失败。");
    await refreshAfterAction(targetCharacterId);
    return outcome;
  }
}

function lifecycleTarget(item: LifecycleTarget) {
  return {
    id: item.id, title: item.title, revision: item.revision, status: item.status,
    canPermanentlyDelete: item.canPermanentlyDelete,
  };
}

function requestArchive(item: LifecycleTarget) {
  if (actionBusy.value) return;
  void withAction(() => performLifecycle(item, "ARCHIVE"));
}

function requestUnarchive(item: LifecycleTarget) {
  if (actionBusy.value) return;
  void withAction(() => performLifecycle(item, "UNARCHIVE"));
}

function requestRestore(item: LifecycleTarget) {
  if (actionBusy.value) return;
  void withAction(() => performLifecycle(item, "RESTORE"));
}

function requestTrash(item: LifecycleTarget) {
  if (actionBusy.value) return;
  confirmDialog.value = {
    kind: "TRASH",
    title: "移入回收站",
    message: `「${item.title}」将移入回收站，之后不再参与检索。`,
    detail: "回收站里的知识可以恢复到知识库，也可以永久删除。",
    confirmLabel: "移入回收站",
    danger: false,
    item: lifecycleTarget(item),
  };
}

function requestArchivedTrash(item: LifecycleTarget) {
  if (actionBusy.value) return;
  confirmDialog.value = {
    kind: "ARCHIVED_TRASH",
    title: "把归档知识移入回收站",
    message: `「${item.title}」当前处于归档状态，需要先取消归档才能移入回收站。`,
    detail: "确认后会连续执行两步：取消归档（回到知识库）→ 移入回收站。版本号会增加两次，历史里也会留下两条状态快照。",
    confirmLabel: "取消归档并移入回收站",
    danger: false,
    item: lifecycleTarget(item),
  };
}

function requestPurge(item: LifecycleTarget) {
  if (actionBusy.value) return;
  if (item.canPermanentlyDelete === false) {
    ElMessage.error("这条知识参与过合并，属于合并审计链的一部分，不能永久删除。");
    return;
  }
  confirmDialog.value = {
    kind: "PURGE",
    title: "永久删除知识",
    message: `「${item.title}」将被永久删除。`,
    detail: "永久删除不可恢复：正文、标签、来源和全部版本历史都会一起消失。如果只是想暂时不用它，请改选「恢复到知识库」。",
    confirmLabel: "永久删除",
    danger: true,
    item: lifecycleTarget(item),
  };
}

function requestDeleteCandidate(candidate: Candidate) {
  if (actionBusy.value) return;
  const accepted = candidate.status === "ACCEPTED";
  confirmDialog.value = {
    kind: "CANDIDATE_DELETE",
    title: "删除知识候选",
    message: accepted
      ? "这条候选已经入库。删除候选只会移除候选记录，不会删除已入库的正式知识。"
      : "这条候选记录将被删除。",
    detail: `${accepted ? "" : "候选删除后不可恢复。"}原文预览：${candidate.rawContent.slice(0, 120)}${candidate.rawContent.length > 120 ? "…" : ""}`,
    confirmLabel: "删除候选",
    danger: true,
    candidate: { id: candidate.id, rawContent: candidate.rawContent, status: candidate.status },
  };
}

function requestBatchDeleteCandidates() {
  if (actionBusy.value) return;
  const ids = selectedDismissedCandidates.value.map(candidate => candidate.id);
  if (!ids.length) {
    ElMessage.warning("请先选择要删除的已忽略候选。");
    return;
  }
  confirmDialog.value = {
    kind: "CANDIDATE_BATCH_DELETE",
    title: "批量删除已忽略候选",
    message: `将删除 ${ids.length} 条已忽略候选。`,
    detail: "删除后不可恢复。待处理、处理中和已入库的候选不在清理范围内，已入库的正式知识也不会受影响。",
    confirmLabel: `删除 ${ids.length} 条`,
    danger: true,
    candidateIds: ids,
  };
}

function requestPurgeDismissedCandidates() {
  if (actionBusy.value) return;
  const count = dismissedCandidates.value.length;
  if (!count) {
    ElMessage.warning("当前没有已忽略候选需要清理。");
    return;
  }
  confirmDialog.value = {
    kind: "CANDIDATE_PURGE_ALL",
    title: "清理全部已忽略候选",
    message: `将清理当前角色全部 ${count} 条已忽略候选。`,
    detail: "删除后不可恢复。待处理、处理中和已入库候选不会被清理。",
    confirmLabel: `清理 ${count} 条`,
    danger: true,
  };
}

function closeConfirm() {
  if (actionBusy.value) return;
  confirmDialog.value = null;
}

function runConfirmedAction(dialog: ConfirmState): Promise<ActionOutcome> {
  switch (dialog.kind) {
    case "TRASH":
      return dialog.item ? performLifecycle(dialog.item, "TRASH") : Promise.resolve("failed");
    case "ARCHIVED_TRASH":
      return dialog.item ? performArchivedTrash(dialog.item) : Promise.resolve("failed");
    case "PURGE":
      return dialog.item ? performPurge(dialog.item) : Promise.resolve("failed");
    case "CANDIDATE_DELETE":
      return dialog.candidate ? performDeleteCandidate(dialog.candidate) : Promise.resolve("failed");
    case "CANDIDATE_BATCH_DELETE":
      return performBatchDeleteCandidates();
    case "CANDIDATE_PURGE_ALL":
      return performPurgeDismissedCandidates();
  }
}

async function confirmAction() {
  const dialog = confirmDialog.value;
  if (!dialog || pageDisposed || actionBusy.value) return;
  const outcome = await withAction(() => runConfirmedAction(dialog));
  // 失败时保留弹窗让用户重试；409 说明数据已变化，关闭并让用户看刷新后的内容。
  if (outcome !== "failed" && confirmDialog.value === dialog) confirmDialog.value = null;
}

function toggleCandidateSelection(candidate: Candidate) {
  // 只有已忽略候选能进批量清理；待处理、处理中、已入库一律不可选。
  if (candidate.status !== "DISMISSED") return;
  selectedCandidateIds.value = selectedCandidateIds.value.includes(candidate.id)
    ? selectedCandidateIds.value.filter(id => id !== candidate.id)
    : [...selectedCandidateIds.value, candidate.id];
}

function toggleSelectAllDismissed() {
  selectedCandidateIds.value = allDismissedSelected.value ? [] : dismissedCandidates.value.map(candidate => candidate.id);
}

function canDeleteCandidate(candidate: Candidate) {
  return candidate.status !== "PROCESSING" && candidate.status !== "ACCEPTING";
}

function startEdit(item: KnowledgeItem) {
  editingItemId.value = item.id;
  editDraft.value = {
    title: item.title,
    content: item.content,
    category: item.category,
    tagsText: item.tags.join(", "),
    confidence: item.confidence === null ? "" : String(item.confidence),
  };
}

function cancelEdit() {
  editingItemId.value = "";
  editDraft.value = { title: "", content: "", category: "", tagsText: "", confidence: "" };
}

async function saveEdit(item: KnowledgeItem) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || savingItem.value || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const draft = { ...editDraft.value };
  const rawConfidence = draft.confidence.trim();
  const confidence = rawConfidence ? Number(rawConfidence) : null;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    ElMessage.error("可信度必须是 0 到 1 之间的数字，留空表示未标注。");
    return;
  }
  const tags = draft.tagsText.split(/[，,]/).map(tag => tag.trim()).filter(Boolean);
  savingItem.value = true;
  try {
    const result = await $fetch<{ item: KnowledgeItem; unchanged: boolean }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/items/${encodeURIComponent(item.id)}`,
      {
        method: "PATCH",
        body: {
          revision: item.revision,
          title: draft.title,
          content: draft.content,
          category: draft.category,
          tags,
          confidence,
        },
      },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success(result.unchanged ? "内容没有变化。" : `已保存为第 ${result.item.revision} 版。`);
    cancelEdit();
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string; statusCode?: number } };
    ElMessage.error(e.data?.statusMessage || (e.data?.statusCode === 409 ? "知识已更新，请检查最新版本后重新编辑。" : "保存知识失败。"));
    if (e.data?.statusCode === 409) {
      cancelEdit();
      await load(targetCharacterId);
    }
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) savingItem.value = false;
  }
}

async function toggleHistory(item: KnowledgeItem) {
  if (historyItemId.value === item.id) {
    historyRequestVersion += 1;
    historyItemId.value = "";
    historyItems.value = [];
    historyLoading.value = false;
    return;
  }
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const requestVersion = ++historyRequestVersion;
  historyItemId.value = item.id;
  historyItems.value = [];
  historyLoading.value = true;
  try {
    const result = await $fetch<{ revisions: KnowledgeItemRevision[] }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/items/${encodeURIComponent(item.id)}/history`,
    );
    if (requestVersion !== historyRequestVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    historyItems.value = result.revisions;
  } catch (error) {
    if (requestVersion !== historyRequestVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "读取知识版本历史失败。");
  } finally {
    if (requestVersion === historyRequestVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      historyLoading.value = false;
    }
  }
}

function startMerge(
  source: { id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null; revision: number; status?: string; sourceType: string; sourceRef: unknown },
  target: { id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null; revision: number; status?: string; sourceType: string; sourceRef: unknown },
) {
  if (source.id === target.id || source.status === "MERGED" || target.status === "MERGED") return;
  mergeDraft.value = {
    sourceItemId: source.id,
    targetItemId: target.id,
    expectedSourceRevision: source.revision,
    expectedTargetRevision: target.revision,
    sourceTitle: source.title,
    sourceContent: source.content,
    sourceCategory: source.category,
    sourceConfidence: source.confidence,
    sourceTags: source.tags,
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    targetTitle: target.title,
    targetContent: target.content,
    targetCategory: target.category,
    targetConfidence: target.confidence,
    targetTags: target.tags,
    targetSourceType: target.sourceType,
    targetSourceRef: target.sourceRef,
    title: target.title,
    content: target.content,
    category: target.category,
    tagsText: target.tags.join(", "),
    confidence: target.confidence === null ? "" : String(target.confidence),
  };
}

function cancelMerge() {
  if (mergingKnowledge.value) return;
  mergeDraft.value = null;
}

async function submitMerge() {
  const draft = mergeDraft.value;
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!draft || !targetCharacterId || mergingKnowledge.value || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const rawConfidence = draft.confidence.trim();
  const confidence = rawConfidence ? Number(rawConfidence) : null;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    ElMessage.error("可信度必须是 0 到 1 之间的数字，留空表示未标注。");
    return;
  }
  const tags = draft.tagsText.split(/[，,]/).map(tag => tag.trim()).filter(Boolean);
  mergingKnowledge.value = true;
  busyIds.value = [...new Set([...busyIds.value, draft.sourceItemId, draft.targetItemId])];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/items/${encodeURIComponent(draft.sourceItemId)}/merge`,
      {
        method: "POST",
        body: {
          targetItemId: draft.targetItemId,
          expectedSourceRevision: draft.expectedSourceRevision,
          expectedTargetRevision: draft.expectedTargetRevision,
          title: draft.title,
          content: draft.content,
          category: draft.category,
          tags,
          confidence,
        },
      },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("重复知识已合并，源条目和双方历史均已保留。");
    mergeDraft.value = null;
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string; statusCode?: number } };
    ElMessage.error(e.data?.statusMessage || "合并知识失败。");
    if (e.data?.statusCode === 409) {
      mergeDraft.value = null;
      await load(targetCharacterId);
    }
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      mergingKnowledge.value = false;
      busyIds.value = busyIds.value.filter(id => id !== draft.sourceItemId && id !== draft.targetItemId);
    }
  }
}

async function resolveRelation(item: KnowledgeItem, relation: KnowledgeRelationView, action: "CONFIRM_CONFLICT" | "NEEDS_VERIFICATION" | "KEEP_SEPARATE" | "DISMISS") {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || relation.status !== "OPEN" || resolvingRelationIds.value.includes(relation.id)
    || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const sourceRevision = relation.sourceItemId === item.id ? item.revision : relation.relatedItem.revision;
  const targetRevision = relation.targetItemId === item.id ? item.revision : relation.relatedItem.revision;
  resolvingRelationIds.value = [...resolvingRelationIds.value, relation.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/relations/${encodeURIComponent(relation.id)}/resolve`,
      { method: "POST", body: { action, expectedSourceRevision: sourceRevision, expectedTargetRevision: targetRevision } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const messages: Record<typeof action, string> = {
      CONFIRM_CONFLICT: "已确认冲突，双方知识均予以保留。",
      NEEDS_VERIFICATION: "已标记待核实。",
      KEEP_SEPARATE: "已保留为两条独立知识。",
      DISMISS: "已忽略这条关联建议。",
    };
    ElMessage.success(messages[action]);
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "处置知识关联失败。");
    await load(targetCharacterId);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      resolvingRelationIds.value = resolvingRelationIds.value.filter(id => id !== relation.id);
    }
  }
}

function relationStatusLabel(relation: KnowledgeRelationView) {
  if (relation.resolution === "NEEDS_VERIFICATION") return "待核实";
  if (relation.resolution === "MERGED") return "已合并";
  if (relation.resolution === "SOURCE_MERGED") return "源知识已合并";
  return relation.status === "OPEN" ? "待处理" : relation.status === "RESOLVED" ? "已处理" : "已忽略";
}

function sourceLabel(sourceType: string) { return ({ MANUAL: "手动录入", CHAT: "聊天来源", IMPORT: "资料导入", MEMORY_EVENT: "忆泡摘录（人工提出）" } as Record<string,string>)[sourceType] ?? sourceType; }
function sourceDetails(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as Record<string, unknown>;
    if (ref.kind === "MEMORY_EVENT") return `公开忆泡 ${String(ref.memoryEventId ?? "")}；整理与采纳前会重新校验来源，正式入库后独立保留。`;
  }
  return value ? JSON.stringify(value) : "";
}
function statusLabel(status: string) {
  return ({ PENDING: "待处理", PROCESSING: "处理中", REVIEW: "待确认", FAILED: "处理失败", ACCEPTED: "已入库", DISMISSED: "已忽略" } as Record<string,string>)[status] ?? status;
}
function recommendationLabel(value?: string) {
  return ({ CREATE: "建议新建", DUPLICATE: "疑似重复", CONFLICT: "发现冲突", DISCARD: "不建议保存" } as Record<string,string>)[value ?? ""] ?? "待判断";
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <div class="page-wrap knowledge-page">
    <PageHeader eyebrow="成长系统 / 知识系统" description="收集值得学习的内容，经过整理和判断后再入库。正式知识与原始候选分开保存。">
      <template #actions>
        <NuxtLink class="settings-link" :to="`/growth/knowledge/settings?c=${characterId}`">知识助手设置 ↗</NuxtLink>
      </template>
    </PageHeader>

    <section v-if="activeCharacter" class="knowledge-context">
      <div class="knowledge-context-copy"><span>当前角色</span><strong>{{ activeCharacter.name }}</strong></div>
      <span class="knowledge-context-note">知识按角色独立积累</span>
      <span class="knowledge-count">待整理 {{ data.candidateCount }} 条</span>
      <span class="knowledge-count">正式知识 {{ data.itemCount }} 条</span>
    </section>
    <p v-else class="knowledge-empty">当前没有可用角色，请先创建角色或从左下角选择角色。</p>

    <div v-if="characterId" class="workspace-toolbar">
      <el-radio-group v-model="workspaceView" aria-label="知识工作区">
        <el-radio-button value="candidates">候选整理</el-radio-button>
        <el-radio-button value="library">正式知识库</el-radio-button>
      </el-radio-group>
      <div class="workspace-toolbar-actions">
        <el-button :disabled="loading" @click="load()">刷新</el-button>
        <el-button type="primary" @click="workspaceView = 'candidates'; activeTab = 'library'; collectorOpen = !collectorOpen">{{ collectorOpen ? "收起添加" : "添加知识" }}</el-button>
      </div>
    </div>

    <nav v-if="characterId && workspaceView === 'library'" class="knowledge-tabs" aria-label="知识分区">
      <button
        v-for="tab in knowledgeTabs"
        :key="tab.key"
        type="button"
        class="knowledge-tab"
        :class="{ 'is-on': activeTab === tab.key }"
        :aria-pressed="activeTab === tab.key"
        @click="selectTab(tab.key)"
      >
        <span class="tab-label">{{ tab.label }}</span>
        <span class="tab-count">{{ tab.known ? tab.count : "—" }}</span>
      </button>
    </nav>

    <section v-if="characterId && workspaceView === 'candidates' && collectorOpen" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">COLLECT</span><h2>添加知识候选</h2></div></div>
      <textarea v-model="rawContent" rows="4" maxlength="20000" placeholder="把她接触到、值得整理的知识放在这里。可以是一段解释、资料摘录或一个概念……" />
      <div class="section-actions"><span class="muted">{{ rawContent.length }} / 20000</span><button class="primary" :disabled="savingCandidate || !rawContent.trim()" @click="addCandidate">{{ savingCandidate ? "添加中…" : "加入候选" }}</button></div>
      <div class="import-panel">
        <div><strong>从文件导入</strong><p class="muted">首批支持 UTF-8 的 TXT、Markdown 文件，单个文件不超过 2 MB、正文不超过 20000 字。</p></div>
        <input ref="importFileInput" type="file" accept=".txt,.md,text/plain,text/markdown" :disabled="importingFile" @change="importDocument">
        <span v-if="importingFile" class="muted">正在导入…</span>
      </div>
      <div class="import-panel">
        <div><strong>从网页导入</strong><p class="muted">输入公开网页地址，系统会提取正文并保存来源信息。仅创建候选，不会直接入库。</p></div>
        <div class="web-import-controls">
          <input v-model="webImportUrl" type="url" inputmode="url" maxlength="2048" placeholder="https://example.com/article" :disabled="importingWeb">
          <button type="button" class="primary" :disabled="importingWeb || !webImportUrl.trim()" @click="importWebPage">{{ importingWeb ? "采集中…" : "导入网页" }}</button>
        </div>
        <span v-if="importingWeb" class="muted">正在安全抓取网页（最多 15 秒）…</span>
      </div>
    </section>

    <section v-if="characterId && workspaceView === 'candidates'" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">INBOX</span><h2>知识候选</h2></div><span class="muted">{{ data.candidates.length }} 条</span></div>
      <p class="muted">收集 → 助手整理 → 确认入库。批量整理会逐条调用知识助手，请保持页面打开；切换角色后不再开始后续条目。</p>
      <div class="candidate-filters">
        <el-radio-group v-model="candidateFilter" aria-label="候选状态" :disabled="batchRunning">
          <el-radio-button v-for="filter in candidateFilters" :key="filter.value" :value="filter.value">{{ filter.label }} · {{ data.candidates.filter(candidate => !filter.statuses.length || filter.statuses.includes(candidate.status)).length }}</el-radio-button>
        </el-radio-group>
        <el-input v-model="candidateKeyword" clearable placeholder="搜索当前候选原文或整理标题" aria-label="搜索候选" />
      </div>
      <div class="candidate-batch">
        <el-checkbox :model-value="allProcessSelected" :indeterminate="selectedProcessCandidates.length > 0 && !allProcessSelected" :disabled="batchRunning || !processableCandidates.length" @change="toggleAllProcess">全选可整理项</el-checkbox>
        <span class="muted">已选 {{ selectedProcessCandidates.length }} / 可整理 {{ processableCandidates.length }} 条</span>
        <el-button type="primary" :loading="batchRunning" :disabled="loading || actionBusy || busyIds.length > 0 || !processableCandidates.length" @click="runBatchCandidates">{{ selectedProcessCandidates.length ? '批量整理所选（' + selectedProcessCandidates.length + '）' : '批量整理当前列表' }}</el-button>
        <el-button v-if="batchRunning" :disabled="batchStopRequested" @click="batchStopRequested = true">{{ batchStopRequested ? '本条完成后停止' : '停止后续整理' }}</el-button>
      </div>
      <div v-if="batchProgress.total" class="batch-progress" role="status" aria-live="polite">
        <div class="section-heading"><strong>{{ batchRunning ? '正在逐条整理' : '本次整理结果' }}</strong><span>{{ batchProgress.completed }} / {{ batchProgress.total }} · 成功 {{ batchProgress.succeeded }} · 失败 {{ batchProgress.failed }}</span></div>
        <el-progress :percentage="Math.round(batchProgress.completed / batchProgress.total * 100)" :status="batchRunning ? undefined : batchProgress.failed ? 'warning' : batchProgress.completed === batchProgress.total ? 'success' : undefined" />
        <el-button v-if="!batchRunning && batchProgress.succeeded" text type="primary" @click="candidateFilter = 'REVIEW'">查看待确认建议</el-button>
        <details v-if="batchFailures.length"><summary>查看失败原因（{{ batchFailures.length }}）</summary><p v-for="failure in batchFailures" :key="failure.id">{{ data.candidates.find(candidate => candidate.id === failure.id)?.rawContent.slice(0, 60) || '候选' }}：{{ failure.message }}</p></details>
      </div>
      <p class="muted">显示最近 {{ data.candidates.length }} 条候选；批量操作仅作用于当前筛选列表，待确认项可重新整理。</p>
      <div v-if="candidateFilter === 'DISMISSED' && dismissedCandidates.length" class="candidate-batch">
        <button type="button" class="quiet" :disabled="actionBusy" @click="toggleSelectAllDismissed">{{ allDismissedSelected ? "取消全选" : "全选已忽略" }}</button>
        <span class="muted">已忽略 {{ dismissedCandidates.length }} 条 · 已选 {{ selectedDismissedCandidates.length }} 条</span>
        <button type="button" class="primary" :disabled="actionBusy || !selectedDismissedCandidates.length" @click="requestBatchDeleteCandidates">删除所选（{{ selectedDismissedCandidates.length }} 条）</button>
        <button type="button" :disabled="actionBusy" @click="requestPurgeDismissedCandidates">清理全部已忽略（{{ dismissedCandidates.length }} 条）</button>
      </div>
      <div v-if="!visibleCandidates.length" class="empty-state">{{ loading ? "正在读取候选…" : data.candidates.length ? "当前筛选下没有候选，试试其他状态或关键词。" : "暂时没有知识候选，点击上方「添加知识」录入文字、文件或网页。" }}</div>
      <article v-for="candidate in visibleCandidates" :key="candidate.id" class="candidate-card">
        <div class="candidate-top">
          <el-checkbox v-if="['PENDING', 'FAILED', 'REVIEW'].includes(candidate.status)" :model-value="selectedProcessIds.includes(candidate.id)" :disabled="batchRunning || busyIds.includes(candidate.id)" :aria-label="'选择候选：' + candidate.rawContent.slice(0, 40)" @change="toggleProcessSelection(candidate.id)" />
          <label v-if="candidate.status === 'DISMISSED'" class="candidate-select">
            <input
              type="checkbox"
              :checked="selectedCandidateIds.includes(candidate.id)"
              @change="toggleCandidateSelection(candidate)"
            >
            <span>选择</span>
          </label>
          <span class="status">{{ statusLabel(candidate.status) }} · {{ sourceLabel(candidate.sourceType) }}</span><span class="muted">{{ formatDate(candidate.createdAt) }}</span>
        </div>
        <p class="candidate-raw" :class="{ 'is-collapsed': candidate.rawContent.length > 280 && !expandedCandidateIds.includes(candidate.id) }">{{ candidate.rawContent }}</p>
        <el-button v-if="candidate.rawContent.length > 280" text type="primary" class="expand-raw" :aria-expanded="expandedCandidateIds.includes(candidate.id)" @click="toggleCandidateExpanded(candidate.id)">{{ expandedCandidateIds.includes(candidate.id) ? '收起原文' : '展开完整原文' }}</el-button>
        <p v-if="candidate.processingError" class="error-text">{{ candidate.processingError }}</p>
        <template v-if="candidate.processedResult">
          <div class="processing-result">
            <div class="result-top"><strong>{{ candidate.processedResult.title || "未形成标题" }}</strong><span class="recommendation">{{ recommendationLabel(candidate.processedResult.recommendation) }}</span></div>
            <p>{{ candidate.processedResult.content }}</p>
            <div class="tag-row"><span v-for="tag in candidate.processedResult.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ Math.round(candidate.processedResult.confidence * 100) }}%</span></div>
            <p class="reason">{{ candidate.processedResult.reason }}</p>
            <div v-if="candidate.processedResult.recommendation === 'DUPLICATE' || candidate.processedResult.recommendation === 'CONFLICT'" class="suggested-relations">
              <div class="relation-heading">
                <strong>{{ candidate.processedResult.recommendation === 'DUPLICATE' ? '疑似重复知识' : '可能存在冲突的知识' }}</strong>
                <span class="muted">由助手提出，需你逐条确认</span>
              </div>
              <div v-if="!candidate.processedResult.relatedItemIds.length" class="muted">助手没有找到可核验的关联知识条目。</div>
              <div v-for="target in candidate.relatedItems" :key="target.id" class="suggested-relation">
                <div class="relation-copy">
                  <strong>{{ target.title }}</strong>
                  <p>{{ target.content }}</p>
                  <span class="muted">{{ target.category }} · 修订 {{ target.revision }}</span>
                </div>
                <button
                  :class="candidate.processedResult.confirmedRelatedItemIds?.includes(target.id) ? 'primary' : ''"
                  :disabled="busyIds.includes(candidate.id)"
                  @click="toggleCandidateRelation(candidate, target)"
                >{{ candidate.processedResult.confirmedRelatedItemIds?.includes(target.id) ? '已确认 · 取消' : '确认关联' }}</button>
              </div>
              <div v-if="candidate.processedResult.relatedItemIds.length && !candidate.relatedItems.length" class="muted">建议的知识条目已不存在或不再处于正式状态，请重新处理候选。</div>
            </div>
          </div>
        </template>
        <div class="candidate-actions">
          <button v-if="candidate.status === 'PENDING' || candidate.status === 'FAILED' || candidate.status === 'REVIEW'" :disabled="batchRunning || busyIds.includes(candidate.id)" @click="runCandidate(candidate)">{{ busyIds.includes(candidate.id) ? "处理中…" : candidate.status === "REVIEW" ? "重新处理" : "交给助手整理" }}</button>
          <button v-if="candidate.status === 'REVIEW' && candidate.processedResult?.isKnowledge" class="primary" :disabled="batchRunning || busyIds.includes(candidate.id)" @click="acceptCandidate(candidate)">确认入库</button>
          <button v-if="candidate.status !== 'ACCEPTED' && candidate.status !== 'DISMISSED' && candidate.status !== 'PROCESSING'" class="quiet" :disabled="batchRunning || busyIds.includes(candidate.id)" @click="dismissCandidate(candidate)">忽略</button>
          <button class="quiet" :disabled="batchRunning || busyIds.includes(candidate.id) || !canDeleteCandidate(candidate) || actionBusy" @click="requestDeleteCandidate(candidate)">删除候选</button>
        </div>
      </article>
    </section>

    <section v-if="characterId && workspaceView === 'library' && activeTab === 'library'" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">LIBRARY</span><h2>正式知识库</h2></div><span class="muted">{{ data.itemCount }} 条</span></div>
      <input v-model="keyword" class="search-input" placeholder="搜索标题、内容或标签">
      <div v-if="!libraryItems.length" class="empty-state">还没有正式知识。候选经过处理并由你确认后，才会出现在这里。</div>
      <article v-for="item in libraryItems" :key="item.id" class="item-card">
        <div class="item-heading"><h3>{{ item.title }}</h3><span class="category">{{ item.category }}</span></div>
        <p>{{ item.content }}</p>
        <div class="tag-row"><span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ item.confidence === null ? "未标注" : Math.round(item.confidence * 100) + "%" }}</span><span class="muted">修订 {{ item.revision }}</span></div>
        <div class="item-date">来源：{{ sourceLabel(item.sourceType) }}<span v-if="sourceDetails(item.sourceRef)"> · {{ sourceDetails(item.sourceRef) }}</span><br>更新于 {{ formatDate(item.updatedAt) }}</div>
        <div v-if="item.relations.length" class="saved-relations">
          <strong>关联知识</strong>
          <div v-for="relation in item.relations" :key="relation.id" class="saved-relation">
            <div class="relation-copy">
              <span class="relation-kind">{{ relation.relationType === 'DUPLICATE' ? '重复' : relation.relationType === 'CONFLICT' ? '冲突' : '合并关系' }} · {{ relationStatusLabel(relation) }}</span>
              <strong>{{ relation.relatedItem.title }}</strong>
              <p>{{ relation.relatedItem.content }}</p>
              <span class="muted">{{ relation.relatedItem.category }} · 可信度 {{ relation.relatedItem.confidence === null ? "未标注" : Math.round(relation.relatedItem.confidence * 100) + "%" }} · {{ sourceLabel(relation.relatedItem.sourceType) }} · 修订 {{ relation.relatedItem.revision }}</span>
              <span v-if="sourceDetails(relation.relatedItem.sourceRef)" class="muted">来源：{{ sourceDetails(relation.relatedItem.sourceRef) }}</span>
              <div v-if="relation.status === 'OPEN' && relation.relationType === 'DUPLICATE'" class="relation-actions">
                <button :disabled="resolvingRelationIds.includes(relation.id) || mergingKnowledge" @click="startMerge(item, relation.relatedItem)">将当前条目合并到关联知识</button>
                <button :disabled="resolvingRelationIds.includes(relation.id) || mergingKnowledge" @click="startMerge(relation.relatedItem, item)">将关联条目合并到当前知识</button>
                <button :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'KEEP_SEPARATE')">保留为独立知识</button>
                <button class="quiet" :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'DISMISS')">忽略</button>
              </div>
              <div v-if="relation.status === 'OPEN' && relation.relationType === 'CONFLICT'" class="relation-actions">
                <button :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'CONFIRM_CONFLICT')">确认冲突并保留双方</button>
                <button :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'NEEDS_VERIFICATION')">标记待核实</button>
                <button class="quiet" :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'DISMISS')">忽略</button>
              </div>
            </div>
          </div>
        </div>
        <div class="item-actions">
          <button :disabled="savingItem" @click="editingItemId === item.id ? cancelEdit() : startEdit(item)">{{ editingItemId === item.id ? "取消编辑" : "编辑知识" }}</button>
          <button @click="toggleHistory(item)">{{ historyItemId === item.id ? "收起历史" : "版本历史" }}</button>
          <button type="button" :disabled="actionBusy" @click="requestArchive(item)">归档</button>
          <button type="button" class="danger-quiet" :disabled="actionBusy" @click="requestTrash(item)">移入回收站</button>
        </div>
        <div v-if="editingItemId === item.id" class="item-editor">
          <label>标题<input v-model="editDraft.title" maxlength="240"></label>
          <label>正文<textarea v-model="editDraft.content" rows="5" maxlength="12000"></textarea></label>
          <div class="editor-grid">
            <label>分类<input v-model="editDraft.category" maxlength="40"></label>
            <label>可信度（0–1，留空表示未标注）<input v-model="editDraft.confidence" type="number" min="0" max="1" step="0.01"></label>
          </div>
          <label>标签（用逗号分隔）<input v-model="editDraft.tagsText" maxlength="1000"></label>
          <p class="muted">来源类型和来源引用保持不变，确保知识仍可追溯。</p>
          <div class="item-actions"><button @click="cancelEdit()">取消</button><button class="primary" :disabled="savingItem" @click="saveEdit(item)">{{ savingItem ? "保存中…" : "保存为新版本" }}</button></div>
        </div>
        <div v-if="historyItemId === item.id" class="history-panel">
          <div class="history-heading"><strong>历史版本</strong><span class="muted">当前版本 V{{ item.revision }}</span></div>
          <p v-if="historyLoading" class="muted">正在读取历史…</p>
          <p v-else-if="!historyItems.length" class="muted">暂无旧版本；每次成功修改后都会在这里保留被替换的版本。</p>
          <article v-for="revision in historyItems" :key="revision.id" class="revision-card">
            <div class="history-heading"><strong>版本 V{{ revision.revision }}</strong><span class="muted">{{ formatDate(revision.createdAt) }}</span></div>
            <h4>{{ revision.title }}</h4>
            <p>{{ revision.content }}</p>
            <div class="tag-row"><span class="category">{{ revision.category }}</span><span v-for="tag in revision.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ revision.confidence === null ? "未标注" : Math.round(revision.confidence * 100) + "%" }}</span></div>
          </article>
        </div>
      </article>
    </section>
    <section v-if="characterId && workspaceView === 'library' && activeTab === 'archive'" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">ARCHIVE</span><h2>归档知识</h2></div><span class="muted">{{ archiveTotalCount }} 条</span></div>
      <p class="muted">归档会保留正文、来源和版本历史，但不再参与正常检索。需要时可以随时恢复到知识库。</p>
      <input v-model="keyword" class="search-input" placeholder="搜索归档知识标题、内容或标签">
      <div v-if="!archivedItems.length" class="empty-state">{{ keyword.trim() ? "没有找到匹配的归档知识。" : "还没有归档知识。知识库里的条目归档后会出现在这里。" }}</div>
      <article v-for="item in archivedItems" :key="item.id" class="item-card">
        <div class="item-heading"><h3>{{ item.title }}</h3><div class="entry-badges"><span class="state-badge">已归档</span><span class="category">{{ item.category }}</span></div></div>
        <p>{{ item.content }}</p>
        <div class="tag-row"><span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ item.confidence === null ? "未标注" : Math.round(item.confidence * 100) + "%" }}</span><span class="muted">修订 {{ item.revision }}</span></div>
        <div class="item-date">来源：{{ sourceLabel(item.sourceType) }}<span v-if="sourceDetails(item.sourceRef)"> · {{ sourceDetails(item.sourceRef) }}</span><br>更新于 {{ formatDate(item.updatedAt) }}</div>
        <div class="item-actions">
          <button type="button" :disabled="actionBusy" @click="requestUnarchive(item)">恢复到知识库</button>
          <button type="button" class="danger-quiet" :disabled="actionBusy" @click="requestArchivedTrash(item)">移入回收站</button>
        </div>
      </article>
      <div v-if="archivePageCount > 1" class="pagination">
        <button type="button" :disabled="loading || archivePage <= 1" @click="changeArchivePage(archivePage - 1)">上一页</button>
        <span class="muted">第 {{ archivePage }} / {{ archivePageCount }} 页 · 共 {{ archiveTotalCount }} 条</span>
        <button type="button" :disabled="loading || archivePage >= archivePageCount" @click="changeArchivePage(archivePage + 1)">下一页</button>
      </div>
    </section>

    <section v-if="characterId && workspaceView === 'library' && activeTab === 'trash'" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">RECYCLE</span><h2>回收站</h2></div><span class="muted">{{ trashTotalCount }} 条</span></div>
      <p class="muted">回收站里的知识不参与检索。可以恢复到知识库，也可以永久删除；永久删除后无法恢复。</p>
      <input v-model="keyword" class="search-input" placeholder="搜索回收站标题、内容或标签">
      <div v-if="!trashItems.length" class="empty-state">{{ keyword.trim() ? "没有找到匹配的回收站知识。" : "回收站是空的。移入回收站的知识会保留在这里，直到你恢复或永久删除。" }}</div>
      <article v-for="item in trashItems" :key="item.id" class="item-card">
        <div class="item-heading"><h3>{{ item.title }}</h3><div class="entry-badges"><span class="state-badge">回收站</span><span class="category">{{ item.category }}</span></div></div>
        <p>{{ item.content }}</p>
        <div class="tag-row"><span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ item.confidence === null ? "未标注" : Math.round(item.confidence * 100) + "%" }}</span><span class="muted">修订 {{ item.revision }}</span></div>
        <div class="item-date">来源：{{ sourceLabel(item.sourceType) }}<span v-if="sourceDetails(item.sourceRef)"> · {{ sourceDetails(item.sourceRef) }}</span><br>更新于 {{ formatDate(item.updatedAt) }}</div>
        <p v-if="item.canPermanentlyDelete === false" :id="`purge-blocked-${item.id}`" class="audit-note">
          <span class="audit-mark" aria-hidden="true">!</span>
          这条知识参与过合并，属于合并审计链的一部分，不能永久删除。仍可以恢复到知识库。
        </p>
        <div class="item-actions">
          <button type="button" :disabled="actionBusy" @click="requestRestore(item)">恢复到知识库</button>
          <button
            type="button"
            class="danger"
            :disabled="actionBusy || item.canPermanentlyDelete === false"
            :aria-describedby="item.canPermanentlyDelete === false ? `purge-blocked-${item.id}` : undefined"
            :title="item.canPermanentlyDelete === false ? '参与合并审计链，不能永久删除' : '永久删除后无法恢复'"
            @click="requestPurge(item)"
          >永久删除</button>
        </div>
      </article>
      <div v-if="trashPageCount > 1" class="pagination">
        <button type="button" :disabled="loading || trashPage <= 1" @click="changeTrashPage(trashPage - 1)">上一页</button>
        <span class="muted">第 {{ trashPage }} / {{ trashPageCount }} 页 · 共 {{ trashTotalCount }} 条</span>
        <button type="button" :disabled="loading || trashPage >= trashPageCount" @click="changeTrashPage(trashPage + 1)">下一页</button>
      </div>
    </section>

    <AccessibleDialog
      :open="Boolean(mergeDraft)"
      title="确认合并重复知识"
      size="wide"
      :close-disabled="mergingKnowledge"
      @close="cancelMerge"
    >
      <div v-if="mergeDraft" class="merge-body">
        <p class="muted">源条目将标记为已合并并保留历史；目标条目会保存为新版本。请检查双方内容、来源、可信度和版本，再确认最终内容。</p>
        <div class="merge-comparison">
          <article>
            <strong>源知识 · 将标记为 MERGED · V{{ mergeDraft.expectedSourceRevision }}</strong>
            <h4>{{ mergeDraft.sourceTitle }}</h4>
            <p>{{ mergeDraft.sourceContent }}</p>
            <span>{{ mergeDraft.sourceCategory }} · 可信度 {{ mergeDraft.sourceConfidence === null ? "未标注" : Math.round(mergeDraft.sourceConfidence * 100) + "%" }} · {{ sourceLabel(mergeDraft.sourceType) }}</span>
            <span v-if="sourceDetails(mergeDraft.sourceRef)">来源：{{ sourceDetails(mergeDraft.sourceRef) }}</span>
          </article>
          <article>
            <strong>目标知识 · 将保留为 ACTIVE · V{{ mergeDraft.expectedTargetRevision }}</strong>
            <h4>{{ mergeDraft.targetTitle }}</h4>
            <p>{{ mergeDraft.targetContent }}</p>
            <span>{{ mergeDraft.targetCategory }} · 可信度 {{ mergeDraft.targetConfidence === null ? "未标注" : Math.round(mergeDraft.targetConfidence * 100) + "%" }} · {{ sourceLabel(mergeDraft.targetSourceType) }}</span>
            <span v-if="sourceDetails(mergeDraft.targetSourceRef)">来源：{{ sourceDetails(mergeDraft.targetSourceRef) }}</span>
          </article>
        </div>
        <label>合并后的标题<input v-model="mergeDraft.title" maxlength="240"></label>
        <label>合并后的正文<textarea v-model="mergeDraft.content" rows="7" maxlength="12000"></textarea></label>
        <div class="editor-grid">
          <label>分类<input v-model="mergeDraft.category" maxlength="40"></label>
          <label>可信度（0–1，留空表示未标注）<input v-model="mergeDraft.confidence" type="number" min="0" max="1" step="0.01"></label>
        </div>
        <label>标签（用逗号分隔）<input v-model="mergeDraft.tagsText" maxlength="1000"></label>
        <div class="item-actions">
          <button :disabled="mergingKnowledge" @click="cancelMerge">取消</button>
          <button class="primary" :disabled="mergingKnowledge || !mergeDraft.title.trim() || !mergeDraft.content.trim() || !mergeDraft.category.trim()" @click="submitMerge">{{ mergingKnowledge ? "合并中…" : "确认合并并保存新版本" }}</button>
        </div>
      </div>
    </AccessibleDialog>

    <AccessibleDialog
      :open="Boolean(confirmDialog)"
      :title="confirmDialog ? confirmDialog.title : ''"
      @close="closeConfirm"
    >
      <template v-if="confirmDialog">
        <p class="confirm-message">{{ confirmDialog.message }}</p>
        <p class="muted">{{ confirmDialog.detail }}</p>
        <p v-if="confirmDialog.danger" class="confirm-warning">此操作不可恢复，请确认后再继续。</p>
      </template>
      <template #actions>
        <button type="button" data-autofocus :disabled="actionBusy" @click="closeConfirm">取消</button>
        <button
          type="button"
          :class="confirmDialog?.danger ? 'danger' : 'primary'"
          :disabled="actionBusy"
          @click="confirmAction"
        >{{ actionBusy ? "处理中…" : (confirmDialog ? confirmDialog.confirmLabel : "确认") }}</button>
      </template>
    </AccessibleDialog>
    <div v-if="loading" class="loading-note">正在同步知识数据…</div>
  </div>
</template>

<style scoped>
.workspace-toolbar,.workspace-toolbar-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.candidate-filters{display:flex;flex-direction:column;gap:12px}.candidate-filters :deep(.el-radio-group){gap:6px;flex-wrap:wrap}.candidate-filters :deep(.el-radio-button__inner){border:1px solid var(--line);border-radius:7px;font-size:12px;box-shadow:none}
.batch-progress{padding:14px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;gap:10px;font-size:13px}.batch-progress p{overflow-wrap:anywhere}.batch-progress summary{cursor:pointer}
.candidate-raw.is-collapsed{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}.expand-raw{align-self:flex-start;margin:0;padding:0;height:auto}
.knowledge-page :deep(.el-checkbox__label){font-size:12px}.candidate-top{flex-wrap:wrap}.candidate-actions{flex-wrap:wrap}
@media(max-width:600px){.workspace-toolbar{align-items:stretch;flex-direction:column}.batch-progress .section-heading{align-items:flex-start;flex-direction:column}.candidate-filters :deep(.el-radio-button__inner){padding:8px}}

.knowledge-page{display:flex;flex-direction:column;gap:16px}
.settings-link{color:var(--accent);font-size:13px;text-decoration:none}
.knowledge-context{display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:12px 16px}
.knowledge-context-copy{display:flex;flex-direction:column;gap:3px}.knowledge-context-copy span,.eyebrow,.stage-number{color:var(--dim);font-size:12px}.knowledge-context-copy strong{color:var(--ink);font-size:14px}
.knowledge-context-note{margin-left:auto;color:var(--dim);font-size:12px}.knowledge-count{font-size:12px;color:var(--dim);background:var(--surface-2);padding:5px 9px;border-radius:20px}
.knowledge-flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.knowledge-stage{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:15px;min-width:0}.knowledge-stage h2{font-size:15px;margin:7px 0;color:var(--ink)}.knowledge-stage p{font-size:12px;line-height:1.7;color:var(--dim);margin:0}
.knowledge-section{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:18px;display:flex;flex-direction:column;gap:12px}
.section-heading,.candidate-top,.result-top,.item-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.section-heading h2{font-size:17px;margin:3px 0 0;color:var(--ink)}.muted{font-size:12px;color:var(--dim)}
textarea,.search-input{width:100%;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);color:var(--ink);padding:11px 12px;font:inherit;resize:vertical}
.section-actions{display:flex;align-items:center;justify-content:space-between}
.pagination{display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding-top:4px}
.import-panel{display:grid;gap:10px;padding:14px;border:1px dashed var(--line);border-radius:12px;background:var(--surface-muted)}
.import-panel p{margin:5px 0 0}
.import-panel input{max-width:100%;font:inherit}
.web-import-controls{display:flex;gap:8px;align-items:center;min-width:0}.web-import-controls input{flex:1;min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:9px 10px;font:inherit;font-size:13px}.web-import-controls button{flex-shrink:0}@media(max-width:560px){.web-import-controls{align-items:stretch;flex-direction:column}.web-import-controls button{width:100%}}
button{border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:8px 12px;font:inherit;font-size:12px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button.quiet{border-color:transparent;background:transparent;color:var(--dim)}button.danger{background:var(--red,#c92b41);border-color:var(--red,#c92b41);color:white}button.danger-quiet{background:transparent;border-color:var(--line);color:var(--red-text,#8e2739)}
.knowledge-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:8px}
/* 选中态不只靠颜色：加重字重 + 描边 + 独立底色，灰度下也能分辨 */
.knowledge-tabs .knowledge-tab{display:inline-flex;align-items:center;gap:7px;border:1px solid transparent;border-radius:8px;background:transparent;padding:7px 11px;color:var(--dim);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.knowledge-tabs .knowledge-tab:hover:not(.is-on){border-color:var(--line);background:var(--surface-2)}
.knowledge-tabs .knowledge-tab.is-on{background:var(--surface);border-color:var(--line-strong);color:var(--ink);font-weight:700}
.knowledge-tabs .tab-count{font-size:12px;font-weight:600;color:var(--dim);background:var(--surface-2);border-radius:20px;padding:2px 7px}
.knowledge-tabs .knowledge-tab.is-on .tab-count{background:var(--brand-soft);color:var(--brand-strong)}
.candidate-batch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px dashed var(--line-strong);border-radius:9px;background:var(--surface-2);padding:9px 11px}
.candidate-batch .muted{margin-right:auto}
.candidate-select{display:inline-flex;align-items:center;gap:6px;margin-right:auto;color:var(--dim);font-size:12px;cursor:pointer}
.entry-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.state-badge{font-size:12px;padding:4px 8px;border-radius:20px;border:1px solid var(--line-strong);background:var(--surface-2);color:var(--ink)}
.audit-note{display:flex;align-items:flex-start;gap:7px;margin:0;border:1px solid var(--amber-line,#ecd9b4);border-radius:8px;background:var(--amber-soft,#fdf6e7);padding:9px 11px;color:var(--amber,#8f5c05);font-size:12px;line-height:1.6}
.audit-mark{flex:none;display:inline-flex;width:16px;height:16px;align-items:center;justify-content:center;border-radius:50%;background:var(--amber,#8f5c05);color:white;font-size:12px;font-weight:700}
.confirm-message{margin:0;color:var(--ink);font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}
.confirm-warning{margin:0;border-left:2px solid var(--red,#c92b41);border-radius:0 8px 8px 0;background:var(--red-soft,#fdecee);padding:9px 11px;color:var(--red-text,#8e2739);font-size:12px;line-height:1.6}
.relation-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
/* 弹窗容器与遮罩已收进 AccessibleDialog（键盘焦点在这里统一处理），页面只留内容排版 */
.merge-body{display:flex;flex-direction:column;gap:12px}
.merge-body label{display:flex;flex-direction:column;gap:5px;color:var(--dim);font-size:12px}
.merge-comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.merge-comparison article{min-width:0;border:1px solid var(--line);border-radius:9px;padding:11px;background:var(--surface-2);display:flex;flex-direction:column;gap:7px}
.merge-comparison strong{font-size:12px;color:var(--ink)}
.merge-comparison h4{margin:0;font-size:13px;color:var(--ink)}
.merge-comparison p{margin:0;font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.merge-comparison span{font-size:12px;color:var(--dim);overflow-wrap:anywhere}
.merge-body input,.merge-body textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:9px;font:inherit;font-size:13px}
@media(max-width:600px){.merge-comparison{grid-template-columns:1fr}}
.candidate-card,.item-card{border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.candidate-raw,.item-card p,.processing-result p{margin:0;color:var(--ink);font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.status,.recommendation,.category{font-size:12px;padding:4px 8px;border-radius:20px;background:var(--surface-2);color:var(--dim)}
.processing-result{border-left:2px solid var(--accent);padding:10px 12px;background:var(--surface-2);border-radius:0 8px 8px 0;display:flex;flex-direction:column;gap:8px}
.result-top strong,.item-heading h3{color:var(--ink);font-size:14px}.reason,.error-text{font-size:12px;color:var(--dim);margin:0;line-height:1.6}.error-text{color:var(--danger,#c65b5b)}
.tag-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.tag{font-size:12px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:3px 8px}
.candidate-actions{display:flex;justify-content:flex-end;gap:8px}.item-heading h3{margin:0}.item-card p{white-space:pre-wrap}.item-date{font-size:12px;color:var(--dim);text-align:right}
.suggested-relations,.saved-relations{display:flex;flex-direction:column;gap:9px;padding:11px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}
.relation-heading,.suggested-relation{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.relation-heading strong,.saved-relations>strong{font-size:12px;color:var(--ink)}
.suggested-relation,.saved-relation{padding-top:9px;border-top:1px solid var(--line)}.relation-copy{min-width:0;display:flex;flex:1;flex-direction:column;gap:5px}.relation-copy strong{font-size:13px;color:var(--ink)}.relation-copy p{margin:0;color:var(--dim);font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.relation-kind{font-size:12px;color:var(--dim)}
.item-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.item-editor,.history-panel{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2)}
.item-editor label{display:flex;flex-direction:column;gap:5px;color:var(--dim);font-size:12px}
.item-editor input,.item-editor textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:9px;font:inherit;font-size:13px}
.editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.history-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.revision-card{display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.revision-card h4{margin:0;color:var(--ink);font-size:13px}
.revision-card p{font-size:12px;line-height:1.7;white-space:pre-wrap}

.empty-state,.loading-note,.knowledge-empty{color:var(--dim);font-size:13px;padding:10px 0}.loading-note{text-align:center}
@media(max-width:850px){.knowledge-flow{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.knowledge-flow{grid-template-columns:1fr}.knowledge-context-note{margin-left:0}.knowledge-section{padding:13px}.candidate-actions{flex-wrap:wrap}.editor-grid{grid-template-columns:1fr}}
</style>
