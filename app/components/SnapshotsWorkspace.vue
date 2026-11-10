<script setup lang="ts">
import { ArrowDown, Calendar, Files, Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character, Snapshot, SnapshotAnalysis, SnapshotDetail, SnapshotSourceMessage } from "~/utils/mock-data";
import MemorySectionNavigation from "~/components/MemorySectionNavigation.vue";

const pageDescription = "回看每个周期的经历、变化与约定，沿着来源了解每一份总结。";

const characters = useCharacterList();
await useCharacterListData();

/** 菜单页：当前角色由 ?c= 决定，与其他工作区共用角色选择 cookie */
const { id } = useCharacterSelection("/growth/memory/snapshots");

/** 头像 / 状态 / 归档周期都在角色列表里，不必再单独拉一次角色档案 */
const current = computed<Character | null>(
  () => characters.value.find((item) => item.id === id.value) ?? null,
);

/**
 * 三个接口各管一段，跟普通后台一致：
 * - 列表：一页摘要（计数 / 状态 / 待审核条数），筛选、搜索、翻页都在服务端；
 * - 详情：点开某一版才取 AI 提炼结果；
 * - 来源：展开「来源消息与原文」才取，那一块自己翻页。
 */
type SnapshotPage = {
  items: Snapshot[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  counts: { automatic: number; manual: number; current: number; superseded: number };
  stats: { messages: number; latestDate: string | null; automatic: number; manual: number };
};
type SnapshotSourcePage = {
  items: SnapshotSourceMessage[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

/** 一页 10 份：左栏列表自己滚，翻页也不会把右栏顶走 */
const PAGE_SIZE = 10;
const SOURCE_PAGE_SIZE = 10;

const items = ref<Snapshot[]>([]);
const loading = ref(true);
const page = ref(1);
const total = ref(0);
const totalPages = ref(1);
const counts = ref({ automatic: 0, manual: 0, current: 0, superseded: 0 });
const stats = ref<{ messages: number; latestDate: string | null; automatic: number; manual: number }>({ messages: 0, latestDate: null, automatic: 0, manual: 0 });

const query = ref("");
const statusFilter = ref("全部版本状态");
/** 手动存档默认收起：它不是总结，混在列表里只会把 AI 总结挤下去 */
const showManual = ref(false);

const detail = ref<SnapshotDetail | null>(null);
const detailLoading = ref(false);
const detailPanelEl = ref<HTMLElement | null>(null);
const overviewLink = computed(() => ({ path: "/growth/memory", query: id.value ? { c: id.value } : {} }));
const readingSections = computed(() => {
  const analysis = detail.value?.analysis;
  if (!analysis) return [];
  return [
    { key: "events", label: "重要事件", count: analysis.importantEvents.length },
    { key: "facts", label: "事实与偏好", count: analysis.factAndPreferenceChanges.length },
    { key: "relationships", label: "关系变化", count: analysis.relationshipChanges.length },
    { key: "goals", label: "目标与承诺", count: analysis.goalsAndCommitments.length },
    { key: "topics", label: "待跟进", count: analysis.unresolvedTopics.length },
    { key: "differences", label: "阶段变化", count: analysis.differencesFromPrevious.length },
    { key: "review", label: "记忆与审核", count: analysis.memoryChangesApplied.length },
  ].filter((section) => section.count > 0);
});
function jumpToSection(key: string) {
  detailPanelEl.value?.querySelector<HTMLElement>(`[data-reading-section="${key}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}
async function openSelectedDetail(snapshot: Snapshot) {
  const epoch = characterEpoch;
  selectDetail(snapshot);
  // 窄屏列表在详情上方；明确点选后定位阅读区（含加载态），自动选中与翻页不跳动页面。
  await nextTick();
  if (epoch === characterEpoch && window.matchMedia("(max-width: 980px)").matches) {
    detailPanelEl.value?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

/** 来源消息默认收起，展开时才请求；一次一页，分页器仍用服务端的 total。 */
const sourcesOpen = ref(false);
const sourcesLoading = ref(false);
const sourceItems = ref<SnapshotSourceMessage[]>([]);
const sourcePage = ref(1);
const sourceTotal = ref(0);
const sourceTotalPages = ref(1);
const sourceListEl = ref<HTMLElement | null>(null);

const creating = ref(false);
const regeneratingId = ref<string | null>(null);
const aiRegeneratingId = ref<string | null>(null);
const reviewingKey = ref("");
let listRequest = 0;
let characterEpoch = 0;
let detailVersion = 0;
let detailRequest = 0;
let sourceRequest = 0;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
const operationTokens = new Map<string, symbol>();

/** 确认框属于打开时的角色、版本和详情；切走再切回来也不能复活旧操作。 */
function captureOperation(name: string) {
  const token = Symbol(name);
  operationTokens.set(name, token);
  return { name, token, characterId: id.value, epoch: characterEpoch, version: detailVersion, snapshot: detail.value };
}
function operationActive(context: ReturnType<typeof captureOperation>) {
  return operationTokens.get(context.name) === context.token
    && context.epoch === characterEpoch && context.characterId === id.value;
}
function operationCurrent(context: ReturnType<typeof captureOperation>) {
  return operationActive(context) && context.version === detailVersion && context.snapshot === detail.value;
}
function resetCharacterPage() {
  characterEpoch++;
  listRequest++;
  detailRequest++;
  sourceRequest++;
  operationTokens.clear();
  items.value = [];
  page.value = 1;
  total.value = 0;
  totalPages.value = 1;
  counts.value = { automatic: 0, manual: 0, current: 0, superseded: 0 };
  stats.value = { messages: 0, latestDate: null, automatic: 0, manual: 0 };
  applyDetail(null);
  creating.value = false;
  regeneratingId.value = null;
  aiRegeneratingId.value = null;
  reviewingKey.value = "";
}

const statusOptions = ["全部版本状态", "当前版本", "已被替代"];
const totalMessages = computed(() => stats.value.messages);
/** 统计带用全量口径（不随搜索/筛选变化）；芯片计数跟着当前关键词走。 */
const autoCount = computed(() => stats.value.automatic);
const manualCount = computed(() => stats.value.manual);
const hasFilters = computed(() => Boolean(query.value.trim()) || statusFilter.value !== "全部版本状态");

/** 空列表提示指向总览页的阶段总结操作。 */
const emptyListText = computed(() => {
  if (hasFilters.value) return "没有符合条件的阶段总结，换个词或把筛选切回全部。";
  if (manualCount.value && !showManual.value) {
    return `这里还没有 AI 总结。另有 ${manualCount.value} 份手动存档被收起，点上面的「手动存档」可以展开。`;
  }
  return "生成阶段总结，回顾这一周期的经历与变化。手动存档只保留记录副本，不包含 AI 提炼结果。";
});

function statusParam() {
  return statusFilter.value === "当前版本" ? "CURRENT" : statusFilter.value === "已被替代" ? "SUPERSEDED" : "";
}
function countFor(status: string) {
  if (status === "当前版本") return counts.value.current;
  if (status === "已被替代") return counts.value.superseded;
  return showManual.value ? counts.value.automatic + counts.value.manual : counts.value.automatic;
}
function resetFilters() {
  query.value = "";
  statusFilter.value = "全部版本状态";
  page.value = 1;
  void loadSnapshots({ page: 1 });
}
function statusTone(status: Snapshot["status"]) {
  return status === "当前版本" ? "pill-green" : "pill-gray";
}
/** 两种归档的可见标签：AUTOMATIC 是模型提炼出的总结，MANUAL 只是一份快照 */
function kindLabel(kind: Snapshot["kind"]) {
  return kind === "AUTOMATIC" ? "AI 总结" : "仅存档";
}
/** 标题：自动归档数「第 N 份」，手动存档不占序号，只写「存档」 */
function titleOf(snapshot: Snapshot) {
  return snapshot.label || (snapshot.kind === "MANUAL" ? "存档" : "第 " + snapshot.number + " 份");
}

/** 换页后回到列表顶部：一页 10 条也有近千像素，停在原地会以为没翻动 */
watch(sourcePage, (next) => {
  if (next > 1) sourceListEl.value?.scrollIntoView({ block: "start", behavior: "smooth" });
});

/**
 * 列表请求。
 *
 * `selectedId` 只在「写操作完成后要停在同一份」时传；普通翻页/筛选不传，
 * 让右侧落到当前页第一份，避免停在一份已经不在列表里的总结上。
 */
async function loadSnapshots(options: { page?: number; selectedId?: string; refreshDetail?: boolean } = {}) {
  const characterId = id.value;
  const request = ++listRequest;
  const version = detailVersion;
  const isCurrent = () => request === listRequest && characterId === id.value;
  if (!characterId) {
    items.value = [];
    total.value = 0;
    totalPages.value = 1;
    loading.value = false;
    applyDetail(null);
    return false;
  }
  const targetPage = options.page ?? page.value;
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(PAGE_SIZE) });
    if (statusParam()) params.set("status", statusParam());
    if (!showManual.value) params.set("kind", "AUTOMATIC");
    const keyword = query.value.trim();
    if (keyword) params.set("q", keyword);
    const result = await $fetch<SnapshotPage>(
      `/api/characters/${encodeURIComponent(characterId)}/snapshots?${params.toString()}`,
    );
    if (!isCurrent()) return false;
    items.value = result.items;
    total.value = result.total;
    page.value = result.page;
    totalPages.value = result.totalPages;
    counts.value = result.counts;
    stats.value = result.stats;

    const keepId = options.selectedId ?? (detailVersion === version ? detail.value?.id : undefined);
    const target = (keepId ? result.items.find((item) => item.id === keepId) : undefined) || result.items[0] || null;
    if (!target) {
      applyDetail(null);
      return true;
    }
    // 同一份且不要求刷新时沿用已有详情：翻页不该让右侧闪一下。
    if (!options.refreshDetail && detail.value?.id === target.id) return true;
    await loadDetail(target.id, isCurrent);
    return true;
  } catch {
    if (!isCurrent()) return false;
    items.value = [];
    total.value = 0;
    totalPages.value = 1;
    applyDetail(null);
    ElMessage.error("阶段总结加载失败，请确认本地数据库已迁移。");
    return false;
  } finally {
    if (request === listRequest && characterId === id.value) loading.value = false;
  }
}

/** 详情：AI 提炼结果单独取，列表里没有它。 */
async function loadDetail(snapshotId: string, stillActive: () => boolean = () => true) {
  const request = ++detailRequest;
  const characterId = id.value;
  // 换成另一份时先清空：否则右侧会短暂显示上一份的正文，看起来像串了页。
  if (detail.value && detail.value.id !== snapshotId) applyDetail(null);
  detailLoading.value = true;
  try {
    const result = await $fetch<SnapshotDetail>(
      `/api/characters/${encodeURIComponent(characterId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    );
    if (request !== detailRequest || characterId !== id.value || !stillActive()) return false;
    applyDetail(result);
    return true;
  } catch {
    if (request !== detailRequest || characterId !== id.value) return false;
    if (!stillActive()) return false;
    ElMessage.error("阶段总结详情读取失败，请检查本地开发服务器日志。");
    return false;
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

/**
 * 选中一份总结。来源消息的默认开合按内容决定：
 * 有 AI 提炼结果时它是「依据」，收起；只有结构化记录时原文就是内容本身，摊开 ——
 * 否则整张详情卡只剩两行字，右边空一大片。
 */
function applyDetail(next: SnapshotDetail | null) {
  const changed = next?.id !== detail.value?.id;
  detailVersion++;
  detail.value = next;
  sourcesOpen.value = Boolean(next) && !next?.analysis;
  sourcePage.value = 1;
  sourceItems.value = [];
  sourceTotal.value = 0;
  sourceTotalPages.value = 1;
  sourceRequest += 1;
  if (changed) sourcesLoading.value = false;
  if (sourcesOpen.value && next) void loadSources(1);
}

function selectDetail(snapshot: Snapshot) {
  if (detail.value?.id === snapshot.id && !detailLoading.value) return;
  void loadDetail(snapshot.id);
}

/** 来源原文：展开时才请求，翻页也只在弹开的这一块里换。 */
async function loadSources(targetPage = 1) {
  const snapshot = detail.value;
  if (!snapshot) return;
  const characterId = id.value;
  const request = ++sourceRequest;
  sourcesLoading.value = true;
  try {
    const result = await $fetch<SnapshotSourcePage>(
      `/api/characters/${encodeURIComponent(characterId)}/snapshots/${encodeURIComponent(snapshot.id)}/sources?page=${targetPage}&pageSize=${SOURCE_PAGE_SIZE}`,
    );
    if (request !== sourceRequest || characterId !== id.value || detail.value?.id !== snapshot.id) return;
    sourceItems.value = result.items;
    sourceTotal.value = result.total;
    sourcePage.value = result.page;
    sourceTotalPages.value = result.totalPages;
  } catch {
    if (request !== sourceRequest || detail.value?.id !== snapshot.id) return;
    sourceItems.value = [];
    sourceTotal.value = 0;
    sourceTotalPages.value = 1;
    ElMessage.error("来源消息读取失败，请检查本地开发服务器日志。");
  } finally {
    if (request === sourceRequest) sourcesLoading.value = false;
  }
}

function toggleSources() {
  sourcesOpen.value = !sourcesOpen.value;
  if (sourcesOpen.value && !sourceItems.value.length) void loadSources(1);
}

function changeSourcePage(next: number) {
  if (next === sourcePage.value) return;
  sourcePage.value = next;
  void loadSources(next);
}

/** 筛选是服务端参数：点一下就是一页新数据，不在本地过滤。 */
function setStatusFilter(next: string) {
  if (statusFilter.value === next) return;
  statusFilter.value = next;
  page.value = 1;
  void loadSnapshots({ page: 1 });
}

function setShowManual(next: boolean) {
  if (showManual.value === next) return;
  showManual.value = next;
  page.value = 1;
  void loadSnapshots({ page: 1 });
}

function changePage(next: number) {
  if (next === page.value) return;
  page.value = next;
  void loadSnapshots({ page: next });
}

function errorMessage(error: unknown) {
  return error && typeof error === "object" && "statusMessage" in error
    ? String(error.statusMessage)
    : "操作失败，请检查数据库连接。";
}

/**
 * 依据消息按它在来源列表里的序号显示成 #2、#4。
 * 序号由服务端按全量顺序给（`evidenceIndex`），翻到第几页都对得上。
 */
function evidenceLabel(ids: string[]) {
  const index = detail.value?.evidenceIndex || {};
  return ids.map((sourceId) => index[sourceId] ? `#${index[sourceId]}` : sourceId.slice(0, 8)).join("、");
}
function sourceRoleLabel(source: SnapshotSourceMessage) {
  if (source.eventType !== "message") return "平台事件";
  return source.role === "USER" ? "用户" : source.role === "ASSISTANT" ? "角色" : source.role === "TOOL" ? "工具" : "系统";
}
function sourceTone(source: SnapshotSourceMessage) {
  if (source.eventType !== "message") return "pill-gray";
  return source.role === "USER" ? "pill-green" : source.role === "ASSISTANT" ? "pill-purple" : "pill-gray";
}
function sourceTime(source: SnapshotSourceMessage) {
  const date = new Date(source.occurredAt);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : source.occurredAt;
}
function showSourceMessage(source: SnapshotSourceMessage) {
  return ElMessageBox.alert(
    source.content,
    `${sourceRoleLabel(source)} · ${sourceTime(source)}`,
    { confirmButtonText: "关闭", type: "info", customClass: "source-message-dialog" },
  );
}
function memoryChangeLabel(action: string, result: string, reviewDecision?: "ACCEPTED" | "IGNORED", reviewOutcome?: string) {
  const actionLabel = action === "ADD" ? "新增" : action === "UPDATE" ? "更新" : action === "INVALIDATE" ? "标记失效" : action;
  // 处置过之后，结论就该写在标题上 —— 否则标题说「未应用」、右边说「已采纳」，自相矛盾。
  if (reviewDecision === "ACCEPTED") {
    return actionLabel + " · " + (reviewOutcome === "DUPLICATE_IGNORED" ? "已采纳（内容重复）" : "已采纳");
  }
  if (reviewDecision === "IGNORED") return actionLabel + " · 已忽略";
  const resultLabel = result === "CREATED" ? "已创建" : result === "REPLACED" ? "已替换旧记忆" : result === "INVALIDATED" ? "已失效" : result === "DUPLICATE_IGNORED" ? "忽略重复项" : result === "NOT_APPLIED_REGENERATION" ? "仅供审核（未应用）" : result;
  return actionLabel + " · " + resultLabel;
}

/**
 * 重新提炼写出的是「建议」，不会自动落库。列表页得先说一句，
 * 否则跑完之后唯一的线索只有 v2，人不会点进去翻到最后一块。
 */
function pendingReviewCount(snapshot: Snapshot) {
  return snapshot.pendingReview || 0;
}

type MemoryChangeRow = SnapshotAnalysis["memoryChangesApplied"][number];

/** 只有重新提炼留下、且还没人处理过的条目才给操作按钮 */
function reviewPending(item: MemoryChangeRow) {
  return item.result === "NOT_APPLIED_REGENERATION" && !item.reviewDecision;
}

function reviewResultMessage(decision: "ACCEPT" | "IGNORE", outcome: string | null) {
  if (decision === "IGNORE") return "已忽略这条建议，不会改动任何记忆。";
  if (outcome === "DUPLICATE_IGNORED") return "内容与已有记忆相同，没有重复新建。";
  if (outcome === "REPLACED") return "已采纳：原记忆标记为已被替代，新内容已写入。";
  if (outcome === "INVALIDATED") return "已采纳：目标记忆已标记失效。";
  return "已采纳，已写入长期记忆。";
}

/** 采纳会真的写库，先按变更类型说清楚会发生什么 */
function confirmAccept(item: MemoryChangeRow) {
  const hint = item.action === "ADD"
    ? "会把这条作为新的长期记忆写入，角色之后就可能提到它。"
    : item.action === "UPDATE"
      ? "会新建这条记忆，并把下面那条「当前记忆」标记为已被替代。"
      : "会把下面那条「当前记忆」标记为失效，之后不再参与检索。";
  return ElMessageBox.confirm(hint, "采纳这条建议", {
    confirmButtonText: "采纳",
    cancelButtonText: "取消",
    type: "warning",
  }).then(() => true).catch(() => false);
}

async function reviewChange(changeIndex: number, decision: "ACCEPT" | "IGNORE", item: MemoryChangeRow) {
  if (!id.value || !detail.value || reviewingKey.value || !reviewPending(item)
    || detail.value.analysis?.memoryChangesApplied[changeIndex] !== item) return;
  const context = captureOperation("review");
  const characterId = context.characterId;
  const snapshotId = detail.value.id;
  const key = changeIndex + ":" + decision;
  reviewingKey.value = key;
  try {
    if (decision === "ACCEPT" && !(await confirmAccept(item))) return;
    if (!operationCurrent(context) || detail.value?.analysis?.memoryChangesApplied[changeIndex] !== item || !reviewPending(item)) return;
    const result = await $fetch<{ outcome: string | null }>(
      `/api/characters/${encodeURIComponent(characterId)}/snapshots/${encodeURIComponent(snapshotId)}/review`,
      { method: "POST", body: { changeIndex, decision } },
    );
    if (!operationCurrent(context)) return;
    ElMessage.success(reviewResultMessage(decision, result.outcome));
    // 刷新后保持原来选中哪一份、以及来源消息是开还是收。
    const keepSources = sourcesOpen.value;
    if (await loadSnapshots({ selectedId: snapshotId, refreshDetail: true }) && operationActive(context)) {
      if (keepSources && !sourcesOpen.value) {
        sourcesOpen.value = true;
        await loadSources(1);
      }
    }
  } catch (error) {
    if (operationCurrent(context)) ElMessage.error(errorMessage(error));
  } finally {
    if (operationActive(context)) reviewingKey.value = "";
  }
}

/**
 * 归档在后台跑完之后刷新列表。
 *
 * 面板轮询跟的是任务行，这里接住「刚结束」这个信号；不刷新的话页面会停在你点的那一刻，
 * 看起来像什么都没发生。
 */
const { lastFinished } = useMemoryProgress();
watch(lastFinished, (job) => {
  if (!job || job.characterId !== id.value) return;
  void loadSnapshots({ refreshDetail: true });
});

async function createSnapshot() {
  if (!id.value || creating.value) return;
  const context = captureOperation("create");
  const characterId = context.characterId;
  try {
    await ElMessageBox.confirm(
      "只把当下这一刻拍成快照：当前周期内的消息来源 + 全部生效中的长期记忆。不调用模型，也不会触发或替代自动归档。自动归档由调度器在周期结束时排任务、调模型提炼。",
      "手动存档（不调用模型）",
      { confirmButtonText: "存档", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  if (!operationCurrent(context)) return;
  creating.value = true;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(characterId)}/snapshots`, { method: "POST" });
    if (!operationCurrent(context)) return;
    // 刚存的那份如果被默认收起，用户会以为没存上
    showManual.value = true;
    page.value = 1;
    if (!(await loadSnapshots({ page: 1, selectedId: result.id, refreshDetail: true })) || !operationActive(context)) return;
    ElMessage.success("已存档到 PostgreSQL，关联了周期内可用的消息来源；没有调用模型。");
  } catch (error) {
    if (operationCurrent(context)) ElMessage.error(errorMessage(error));
  } finally {
    if (operationActive(context)) creating.value = false;
  }
}

async function regenerateWithAi(snapshot: Snapshot) {
  if (!id.value || detail.value?.id !== snapshot.id || aiRegeneratingId.value) return;
  const context = captureOperation("aiRegenerate");
  const characterId = context.characterId;
  const snapshotId = snapshot.id;
  try {
    await ElMessageBox.confirm(
      "系统会对这份自动归档覆盖的历史周期重新调用模型，并创建同一阶段总结档案的新版本。旧版本会保留；为避免历史重放改写当前长期记忆，本次提出的长期记忆变化只展示供审核，不会自动应用。",
      "AI 重新提炼",
      { confirmButtonText: "排入重新提炼任务", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  if (!operationCurrent(context)) return;
  aiRegeneratingId.value = snapshotId;
  try {
    const result = await $fetch<{ jobId: string; status: string; duplicate: boolean }>(
      `/api/characters/${encodeURIComponent(characterId)}/snapshots`,
      { method: "POST", body: { snapshotId, mode: "ai" } },
    );
    if (!operationCurrent(context)) return;
    ElMessage.success(
      result.duplicate
        ? "这份阶段总结已有等待中的 AI 重新提炼任务，无需重复排队。"
        : "AI 重新提炼任务已排队。请到“后台任务”运行 Worker，并查看新生成的总结版本。",
    );
  } catch (error) {
    if (operationCurrent(context)) ElMessage.error(errorMessage(error));
  } finally {
    if (operationActive(context)) aiRegeneratingId.value = null;
  }
}

async function regenerate(snapshot: Snapshot) {
  if (!id.value || detail.value?.id !== snapshot.id || regeneratingId.value) return;
  const context = captureOperation("regenerate");
  const characterId = context.characterId;
  const snapshotId = snapshot.id;
  try {
    await ElMessageBox.confirm(
      `为「${titleOf(snapshot)}」创建新版本？旧版本会保留，并标记为已被替代。`,
      "重新生成阶段总结",
      { confirmButtonText: "创建新版本", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  if (!operationCurrent(context)) return;
  regeneratingId.value = snapshotId;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(characterId)}/snapshots`, {
      method: "POST",
      body: { snapshotId },
    });
    if (!operationCurrent(context)) return;
    page.value = 1;
    if (!(await loadSnapshots({ page: 1, selectedId: result.id, refreshDetail: true })) || !operationActive(context)) return;
    ElMessage.success("新版本已写入数据库，旧版本仍保留。");
  } catch (error) {
    if (operationCurrent(context)) ElMessage.error(errorMessage(error));
  } finally {
    if (operationActive(context)) regeneratingId.value = null;
  }
}

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    page.value = 1;
    void loadSnapshots({ page: 1 });
  }, 300);
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  characterEpoch++;
  listRequest++;
  detailRequest++;
  sourceRequest++;
});

onMounted(() => void loadSnapshots({ page: 1 }));
watch(id, () => {
  resetCharacterPage();
  void loadSnapshots({ page: 1 });
}, { flush: "sync" });
</script>

<template>
  <div class="page-wrap">
    <MemorySectionNavigation
      active="snapshots"
    />
    <PageHeader
      :description="pageDescription"
    >
      <template #actions>
        <NuxtLink
          :to="overviewLink"
          class="btn primary"
          :aria-disabled="!current"
        >
          前往生成总结
        </NuxtLink>
        <button
          type="button"
          class="btn"
          :disabled="creating || !id"
          title="只保存当下记录，不调用模型"
          @click="createSnapshot"
        >
          <el-icon><Files /></el-icon>{{ creating ? "存档中…" : "手动存档（不调模型）" }}
        </button>
      </template>
    </PageHeader>

    <template v-if="characters.length">
      <!-- 一条静音统计带：原来三张 KPI 卡和正文一样重，其中两个数几乎不变 -->
      <div class="card stat-band">
        <div class="sb-cell">
          <span class="sb-k">历史归档</span>
          <span class="sb-v">{{ autoCount }}<small>份</small></span>
          <span class="sb-f">{{ manualCount ? `另有 ${manualCount} 份手动存档，不计入序号` : "历史版本都保留，不会被覆盖" }}</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">覆盖消息</span>
          <span class="sb-v">{{ totalMessages }}<small>条</small></span>
          <span class="sb-f">来自已归档周期的原始对话</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">归档周期</span>
          <span class="sb-v">{{ current?.intervalDays ?? "—" }}<small>天</small></span>
          <span class="sb-f">
            下一次 {{ current?.nextSnapshot || "尚未计划" }}<template v-if="current?.pendingIntervalDays">，之后改为 {{ current.pendingIntervalDays }} 天</template>
          </span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">最近生成</span>
          <span class="sb-v">{{ stats.latestDate ? stats.latestDate.slice(5, 10) : "—" }}</span>
          <span class="sb-f">{{ stats.latestDate ? stats.latestDate.slice(0, 4) + " 年归档" : "还没有归档过" }}</span>
        </div>
      </div>

      <div class="archive-tip">
        <el-icon><Files /></el-icon><span>AI 总结记录经历与变化；手动存档只保存记录副本，不调用模型。重新提炼会创建新版本，历史仍可查阅。</span>
      </div>
      <div class="snap-grid">
        <section>
          <div class="sec-h">
            <h2>归档时间线</h2>
            <span class="sub">{{ total }} 份</span>
          </div>
          <div class="card list-card">
            <div class="filters">
              <button
                v-for="option in statusOptions"
                :key="option"
                type="button"
                class="chip"
                :class="{ on: statusFilter === option }"
                @click="setStatusFilter(option)"
              >
                {{ option === "全部版本状态" ? "全部" : option }}<span class="n">{{ countFor(option) }}</span>
              </button>
              <button
                v-if="manualCount"
                type="button"
                class="chip manual-chip"
                :class="{ on: showManual }"
                :title="showManual ? '当前显示手动存档' : '手动存档不调模型，默认收起'"
                @click="setShowManual(!showManual)"
              >
                <el-icon><Files /></el-icon>手动存档<span class="n">{{ manualCount }}</span>
              </button>
            </div>
            <div class="list-tools">
              <el-input
                v-model="query"
                clearable
                placeholder="搜索总结内容……"
                class="list-search"
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>
              <button
                v-if="hasFilters"
                type="button"
                class="reset-link"
                @click="resetFilters"
              >
                重置
              </button>
            </div>

            <div class="snap-list">
              <template v-if="loading">
                <div
                  v-for="n in 4"
                  :key="n"
                  class="sk sk-row"
                />
              </template>
              <template v-else>
                <button
                  v-for="snapshot in items"
                  :key="snapshot.id"
                  type="button"
                  class="snap-row"
                  :class="{ on: detail?.id === snapshot.id }"
                  :aria-pressed="detail?.id === snapshot.id"
                  @click="openSelectedDetail(snapshot)"
                >
                  <span class="snap-row-top">
                    <span class="snap-row-title">{{ titleOf(snapshot) }} <span class="snap-row-ver">v{{ snapshot.version }}</span></span>
                    <span class="snap-row-tags">
                      <!-- 「自动」和「手动」差着一个模型调用，不标出来就只能靠 summary 猜 -->
                      <span
                        class="pill"
                        :class="snapshot.kind === 'AUTOMATIC' ? 'pill-purple' : 'pill-gray'"
                      >{{ kindLabel(snapshot.kind) }}</span>
                      <span
                        v-if="pendingReviewCount(snapshot)"
                        class="pill pill-amber"
                      >待审核 {{ pendingReviewCount(snapshot) }}</span>
                      <span
                        class="pill"
                        :class="statusTone(snapshot.status)"
                      >{{ snapshot.status }}</span>
                    </span>
                  </span>
                  <span class="snap-row-period">{{ snapshot.range }}</span>
                  <span class="snap-row-sum">{{ snapshot.summary }}</span>
                  <span class="snap-row-meta">
                    <el-icon><Calendar /></el-icon>{{ snapshot.date.slice(5, 16) }} ·
                    <template v-if="snapshot.messages || snapshot.events">{{ snapshot.messages }} 条消息 · {{ snapshot.events }} 个事件</template>
                    <template v-else>这个周期没有可归档的内容</template>
                  </span>
                </button>
                <div
                  v-if="!items.length"
                  class="list-empty snapshot-empty"
                >
                  <el-icon><Files /></el-icon>
                  <strong>{{ hasFilters ? "没有匹配的总结" : "这一段经历，还等着被整理" }}</strong>
                  <p>{{ emptyListText }}</p>
                  <el-button
                    v-if="hasFilters"
                    @click="resetFilters"
                  >
                    重置筛选
                  </el-button>
                  <NuxtLink
                    v-else
                    :to="overviewLink"
                    class="btn"
                  >
                    前往生成第一份总结
                  </NuxtLink>
                </div>
              </template>
            </div>
            <PagerBar
              v-if="total > 0"
              :page="page"
              :total="total"
              :total-pages="totalPages"
              :page-size="PAGE_SIZE"
              unit="份"
              flush
              @update:page="changePage"
            />
          </div>
        </section>

        <section
          ref="detailPanelEl"
          class="detail-panel"
          aria-label="阶段总结阅读区"
          tabindex="-1"
        >
          <div class="sec-h">
            <h2>阶段总结详情</h2>
            <span class="sub">{{ detail ? "v" + detail.version : "未选择" }}</span>
          </div>
          <div class="card detail-card">
            <template v-if="detail">
              <header class="d-head">
                <h2>{{ detail.kind === "MANUAL" ? "存档 · " + detail.date.slice(5, 16) : titleOf(detail) + "阶段总结" }}</h2>
                <span class="d-head-tags">
                  <span
                    class="pill"
                    :class="detail.kind === 'AUTOMATIC' ? 'pill-purple' : 'pill-gray'"
                  >{{ kindLabel(detail.kind) }}</span>
                  <span
                    class="pill"
                    :class="statusTone(detail.status)"
                  >{{ detail.status }}</span>
                </span>
              </header>
              <dl class="detail-facts">
                <div><dt>覆盖周期</dt><dd>{{ detail.range }}</dd></div>
                <div><dt>生成时间</dt><dd>{{ detail.date }}</dd></div>
                <div><dt>当前阅读</dt><dd>版本 v{{ detail.version }} · {{ detail.messages }} 条消息 · {{ detail.events }} 个事件</dd></div>
              </dl>
              <nav
                v-if="readingSections.length"
                class="reading-nav"
                aria-label="总结章节定位"
              >
                <span>快速定位</span>
                <button
                  v-for="section in readingSections"
                  :key="section.key"
                  type="button"
                  @click="jumpToSection(section.key)"
                >
                  {{ section.label }}<small>{{ section.count }}</small>
                </button>
                <button
                  type="button"
                  @click="jumpToSection('sources')"
                >
                  来源原文
                </button>
              </nav>
              <h3 class="summary-label">
                本期摘要
              </h3>
              <p class="d-summary">
                {{ detail.summary }}
              </p>

              <div
                v-if="detailLoading"
                class="d-note"
              >
                <el-icon><Files /></el-icon>正在读取这一版的提炼结果……
              </div>
              <section
                v-else-if="detail.analysis"
                class="d-sec"
              >
                <div class="d-sec-h">
                  <h3>AI 提炼结果</h3>
                  <span
                    v-if="detail.model?.name"
                    class="pill pill-purple"
                  >{{ detail.model.name }}</span>
                </div>

                <div
                  v-if="detail.analysis.importantEvents.length"
                  data-reading-section="events"
                  class="a-block"
                >
                  <h4>重要事件</h4>
                  <article
                    v-for="(item, index) in detail.analysis.importantEvents"
                    :key="'event-' + index"
                    class="a-item"
                  >
                    <strong>{{ item.title }}</strong>
                    <p>{{ item.detail }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.factAndPreferenceChanges.length"
                  data-reading-section="facts"
                  class="a-block"
                >
                  <h4>事实与偏好变化</h4>
                  <article
                    v-for="(item, index) in detail.analysis.factAndPreferenceChanges"
                    :key="'fact-' + index"
                    class="a-item"
                  >
                    <strong>{{ item.changeType }}</strong>
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.relationshipChanges.length"
                  data-reading-section="relationships"
                  class="a-block"
                >
                  <h4>关系变化</h4>
                  <article
                    v-for="(item, index) in detail.analysis.relationshipChanges"
                    :key="'relation-' + index"
                    class="a-item"
                  >
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.goalsAndCommitments.length"
                  data-reading-section="goals"
                  class="a-block"
                >
                  <h4>目标与承诺</h4>
                  <article
                    v-for="(item, index) in detail.analysis.goalsAndCommitments"
                    :key="'goal-' + index"
                    class="a-item"
                  >
                    <strong>{{ item.status }}</strong>
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.unresolvedTopics.length"
                  data-reading-section="topics"
                  class="a-block"
                >
                  <h4>待跟进话题</h4>
                  <article
                    v-for="(item, index) in detail.analysis.unresolvedTopics"
                    :key="'topic-' + index"
                    class="a-item"
                  >
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.differencesFromPrevious.length"
                  data-reading-section="differences"
                  class="a-block"
                >
                  <h4>相较上一份总结</h4>
                  <ul class="a-list">
                    <li
                      v-for="(item, index) in detail.analysis.differencesFromPrevious"
                      :key="'diff-' + index"
                    >
                      {{ item }}
                    </li>
                  </ul>
                </div>

                <div
                  v-if="detail.analysis.memoryChangesApplied.length"
                  data-reading-section="review"
                  class="a-block"
                >
                  <h4>
                    长期记忆变化与审核建议
                    <span
                      v-if="detail.reviewRejected"
                      class="a-rejected"
                    >另 {{ detail.reviewRejected }} 条未通过来源校验</span>
                  </h4>
                  <article
                    v-for="(item, index) in detail.analysis.memoryChangesApplied"
                    :key="'change-' + index"
                    class="a-item"
                  >
                    <strong>{{ memoryChangeLabel(item.action, item.result, item.reviewDecision, item.reviewOutcome) }}</strong>
                    <p>{{ item.content || '关联记忆 ' + (item.memoryItemId || item.supersededMemoryId || '—') }}</p>
                    <!-- 没有这一行，「更新」等于没有对照组：看得见要改成什么，看不见现在是什么 -->
                    <div
                      v-if="item.supersededContent"
                      class="a-prev"
                    >
                      <span>当前记忆</span>{{ item.supersededContent }}
                    </div>
                    <div
                      v-if="item.evidenceMessageIds?.length || reviewPending(item)"
                      class="a-foot"
                    >
                      <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                      <span
                        v-if="reviewPending(item)"
                        class="a-actions"
                      >
                        <el-button
                          size="small"
                          :loading="reviewingKey === index + ':ACCEPT'"
                          @click="reviewChange(index, 'ACCEPT', item)"
                        >
                          采纳
                        </el-button>
                        <el-button
                          size="small"
                          text
                          :loading="reviewingKey === index + ':IGNORE'"
                          @click="reviewChange(index, 'IGNORE', item)"
                        >
                          忽略
                        </el-button>
                      </span>
                    </div>
                  </article>
                </div>
              </section>
              <p
                v-else
                class="d-note"
              >
                <el-icon><Files /></el-icon>
                {{ detail.kind === "MANUAL" ? "这是一份手动存档：只保存了当时的消息来源与长期记忆副本，没有 AI 提炼结果。要 AI 总结这段时间，用自动归档。" : "这是一份旧版总结，保存的是结构化记录；AI 提炼结果会显示在这里。" }}
              </p>

              <section
                class="d-sec"
                data-reading-section="sources"
              >
                <button
                  type="button"
                  class="src-toggle"
                  :aria-expanded="sourcesOpen"
                  @click="toggleSources"
                >
                  <el-icon
                    class="src-caret"
                    :class="{ open: sourcesOpen }"
                  >
                    <ArrowDown />
                  </el-icon>
                  来源消息与原文
                  <span class="src-count">
                    {{ detail.messages }} 条<template v-if="sourcesOpen && sourceTotal > SOURCE_PAGE_SIZE"> · 第 {{ (sourcePage - 1) * SOURCE_PAGE_SIZE + 1 }}–{{ Math.min(sourcePage * SOURCE_PAGE_SIZE, sourceTotal) }} 条</template>
                  </span>
                </button>

                <div
                  v-if="sourcesOpen"
                  ref="sourceListEl"
                  class="src-list"
                >
                  <div
                    v-if="sourcesLoading && !sourceItems.length"
                    class="list-empty"
                  >
                    正在读取来源消息……
                  </div>
                  <article
                    v-for="source in sourceItems"
                    :key="source.id"
                    class="src-item"
                  >
                    <div class="src-top">
                      <span class="src-no">#{{ source.index }}</span>
                      <span
                        class="pill"
                        :class="sourceTone(source)"
                      >{{ sourceRoleLabel(source) }}</span>
                      <span class="src-time">{{ sourceTime(source) }}</span>
                      <button
                        type="button"
                        class="src-more"
                        @click="showSourceMessage(source)"
                      >
                        查看原文
                      </button>
                    </div>
                    <p class="src-conv">
                      {{ source.conversationTitle || "未命名会话" }}
                    </p>
                    <p class="src-preview">
                      {{ source.content }}
                    </p>
                  </article>
                  <PagerBar
                    v-if="sourceTotalPages > 1"
                    :page="sourcePage"
                    :total="sourceTotal"
                    :total-pages="sourceTotalPages"
                    :page-size="SOURCE_PAGE_SIZE"
                    flush
                    @update:page="changeSourcePage"
                  />
                  <!--
                    这里必须独立 v-if，不能 v-else-if：加载完成后条数为 0 时，
                    仍要说清「没有可追溯的原始消息」。
                  -->
                  <p
                    v-if="!sourcesLoading && !sourceTotal"
                    class="list-empty"
                  >
                    没有可追溯的原始消息，可能是旧版本、纯记忆归档，或来源消息已被清理。
                  </p>
                </div>
              </section>

              <footer class="d-foot">
                <p
                  v-if="detail.kind === 'AUTOMATIC'"
                  class="d-foot-note"
                >
                  重新提炼会为同一周期创建新版本，旧版本保留；记忆变化仅供审核，不会自动覆盖。
                </p>
                <button
                  v-if="detail.kind === 'AUTOMATIC'"
                  type="button"
                  class="btn sm d-action"
                  :disabled="aiRegeneratingId === detail.id || regeneratingId === detail.id"
                  @click="regenerateWithAi(detail)"
                >
                  <el-icon><Refresh /></el-icon>{{ aiRegeneratingId === detail.id ? "重新提炼中…" : "AI 重新提炼" }}
                </button>
                <button
                  v-else
                  type="button"
                  class="btn sm d-action"
                  :disabled="regeneratingId === detail.id || aiRegeneratingId === detail.id"
                  @click="regenerate(detail)"
                >
                  <el-icon><Refresh /></el-icon>{{ regeneratingId === detail.id ? "重新生成中…" : "重新生成此版本" }}
                </button>
              </footer>
            </template>

            <template v-else-if="loading || detailLoading">
              <div
                v-for="n in 4"
                :key="n"
                class="sk"
                :style="{ height: n === 1 ? '22px' : '56px', width: n === 1 ? '42%' : '100%', marginBottom: '10px' }"
              />
            </template>
            <p
              v-else
              class="list-empty"
            >
              {{ hasFilters ? "调整筛选后，选择一份总结开始阅读。" : "选择一份阶段总结，查看本期摘要、变化与来源依据。" }}
            </p>
          </div>
        </section>
      </div>
    </template>
    <el-empty
      v-else
      description="创建角色后，即可查看它的阶段总结与历史版本"
    >
      <NuxtLink
        to="/characters"
        class="btn primary"
      >
        前往创建角色
      </NuxtLink>
    </el-empty>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览 / 角色记忆 / AI 对话的 A 套：白砖、零描边、零阴影，
   层次靠明度差 + 间距，颜色只给状态。
   ══════════════════════════════════════════════════════════════ */
.card{border:0;border-radius:10px;box-shadow:none}

/* ── 主次两栏：列表窄、详情宽（详情要读长文本） ───────── */
.snap-grid{display:grid;grid-template-columns:minmax(272px,344px) minmax(0,1fr);gap:16px;align-items:start}

/* ── 左：归档时间线 ─────────────────────────────────── */
.list-card{padding:12px 10px 8px}
.list-tools{display:flex;align-items:center;gap:8px;padding:0 4px}
/* 存档开关放右侧、弱化：它是一层过滤，不是第三种版本状态 */
.manual-chip{margin-left:auto;gap:5px;height:26px;padding:0 10px;color:var(--dim)}
.manual-chip .el-icon{font-size:12px}
/* 它和「全部 / 当前版本 / 已被替代」不是一个维度：开启时用品牌浅底，
   不要继承 .chip.on 的深色底（深底 + 弱文字 = 看起来是个空胶囊）。 */
.manual-chip.on{border-color:var(--brand);background:var(--brand-soft);color:var(--brand-strong)}
.list-search{min-width:0;flex:1}
.reset-link{border:0;border-radius:6px;background:none;padding:2px 4px;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.reset-link:hover{text-decoration:underline}
/* 左栏列表自己滚，别让几十份归档把右栏详情推到视口外 */
.snap-list{display:flex;max-height:calc(100dvh - 340px);flex-direction:column;gap:2px;margin-top:8px;overflow:auto}
.snap-row{display:flex;width:100%;flex-direction:column;gap:5px;border:0;border-radius:8px;background:none;padding:10px 10px 11px;text-align:left;cursor:pointer;transition:background .14s var(--ease)}
.snap-row:hover{background:var(--surface-2)}
.snap-row.on{background:var(--brand-soft);box-shadow:inset 2px 0 0 var(--brand)}
.snap-row-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.snap-row-tags{display:flex;align-items:center;gap:6px;flex:none}
.snap-row-title{color:var(--text);font-size:14px;font-weight:600;line-height:1.45}
.snap-row.on .snap-row-title{color:var(--brand-strong)}
.snap-row-ver{color:var(--dim);font-weight:500}
.snap-row-sum{display:-webkit-box;overflow:hidden;color:var(--dim);font-size:12px;line-height:1.7;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.snap-row-meta{display:flex;align-items:center;gap:4px;color:var(--dim);font-size:12px;line-height:1.5}
.snap-row-meta .el-icon{font-size:12px}
.sk-row{height:74px;border-radius:8px}
.list-empty{margin:0;padding:22px 12px;color:var(--dim);font-size:12px;line-height:1.8;text-align:center}

/* ── 右：详情 ──────────────────────────────────────── */
.detail-card{padding:18px 20px 16px}
.d-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.d-head-tags{display:flex;align-items:center;gap:6px;flex:none}
.d-head h2{margin:0;color:var(--text);font-size:18px;font-weight:700;line-height:1.4}
.d-meta{margin:6px 0 0;color:var(--dim);font-size:12px;line-height:1.7}
/* 摘要是这页要读的东西：15px / 1.9，字号只比标题小一档 */
.d-summary{margin:12px 0 0;color:var(--text);font-size:16px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}

.d-sec{margin-top:20px;border-top:1px solid var(--surface-3);padding-top:16px}
.d-sec-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.d-sec-h h3{margin:0;color:var(--text-2);font-size:14px;font-weight:700}
.d-note{display:flex;align-items:flex-start;gap:7px;margin:16px 0 0;border-radius:8px;background:var(--surface-2);padding:11px 13px;color:var(--dim);font-size:12px;line-height:1.8}
.d-note .el-icon{margin-top:2px;flex:none;color:var(--faint)}

/* AI 提炼结果：一块一块的软底，不再每条都画 1px 边框 */
.a-block + .a-block{margin-top:16px}
/* 小标题用 --text-2 而不是 --dim：12px 的 dim 太像正文边角料，7 个分组就糊成一片 */
.a-block h4{margin:0 0 8px;color:var(--text-2);font-size:12px;font-weight:700;letter-spacing:.03em}
.a-item{border-radius:8px;background:var(--surface-2);padding:10px 12px}
.a-item + .a-item{margin-top:6px}
.a-item strong{display:block;color:var(--text-2);font-size:14px;font-weight:600;line-height:1.55}
.a-item p{margin:4px 0 0;color:var(--dim);font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.a-item strong + p{margin-top:4px}
.a-item small{display:block;margin-top:6px;color:var(--dim);font-size:12px}
/* 审核建议的对照组：只说「要改成什么」而不说「现在是什么」，更新类建议没法判断 */
.a-prev{display:flex;align-items:baseline;gap:8px;margin-top:8px;border-left:2px solid var(--line-strong);padding-left:9px;color:var(--dim);font-size:12px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}
.a-prev span{flex:none;color:var(--text-2);font-weight:600}
.a-rejected{margin-left:8px;color:#8f5c05;font-weight:500}
/* 依据留左边，处置结果和「采纳 / 忽略」靠右：一条建议的结论比它的出处更该被先看到 */
.a-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}
.a-foot small{margin-top:0}
.a-actions{margin-left:auto;flex:none;display:flex;align-items:center;gap:6px}
.a-actions .el-button + .el-button{margin-left:0}
.a-list{margin:0;padding-left:18px;color:var(--dim);font-size:14px;line-height:1.9}

/* ── 来源消息（默认收起） ──────────────────────────── */
.src-toggle{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:6px;background:none;padding:2px 0;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.src-toggle:hover{text-decoration:underline}
.src-caret{font-size:12px;transition:transform .16s var(--ease)}
.src-caret.open{transform:rotate(180deg)}
.src-count{color:var(--dim);font-weight:400}
.src-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.src-item{border-radius:8px;background:var(--surface-2);padding:11px 12px}
.src-top{display:flex;align-items:center;gap:7px}
.src-no{flex:none;color:var(--dim);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.src-top .pill{flex:none;padding:3px 7px}
.src-time{flex:none;color:var(--dim);font-size:12px}
/* 「查看原文」跟在时间后面靠右，不再独占一行 */
.src-more{margin-left:auto;flex:none;border:0;border-radius:6px;background:none;padding:2px 0;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.src-more:hover{text-decoration:underline}
.src-conv{margin:6px 0 0;overflow:hidden;color:var(--dim);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.src-preview{display:-webkit-box;overflow:hidden;margin:5px 0 0;color:var(--text-2);font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:3}

/* ── 详情页脚 ──────────────────────────────────────── */
.d-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;border-top:1px solid var(--surface-3);padding-top:14px}
.d-foot-note{min-width:0;margin:0;color:var(--dim);font-size:12px;line-height:1.7}
.d-action{flex:none}
.d-action .el-icon{margin-right:2px}

/* 列表保留选中上下文，正文留足行宽；窄屏选中后定位到阅读区。 */
.stat-band{padding:20px 22px;gap:16px 24px}
.sb-f{white-space:normal;line-height:1.7}
.archive-tip{display:flex;align-items:flex-start;gap:8px;margin-bottom:20px;color:var(--dim);font-size:12px;line-height:1.8}
.archive-tip .el-icon{flex:none;margin-top:3px}
.snap-grid{grid-template-columns:minmax(290px,360px) minmax(0,1fr);gap:20px}
.snap-grid > section{min-width:0}
.list-card{padding:14px 12px 8px}
.filters{gap:7px;flex-wrap:wrap}
.manual-chip{margin-left:0}
.snap-list{max-height:max(280px,calc(100dvh - 390px));gap:5px;margin-top:12px;overscroll-behavior:contain}
.snap-row{gap:9px;padding:14px 12px;border:1px solid transparent}
.snap-row.on{border-color:var(--brand-line);box-shadow:inset 3px 0 0 var(--brand)}
.snap-row-top{align-items:flex-start;flex-wrap:wrap}
.snap-row-tags{flex-wrap:wrap;gap:5px}
.snap-row-period{color:var(--text-2);font-size:12px;line-height:1.6}
.snap-row-meta{flex-wrap:wrap;line-height:1.7}
.snap-row:focus-visible,.reading-nav button:focus-visible,.src-toggle:focus-visible{outline:2px solid var(--brand);outline-offset:-2px}
.detail-panel{scroll-margin-top:90px}
.detail-card{padding:26px 28px 22px}
.d-head{align-items:flex-start;flex-wrap:wrap}
.d-head h2{font-size:21px;line-height:1.6;overflow-wrap:anywhere}
.detail-facts{display:grid;gap:7px;margin:16px 0 0;border-radius:10px;background:var(--surface-2);padding:14px 16px}
.detail-facts > div{display:flex;align-items:baseline;gap:14px;min-width:0}
.detail-facts dt{flex:none;width:48px;color:var(--dim);font-size:12px}
.detail-facts dd{margin:0;color:var(--text-2);font-size:12px;line-height:1.8;overflow-wrap:anywhere}
.reading-nav{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:18px 0 24px}
.reading-nav > span{color:var(--dim);font-size:12px;margin-right:4px}
.reading-nav button{display:inline-flex;align-items:center;gap:5px;min-height:30px;border:0;border-radius:6px;background:var(--surface-2);padding:4px 9px;color:var(--text-2);font:inherit;font-size:12px;cursor:pointer}
.reading-nav button:hover{background:var(--brand-soft);color:var(--brand-strong)}
.reading-nav small{color:var(--dim);font-size:12px;font-variant-numeric:tabular-nums}
.summary-label{margin:22px 0 0;color:var(--text-2);font-size:13px;font-weight:650}
.d-summary{margin-top:10px;font-size:15px;line-height:2}
.a-block,.d-sec{scroll-margin-top:90px}
.a-block + .a-block{margin-top:26px}
.a-block h4{font-size:14px;margin-bottom:12px;line-height:1.7}
.a-item{padding:14px 16px}
.a-item p{line-height:1.95;color:var(--text-2)}
.a-item + .a-item{margin-top:8px}
.a-foot,.src-top{flex-wrap:wrap}
.a-prev{flex-wrap:wrap;gap:4px 8px}
.src-toggle{flex-wrap:wrap;text-align:left;line-height:1.8}
.snapshot-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 16px}
.snapshot-empty > .el-icon{font-size:28px;color:var(--dim)}
.snapshot-empty strong{color:var(--text-2);font-size:14px;line-height:1.7}
.snapshot-empty p{margin:0;font-size:12px;line-height:1.9}
@media(max-width:980px){
  .snap-grid{grid-template-columns:minmax(0,1fr)}
  .snap-list{max-height:350px}
  .stat-band{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(max-width:640px){
  .stat-band{padding:16px;gap:18px}
  .detail-card{padding:20px 16px 16px}
  .detail-facts{padding:12px}
  .detail-facts > div{gap:10px}
  .d-head h2{font-size:18px}
  .d-foot{flex-direction:column;align-items:stretch}
  .d-action{width:100%}
  .src-time{flex:1 1 130px}
  .a-actions{margin-left:0;flex-wrap:wrap}
  .a-rejected{display:block;margin-left:0}
}
</style>
