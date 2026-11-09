<script setup lang="ts">
import { ArrowDown, Collection, Search, Delete } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { type Character } from "~/utils/mock-data";
import MemorySectionNavigation from "~/components/MemorySectionNavigation.vue";

type MemoryCategory = "FACT" | "PREFERENCE" | "RELATIONSHIP" | "COMMITMENT" | "GOAL" | "EVENT" | "SUMMARY" | "OTHER";
type MemoryDetail = {
  id: string;
  category: MemoryCategory;
  content: string;
  sourceMessageId: string | null;
  sourceSnapshotId: string | null;
  sourceMessage: {
    id: string;
    role: string;
    eventType: string;
    content: string;
    occurredAt: string;
    conversation: { id: string; title: string | null };
  } | null;
  sourceSnapshot: {
    id: string;
    summary: string;
    periodStart: string;
    periodEnd: string;
    version: number;
    status: string;
  } | null;
};
type MemoryRow = {
  id: string;
  category: string;
  content: string;
  status: string;
  scopeType: string;
  importance: number;
  validTo: string | null;
  createdAt: string;
  updatedAt: string;
};
type MemoryPage = {
  items: MemoryRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};
type MemoryStats = {
  memory: number;
  commitment: number;
  message: number;
  event: number;
  snapshot: number;
  memoryEvent: number;
};
type RecycleBinEntry = {
  id: string;
  category: MemoryCategory;
  content: string;
  statusBeforeTrash: "ACTIVE" | "SUPERSEDED" | "ARCHIVED" | "INVALIDATED" | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
const memoryCategoryOptions: Array<{ label: string; value: MemoryCategory }> = [
  { label: "事实记忆", value: "FACT" },
  { label: "偏好记忆", value: "PREFERENCE" },
  { label: "关系记忆", value: "RELATIONSHIP" },
  { label: "承诺与约定", value: "COMMITMENT" },
  { label: "目标记忆", value: "GOAL" },
  { label: "事件记忆", value: "EVENT" },
  { label: "记忆摘要", value: "SUMMARY" },
  { label: "其他", value: "OTHER" },
];

const characters = useCharacterList();
/** 角色列表与侧边栏共用同一份 SSR 数据，同 key 不会重复请求 */
await useCharacterListData();

/**
 * 这是一张菜单页而不是某个角色的二级页：当前角色由地址栏 ?c= 决定，
 * 没带参数时回退到上次选过的角色，再回退到列表第一个。
 * 选择和 /chat 共用一份（同一个 cookie），换页不会跳角色。
 */
const { id } = useCharacterSelection("/growth/memory/long-term");

const currentCharacter = ref<Character | null>(null);
const memoryDialogOpen = ref(false);
const memorySaving = ref(false);
const draftMemoryCategory = ref<MemoryCategory>("FACT");
const draftMemoryContent = ref("");
const draftMemoryScope = ref<"character" | "private">("character");
const memoryEditDialogOpen = ref(false);
const memoryEditLoading = ref(false);
const memoryEditSaving = ref(false);
const editingMemoryId = ref("");
const draftEditMemoryCategory = ref<MemoryCategory>("FACT");
const draftEditMemoryContent = ref("");
const editingMemorySource = ref<MemoryDetail["sourceMessage"]>(null);
const editingMemorySnapshot = ref<MemoryDetail["sourceSnapshot"]>(null);
const conversationDialogOpen = ref(false);
const conversationSaving = ref(false);
const draftConversationTitle = ref("");
const draftTranscript = ref("");

/**
 * 长期记忆列表：一页一条请求，分页 / 搜索 / 范围筛选都在服务端。
 *
 * 以前是 `/timeline?kinds=memory&limit=400` 拉 400 条，再在页面上切「加载更多」——
 * 翻不回去、也不知道总共多少条。现在这一页只拿当前页，页码由服务端给。
 */
const PAGE_SIZE = 10;
const memoryRows = ref<MemoryRow[]>([]);
const memoryTotal = ref(0);
const memoryPage = ref(1);
const memoryTotalPages = ref(1);
const memoryLoading = ref(false);
const query = ref("");
/** 范围筛选和原来下拉里的「记忆范围」同一档，不再从返回数据里反推选项 */
const scopeFilter = ref<"ALL" | "CHARACTER_GLOBAL" | "USER_PRIVATE" | "EXTERNAL_IDENTITY">("ALL");
const scopeOptions = [
  { label: "全部范围", value: "ALL" },
  { label: "长期记忆", value: "CHARACTER_GLOBAL" },
  { label: "私人记忆", value: "USER_PRIVATE" },
  { label: "外部身份", value: "EXTERNAL_IDENTITY" },
] as const;
/** 统计带用的几个计数（单独一个接口，不跟着每页列表来回传） */
const memoryStats = ref<MemoryStats>({ memory: 0, commitment: 0, message: 0, event: 0, snapshot: 0, memoryEvent: 0 });
const recycleBinOpen = ref(false);
const recycleBinLoading = ref(false);
const recycleBinEntries = ref<RecycleBinEntry[]>([]);
/** 回收站也会长：一次只取一页，跟长期记忆列表同一套参数。 */
const RECYCLE_PAGE_SIZE = 10;
const recycleBinPage = ref(1);
const recycleBinTotal = ref(0);
const recycleBinTotalPages = ref(1);
const recycleBinBusyIds = ref<string[]>([]);

/**
 * 群聊记录：群聊挂在角色全局记忆范围下，本来就算她的记忆，但长期记忆列表只取记忆条目，
 * 原始消息不进这条流，所以页面上看不到。
 * 这里按群号单独拉一份：左列是群，右边是她和群友的往来。
 */
type GroupChatGroup = {
  conversationId: string;
  groupId: string | null;
  label: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
  connectionName: string | null;
};
type GroupChatMessage = {
  id: string;
  role: string;
  content: string;
  occurredAt: string;
  author: string | null;
  member: string | null;
};
/**
 * 私聊记录：和群聊记录一样按账号分开，只是键是 QQ 号（`c:<QQ号>`）。
 * 私聊不进原文清理，这里可以一直往前翻；忆泡也从这份记录里整理「那天发生了什么」。
 */
type PrivateChatChat = {
  conversationId: string;
  qq: string | null;
  label: string;
  lastMessageAt: string | null;
  updatedAt: string;
  messageCount: number;
  connectionName: string | null;
};
type PrivateChatMessage = {
  id: string;
  role: string;
  content: string;
  occurredAt: string;
  author: string | null;
  isOwner: boolean;
};
type PrivateChatCursor = { before: string; beforeId: string } | null;
const groupChatOpen = ref(false);
const groupChatLoading = ref(false);
const groupChatError = ref("");
const groupChatGroups = ref<GroupChatGroup[]>([]);
const groupChatMessages = ref<GroupChatMessage[]>([]);
const groupChatSelectedId = ref("");
const selectedGroupChat = computed(() => groupChatGroups.value.find((group) => group.conversationId === groupChatSelectedId.value) ?? null);

const privateChatOpen = ref(false);
const privateChatLoading = ref(false);
const privateChatLoadingMore = ref(false);
const privateChatError = ref("");
const privateChatChats = ref<PrivateChatChat[]>([]);
const privateChatMessages = ref<PrivateChatMessage[]>([]);
const privateChatSelectedId = ref("");
const privateChatHasMore = ref(false);
const privateChatNextCursor = ref<PrivateChatCursor>(null);
const selectedPrivateChat = computed(() => privateChatChats.value.find((chat) => chat.conversationId === privateChatSelectedId.value) ?? null);

/** 统计带用的计数全部来自 `/memory-stats`，不拿「这一页的条数」当统计。 */
const recordedMessageCount = computed(() => memoryStats.value.message);
const recordedEventCount = computed(() => memoryStats.value.event);
const commitmentCount = computed(() => memoryStats.value.commitment);

/**
 * 角色档案还没到 / 读取失败时的占位。
 * 以前这里 spread 了 initialCharacters[0]，于是兜底会捎上示例角色的头像、色调和人设；
 * 现在只补页面上真正会读的字段。列表为空的情况交给模板里的 no-character 整块处理。
 */
const emptyCharacter = computed<Character>(() => ({
  id: id.value,
  name: "角色加载中",
  alias: "数据库档案",
  description: "",
  personality: "",
  avatar: "忆",
  avatarTone: "mint",
  status: "已暂停",
  channels: [],
  intervalDays: 8,
  pendingIntervalDays: null,
  nextSnapshot: "尚未计划",
  memoryCount: 0,
  latestSnapshot: "暂无总结",
}));
const character = computed<Character>(() => currentCharacter.value ?? emptyCharacter.value);

/**
 * 排序：最新在最前，直接沿用服务端给的顺序。
 * 记忆按 `updatedAt` 倒序、同时间按 id，翻页边界不会重复或漏条。
 */
const isSearching = computed(() => query.value.trim().length > 0);

const MEMORY_STATUS_TONE: Record<string, string> = {
  ACTIVE: "pill-green",
  SUPERSEDED: "pill-gray",
  ARCHIVED: "pill-gray",
  INVALIDATED: "pill-amber",
  TRASHED: "pill-gray",
};
function memoryStatusTone(status: string) {
  return MEMORY_STATUS_TONE[status] ?? "pill-gray";
}
function memoryCategoryLabel(category: string) {
  return memoryCategoryOptions.find((option) => option.value === category)?.label ?? category;
}
/** 列表里的时间是溯源信息，要能看出「哪天几点改的」 */
function formatMemoryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
/** 记忆范围的三档（和 MemoryScopeType 对齐，别把 EXTERNAL_IDENTITY 也念成「长期记忆」） */
const MEMORY_SCOPE_LABELS: Record<string, string> = {
  CHARACTER_GLOBAL: "长期记忆",
  USER_PRIVATE: "私人记忆",
  EXTERNAL_IDENTITY: "外部身份",
};
function memoryScopeLabel(scopeType: string) {
  return MEMORY_SCOPE_LABELS[scopeType] ?? "长期记忆";
}

let listRequestSeq = 0;
let statsRequestSeq = 0;

async function loadMemories(targetPage = memoryPage.value) {
  const requestedCharacterId = id.value;
  if (!requestedCharacterId) {
    memoryRows.value = [];
    memoryTotal.value = 0;
    memoryPage.value = 1;
    memoryTotalPages.value = 1;
    memoryLoading.value = false;
    return;
  }
  const seq = ++listRequestSeq;
  const keyword = query.value.trim();
  memoryLoading.value = true;
  try {
    const params = new URLSearchParams({ page: String(targetPage), pageSize: String(PAGE_SIZE) });
    if (keyword) params.set("q", keyword);
    if (scopeFilter.value !== "ALL") params.set("scope", scopeFilter.value);
    const result = await $fetch<MemoryPage>(
      `/api/characters/${encodeURIComponent(requestedCharacterId)}/memories?${params.toString()}`,
    );
    if (seq !== listRequestSeq || requestedCharacterId !== id.value || keyword !== query.value.trim()) return;
    memoryRows.value = result.items;
    memoryTotal.value = result.total;
    memoryPage.value = result.page;
    memoryTotalPages.value = result.totalPages;
  } catch {
    if (seq !== listRequestSeq || requestedCharacterId !== id.value) return;
    memoryRows.value = [];
    memoryTotal.value = 0;
    memoryTotalPages.value = 1;
    ElMessage.error("长期记忆读取失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === listRequestSeq) memoryLoading.value = false;
  }
}

async function loadStats(targetCharacterId = id.value) {
  const seq = ++statsRequestSeq;
  if (!targetCharacterId || targetCharacterId !== id.value) return;
  try {
    const result = await $fetch<MemoryStats>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/memory-stats`,
    );
    if (seq === statsRequestSeq && targetCharacterId === id.value) memoryStats.value = result;
  } catch {
    if (seq !== statsRequestSeq || targetCharacterId !== id.value) return;
    memoryStats.value = { memory: 0, commitment: 0, message: 0, event: 0, snapshot: 0, memoryEvent: 0 };
  }
}

/** 筛选是服务端参数：点一下就是一次新请求，不再本地过滤一整批。 */
function changePage(next: number) {
  if (next === memoryPage.value) return;
  memoryPage.value = next;
  void loadMemories(next);
}
function changeScope(next: string) {
  const value = next as typeof scopeFilter.value;
  if (scopeFilter.value === value) return;
  scopeFilter.value = value;
  memoryPage.value = 1;
  void loadMemories(1);
}
/** 防抖 300ms：找一条记忆不该每敲一个字打一次库 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    memoryPage.value = 1;
    void loadMemories(1);
  }, 300);
});

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  characterLoadSeq += 1;
  listRequestSeq += 1;
  statsRequestSeq += 1;
  recycleBinRequestSeq += 1;
  memoryDetailRequestSeq += 1;
  groupChatRequestSeq += 1;
  privateChatRequestSeq += 1;
});

let characterLoadSeq = 0;
/** 写操作（新增 / 编辑 / 归档 / 删除）之后统一刷新：当前页 + 统计带。 */
async function refreshMemoryPage() {
  await Promise.all([loadMemories(), loadStats()]);
}
async function loadCharacter() {
  const requestedCharacterId = id.value;
  const seq = ++characterLoadSeq;
  // 角色列表为空 / 还没解析出 id 时不要发请求，否则会打出无意义的 404 提示
  if (!requestedCharacterId) {
    currentCharacter.value = null;
    memoryRows.value = [];
    return;
  }
  try {
    const result = await $fetch<Character>(`/api/characters/${encodeURIComponent(requestedCharacterId)}`);
    if (seq !== characterLoadSeq || requestedCharacterId !== id.value) return;
    currentCharacter.value = result;
    await Promise.all([loadMemories(1), loadStats(requestedCharacterId)]);
  } catch {
    if (seq !== characterLoadSeq || requestedCharacterId !== id.value) return;
    currentCharacter.value = null;
    memoryRows.value = [];
    ElMessage.error("加载角色失败，请确认角色仍存在且本地数据库已初始化。");
  }
}

async function saveMemory() {
  if (memorySaving.value) return;
  if (!draftMemoryContent.value.trim()) {
    ElMessage.warning("请先填写记忆内容。");
    return;
  }

  memorySaving.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/memories`, {
      method: "POST",
      body: {
        category: draftMemoryCategory.value,
        content: draftMemoryContent.value.trim(),
        scope: draftMemoryScope.value,
      },
    });
    memoryDialogOpen.value = false;
    draftMemoryContent.value = "";
    draftMemoryCategory.value = "FACT";
    draftMemoryScope.value = "character";
    memoryPage.value = 1;
    await loadCharacter();
    ElMessage.success("长期记忆已保存到数据库，并加入列表。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "保存记忆失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    memorySaving.value = false;
  }
}

/**
 * 打开某条记忆的详情（内容 + 来源）。
 * 列表行的 id 就是记忆条目 id，详情走 `/api/memories/{id}`。
 */
let memoryDetailRequestSeq = 0;
async function openMemoryDetail(memoryId: string) {
  if (!memoryId) return;
  const seq = ++memoryDetailRequestSeq;
  const targetCharacterId = id.value;
  editingMemoryId.value = memoryId;
  editingMemorySource.value = null;
  editingMemorySnapshot.value = null;
  memoryEditDialogOpen.value = true;
  draftEditMemoryContent.value = "";
  draftEditMemoryCategory.value = "FACT";
  memoryEditLoading.value = true;
  try {
    const memory = await $fetch<MemoryDetail>(`/api/memories/${encodeURIComponent(memoryId)}`);
    if (seq !== memoryDetailRequestSeq || targetCharacterId !== id.value || editingMemoryId.value !== memoryId) return;
    draftEditMemoryCategory.value = memory.category;
    draftEditMemoryContent.value = memory.content;
    editingMemorySource.value = memory.sourceMessage;
    editingMemorySnapshot.value = memory.sourceSnapshot;
  } catch (error) {
    if (seq !== memoryDetailRequestSeq || targetCharacterId !== id.value || editingMemoryId.value !== memoryId) return;
    memoryEditDialogOpen.value = false;
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "读取长期记忆失败。";
    ElMessage.error(message);
  } finally {
    if (seq === memoryDetailRequestSeq) memoryEditLoading.value = false;
  }
}

function openMemoryEditor(row: MemoryRow) {
  void openMemoryDetail(row.id);
}

/** 来源区的说话人标签：消息按角色，平台事件单独标 */
function sourceSpeakerLabel(role: string, eventType: string) {
  if (eventType !== "message") return "平台事件";
  return role === "USER" ? "用户" : role === "ASSISTANT" ? "角色" : role === "TOOL" ? "工具" : "系统";
}
/** 来源区要精确到分钟：溯源时「哪天几点说的」是核心信息 */
function formatFullTime(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
function formatPeriod(start: string, end: string) {
  const fmt = (v: string) => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "?" : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(d);
  };
  return `${fmt(start)} → ${fmt(end)}`;
}

async function saveEditedMemory() {
  if (memoryEditSaving.value || memoryEditLoading.value || !editingMemoryId.value) return;
  if (!draftEditMemoryContent.value.trim()) {
    ElMessage.warning("记忆内容不能为空。");
    return;
  }

  const targetCharacterId = id.value;
  const targetMemoryId = editingMemoryId.value;
  const detailSeq = memoryDetailRequestSeq;
  memoryEditSaving.value = true;
  try {
    await $fetch(`/api/memories/${encodeURIComponent(targetMemoryId)}`, {
      method: "PATCH",
      body: {
        category: draftEditMemoryCategory.value,
        content: draftEditMemoryContent.value.trim(),
      },
    });
    if (targetCharacterId !== id.value || targetMemoryId !== editingMemoryId.value || detailSeq !== memoryDetailRequestSeq) return;
    memoryEditDialogOpen.value = false;
    await refreshMemoryPage();
    ElMessage.success("长期记忆已更新。已有阶段总结会保留生成时的历史内容。");
  } catch (error) {
    if (targetCharacterId !== id.value || targetMemoryId !== editingMemoryId.value || detailSeq !== memoryDetailRequestSeq) return;
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "更新长期记忆失败。";
    ElMessage.error(message);
  } finally {
    memoryEditSaving.value = false;
  }
}

async function setMemoryStatus(row: MemoryRow, status: "active" | "archived" | "invalidated") {
  if (!row.id) return;

  const actionLabel = status === "archived" ? "归档" : status === "invalidated" ? "标记失效" : "恢复为有效";
  try {
    await ElMessageBox.confirm(
      `确定将这条记忆“${actionLabel}”吗？此操作会保留历史记录，不会删除已有阶段总结。`,
      "维护长期记忆",
      { confirmButtonText: "确认", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  try {
    await $fetch(`/api/memories/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      body: { status },
    });
    await refreshMemoryPage();
    ElMessage.success(`记忆已${actionLabel}。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "更新记忆状态失败。";
    ElMessage.error(message);
  }
}

/** 行内「更多」菜单：状态类操作收进菜单，一行只留「编辑」+ 一个入口 */
async function runMemoryCommand(row: MemoryRow, command: string) {
  if (command === "trash") {
    await moveMemoryToTrash(row);
    return;
  }
  await setMemoryStatus(row, command as "active" | "archived" | "invalidated");
}

function memoryStatusText(status: string | null | undefined) {
  const labels: Record<string, string> = {
    ACTIVE: "有效", SUPERSEDED: "已被替代", ARCHIVED: "已归档", INVALIDATED: "已失效", TRASHED: "回收站",
  };
  return labels[status || "ACTIVE"] || "有效";
}

function formatRecycleDate(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

let recycleBinRequestSeq = 0;
async function loadRecycleBin(targetPage = recycleBinPage.value, targetCharacterId = id.value) {
  const seq = ++recycleBinRequestSeq;
  if (targetCharacterId !== id.value) return;
  recycleBinLoading.value = true;
  try {
    const result = await $fetch<{
      items: RecycleBinEntry[];
      total: number;
      page: number;
      pageSize: number;
      totalPages: number;
    }>(`/api/characters/${encodeURIComponent(targetCharacterId)}/memories/trash?page=${targetPage}&pageSize=${RECYCLE_PAGE_SIZE}`);
    if (seq !== recycleBinRequestSeq || targetCharacterId !== id.value) return;
    recycleBinEntries.value = result.items;
    recycleBinTotal.value = result.total;
    recycleBinPage.value = result.page;
    recycleBinTotalPages.value = result.totalPages;
  } catch {
    if (seq !== recycleBinRequestSeq || targetCharacterId !== id.value) return;
    recycleBinEntries.value = [];
    recycleBinTotal.value = 0;
    recycleBinTotalPages.value = 1;
    ElMessage.error("回收站加载失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === recycleBinRequestSeq) recycleBinLoading.value = false;
  }
}

/** 打开总回到第 1 页：停在上次翻到的那页会让人以为回收站里只剩这些。 */
async function openRecycleBin() {
  recycleBinOpen.value = true;
  recycleBinPage.value = 1;
  await loadRecycleBin(1);
}

function changeRecycleBinPage(next: number) {
  if (next === recycleBinPage.value) return;
  recycleBinPage.value = next;
  void loadRecycleBin(next);
}

async function moveMemoryToTrash(row: MemoryRow) {
  if (!row.id) return;
  try {
    await ElMessageBox.confirm(
      "这条记忆将从当前长期记忆集合中移出，但不会被立即永久删除。你可以在回收站中恢复。已有阶段总结会保留生成时的历史副本。",
      "移入记忆回收站",
      { confirmButtonText: "移入回收站", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  try {
    await $fetch(`/api/memories/${encodeURIComponent(row.id)}/trash`, { method: "POST" });
    await refreshMemoryPage();
    if (recycleBinOpen.value) await loadRecycleBin();
    ElMessage.success("记忆已移入回收站，可随时恢复。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "移入回收站失败。";
    ElMessage.error(message);
  }
}

async function restoreTrashedMemory(memory: RecycleBinEntry) {
  if (recycleBinBusyIds.value.includes(memory.id)) return;
  recycleBinBusyIds.value.push(memory.id);
  try {
    await $fetch(`/api/memories/${encodeURIComponent(memory.id)}/restore`, { method: "POST" });
    await Promise.all([loadRecycleBin(), refreshMemoryPage()]);
    ElMessage.success(`记忆已恢复为“${memoryStatusText(memory.statusBeforeTrash)}”状态。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "恢复记忆失败。";
    ElMessage.error(message);
  } finally {
    recycleBinBusyIds.value = recycleBinBusyIds.value.filter((id) => id !== memory.id);
  }
}

async function permanentlyDeleteMemory(memory: RecycleBinEntry) {
  if (recycleBinBusyIds.value.includes(memory.id)) return;
  try {
    await ElMessageBox.confirm(
      "这会永久删除当前长期记忆条目，且无法从回收站恢复。为保护历史追溯，已有阶段总结中的生成时副本和来源记录仍会保留；因此历史归档里仍可能出现这段内容。",
      "永久删除记忆条目",
      { confirmButtonText: "永久删除条目", cancelButtonText: "取消", type: "error" },
    );
  } catch { return; }
  recycleBinBusyIds.value.push(memory.id);
  try {
    const result = await $fetch<{ preservedSnapshotReferences: number }>(
      `/api/memories/${encodeURIComponent(memory.id)}`,
      { method: "DELETE" },
    );
    await Promise.all([loadRecycleBin(), refreshMemoryPage()]);
    ElMessage.success(`当前记忆条目已永久删除；保留了 ${result.preservedSnapshotReferences} 条历史来源记录，既有阶段总结未被改写。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "永久删除失败。";
    ElMessage.error(message);
  } finally {
    recycleBinBusyIds.value = recycleBinBusyIds.value.filter((id) => id !== memory.id);
  }
}

async function saveConversation() {
  if (conversationSaving.value) return;

  const lines = draftTranscript.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    ElMessage.warning("请至少输入一条对话消息。");
    return;
  }
  if (lines.length > 200) {
    ElMessage.warning("一次最多录入 200 条消息。");
    return;
  }

  let messages: Array<{ role: "USER" | "ASSISTANT"; content: string }>;
  try {
    messages = lines.map((line, index) => {
      const match = line.match(/^(用户|我|user|角色|助手|assistant|character)\s*[:：]\s*(.*)$/i);
      if (!match) {
        throw new Error(`第 ${index + 1} 行格式不正确，请使用“用户：内容”或“角色：内容”。`);
      }
      const content = match[2]?.trim() ?? "";
      if (!content) throw new Error(`第 ${index + 1} 行消息内容不能为空。`);
      const speaker = (match[1] ?? "").toLowerCase();
      const role = ["用户", "我", "user"].includes(speaker) ? "USER" : "ASSISTANT";
      return { role, content };
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "对话格式不正确。");
    return;
  }

  conversationSaving.value = true;
  try {
    const result = await $fetch<{ messageCount: number; timestampsEstimated: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/conversations/import`,
      {
        method: "POST",
        body: { title: draftConversationTitle.value.trim(), messages },
      },
    );
    conversationDialogOpen.value = false;
    draftConversationTitle.value = "";
    draftTranscript.value = "";
    await refreshMemoryPage();
    ElMessage.success(`已保存 ${result.messageCount} 条对话消息并刷新统计。${result.timestampsEstimated ? "消息时间按录入顺序估算。" : ""}`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "录入对话失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    conversationSaving.value = false;
  }
}

function formatSourceTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}
/**
 * 归档/整理转到后台跑完之后，把列表刷一遍。
 *
 * 面板轮询一直在跑（它读的是任务行），这里只是接住「某个任务刚结束」这个信号：
 * 归档可能更新长期记忆，完成后同步列表内容与统计。
 */
const { lastFinished } = useMemoryProgress();
watch(lastFinished, (job) => {
  if (!job || job.characterId !== id.value) return;
  void refreshMemoryPage();
});

/**
 * 群聊记录一次只取一个群的消息，切换群时重拉；不传 conversationId 时服务端回最近活跃的那个群。
 */
let groupChatRequestSeq = 0;
async function loadGroupChats(conversationId?: string) {
  const seq = ++groupChatRequestSeq;
  const targetCharacterId = id.value;
  if (!targetCharacterId) return;
  groupChatLoading.value = true;
  groupChatError.value = "";
  try {
    const result = await $fetch<{
      groups: GroupChatGroup[];
      selectedConversationId: string | null;
      messages: GroupChatMessage[];
    }>(`/api/characters/${encodeURIComponent(id.value)}/group-chats`, {
      query: conversationId ? { conversationId } : {},
    });
    if (seq !== groupChatRequestSeq || targetCharacterId !== id.value) return;
    groupChatGroups.value = result.groups;
    groupChatSelectedId.value = result.selectedConversationId ?? "";
    groupChatMessages.value = result.messages;
  } catch {
    if (seq !== groupChatRequestSeq || targetCharacterId !== id.value) return;
    groupChatGroups.value = [];
    groupChatMessages.value = [];
    groupChatSelectedId.value = "";
    groupChatError.value = "群聊记录读取失败，请检查本地开发服务器日志。";
  } finally {
    if (seq === groupChatRequestSeq) groupChatLoading.value = false;
  }
}

function openGroupChats() {
  groupChatOpen.value = true;
  void loadGroupChats();
}

function selectGroupChat(conversationId: string) {
  if (conversationId === groupChatSelectedId.value) return;
  void loadGroupChats(conversationId);
}

/** 发言人：她自己按角色名，群友优先昵称，昵称缺失退回群内代号。 */
function groupChatSpeaker(message: GroupChatMessage) {
  if (message.role === "ASSISTANT") return character.value.name;
  return message.author || message.member || "群友";
}

/**
 * 私聊记录一次只取一个 QQ 的消息；切换时重拉，不传就回最近活跃的那个。
 * 默认最近 200 条，往上用 `before` 继续翻 —— 私聊不进清理，记录能一直往前看。
 *
 * 请求序号防串台：切换 QQ 很快时，前一个请求的响应可能后到；不校验会把 A 的消息
 * 画到 B 的聊天窗里。
 */
let privateChatRequestSeq = 0;
async function loadPrivateChats(conversationId?: string) {
  if (!id.value) {
    privateChatRequestSeq += 1;
    return;
  }
  const seq = ++privateChatRequestSeq;
  privateChatLoading.value = true;
  privateChatLoadingMore.value = false;
  privateChatError.value = "";
  try {
    const result = await $fetch<{
      chats: PrivateChatChat[];
      selectedConversationId: string | null;
      messages: PrivateChatMessage[];
      hasMore: boolean;
      nextCursor: PrivateChatCursor;
    }>(`/api/characters/${encodeURIComponent(id.value)}/private-chats`, {
      query: conversationId ? { conversationId } : {},
    });
    if (seq !== privateChatRequestSeq) return;
    privateChatChats.value = result.chats;
    privateChatSelectedId.value = result.selectedConversationId ?? "";
    privateChatMessages.value = result.messages;
    privateChatHasMore.value = result.hasMore;
    privateChatNextCursor.value = result.nextCursor;
  } catch {
    if (seq !== privateChatRequestSeq) return;
    privateChatChats.value = [];
    privateChatMessages.value = [];
    privateChatSelectedId.value = "";
    privateChatHasMore.value = false;
    privateChatError.value = "私聊记录读取失败，请检查本地开发服务器日志。";
  } finally {
    if (seq === privateChatRequestSeq) privateChatLoading.value = false;
  }
}

function openPrivateChats() {
  privateChatOpen.value = true;
  void loadPrivateChats();
}

function selectPrivateChat(conversationId: string) {
  if (conversationId === privateChatSelectedId.value) return;
  void loadPrivateChats(conversationId);
}

/** 往前翻一页：把更早的消息补到列表头部，按 id 去重（分页边界可能重叠）。 */
async function loadOlderPrivateChat() {
  if (!id.value || !privateChatSelectedId.value || privateChatLoadingMore.value) return;
  const conversationId = privateChatSelectedId.value;
  const seq = privateChatRequestSeq;
  const oldest = privateChatMessages.value[0];
  if (!oldest) return;
  privateChatLoadingMore.value = true;
  try {
    const cursor = privateChatNextCursor.value ?? { before: oldest.occurredAt, beforeId: oldest.id };
    const result = await $fetch<{
      messages: PrivateChatMessage[];
      hasMore: boolean;
      nextCursor: PrivateChatCursor;
    }>(`/api/characters/${encodeURIComponent(id.value)}/private-chats`, {
      query: { conversationId, ...cursor },
    });
    // 切了人或者重新载入过：这一页已经不属于当前聊天窗，丢掉。
    if (seq !== privateChatRequestSeq || privateChatSelectedId.value !== conversationId) return;
    const seen = new Set(privateChatMessages.value.map((message) => message.id));
    privateChatMessages.value = [
      ...result.messages.filter((message) => !seen.has(message.id)),
      ...privateChatMessages.value,
    ];
    privateChatHasMore.value = result.hasMore;
    privateChatNextCursor.value = result.nextCursor;
  } catch {
    if (seq === privateChatRequestSeq && privateChatSelectedId.value === conversationId) {
      ElMessage.error("更早的私聊记录读取失败，请稍后重试。");
    }
  } finally {
    // 只有「还是这个聊天窗、也没有重新载入」时才清标记；切人时由新的载入负责重置。
    if (seq === privateChatRequestSeq && privateChatSelectedId.value === conversationId) {
      privateChatLoadingMore.value = false;
    }
  }
}

/** 私聊里的发言人：她自己按角色名，对方优先昵称，主人单独标出来。 */
function privateChatSpeaker(message: PrivateChatMessage) {
  if (message.role === "ASSISTANT") return character.value.name;
  const name = message.author || "对方";
  return message.isOwner ? `${name}（主人）` : name;
}

onMounted(() => void loadCharacter());
watch(id, () => {
  // Invalidate every in-flight read and discard data tied to the previous character.
  characterLoadSeq += 1;
  listRequestSeq += 1;
  statsRequestSeq += 1;
  recycleBinRequestSeq += 1;
  memoryDetailRequestSeq += 1;
  privateChatRequestSeq += 1;
  groupChatRequestSeq += 1;
  currentCharacter.value = null;
  memoryRows.value = [];
  memoryTotal.value = 0;
  memoryPage.value = 1;
  memoryTotalPages.value = 1;
  memoryStats.value = { memory: 0, commitment: 0, message: 0, event: 0, snapshot: 0, memoryEvent: 0 };
  query.value = "";
  scopeFilter.value = "ALL";
  recycleBinEntries.value = [];
  recycleBinPage.value = 1;
  recycleBinTotal.value = 0;
  recycleBinTotalPages.value = 1;
  recycleBinOpen.value = false;
  recycleBinLoading.value = false;
  memoryDialogOpen.value = false;
  memoryEditDialogOpen.value = false;
  memoryEditLoading.value = false;
  editingMemoryId.value = "";
  draftEditMemoryContent.value = "";
  if (searchTimer) clearTimeout(searchTimer);
  // 换角色时两个记录抽屉都必须关掉，否则会停在上一只鱼的记录上。
  groupChatOpen.value = false;
  groupChatGroups.value = [];
  groupChatMessages.value = [];
  groupChatSelectedId.value = "";
  privateChatOpen.value = false;
  privateChatChats.value = [];
  privateChatMessages.value = [];
  privateChatSelectedId.value = "";
  privateChatHasMore.value = false;
  privateChatNextCursor.value = null;
  privateChatLoadingMore.value = false;
  void loadCharacter();
});
</script>

<template>
  <div class="page-wrap">
    <MemorySectionNavigation active="long-term" />
    <PageHeader
      eyebrow="成长系统 / 记忆系统"
      description="查看、检索和整理她的长期记忆，并追溯每条记忆的来源。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          @click="conversationDialogOpen = true"
        >
          录入对话
        </button>
        <button
          type="button"
          class="btn"
          @click="memoryDialogOpen = true"
        >
          新增长期记忆
        </button>
      </template>
    </PageHeader>

    <template v-if="characters.length">
      <!-- 一组数字只讲一遍：原来 KPI 四格 + 右栏「记忆状态」卡是同一组数据。
         这里收成一条静音统计带，字号 18px，比记忆正文更弱。 -->
      <div class="card stat-band">
        <div class="sb-cell">
          <span class="sb-k">长期记忆</span>
          <span class="sb-v">{{ memoryStats.memory }}<small>条</small></span>
          <span class="sb-f">承诺与约定 {{ commitmentCount }} 项</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">已记录对话</span>
          <span class="sb-v">{{ recordedMessageCount }}<small>条</small></span>
          <span class="sb-f sb-f-wrap">
            平台事件 {{ recordedEventCount }} 项 ·
            <button
              type="button"
              class="ms-link"
              :disabled="!character.id"
              @click="openGroupChats"
            >群聊记录</button> ·
            <button
              type="button"
              class="ms-link"
              :disabled="!character.id"
              @click="openPrivateChats"
            >私聊记录</button>
          </span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">绑定渠道</span>
          <span class="sb-v">{{ character.channels.length || 0 }}<small>个</small></span>
          <span class="sb-f">{{ character.channels.length ? character.channels.join(" / ") : "尚未绑定渠道" }}</span>
        </div>
      </div>

      <div class="panel-grid panel-grid-growth">
        <section>
          <div class="sec-h">
            <h2>{{ isSearching ? "长期记忆检索" : "长期记忆" }}</h2>
            <span class="sub">{{ isSearching ? memoryTotal + " 条命中" : "共 " + memoryTotal + " 条" }}</span>
            <button
              v-if="isSearching"
              type="button"
              class="more"
              @click="query = ''"
            >
              清空搜索
            </button>
          </div>
          <div class="card tl-card">
            <div class="tl-tools">
              <el-input
                v-model="query"
                clearable
                placeholder="按内容搜索全部长期记忆……"
                class="tl-search"
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>
              <el-select
                :model-value="scopeFilter"
                class="tl-select"
                aria-label="按记忆范围筛选"
                @update:model-value="(value: string) => changeScope(value)"
              >
                <el-option
                  v-for="option in scopeOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <button
                type="button"
                class="tool-link"
                @click="openRecycleBin"
              >
                <el-icon><Delete /></el-icon>回收站
              </button>
            </div>

            <div class="timeline">
              <div
                v-if="memoryLoading && !memoryRows.length"
                class="tl-loading"
              >
                正在读取长期记忆……
              </div>
              <template v-else>
                <article
                  v-for="row in memoryRows"
                  :key="row.id"
                  class="timeline-item"
                >
                  <div
                    class="timeline-marker"
                    :class="memoryStatusTone(row.status)"
                  >
                    忆
                  </div>
                  <div class="timeline-content">
                    <div class="timeline-heading">
                      <span class="timeline-title">{{ memoryCategoryLabel(row.category) }}</span><span class="muted-note">{{ formatMemoryTime(row.updatedAt) }}</span>
                    </div>
                    <p class="timeline-summary">
                      {{ row.content }}
                    </p>
                    <div class="timeline-meta">
                      <span
                        class="pill"
                        :class="memoryStatusTone(row.status)"
                      >{{ memoryStatusText(row.status) }}</span>
                      <span>{{ memoryScopeLabel(row.scopeType) }}</span>
                      <span
                        v-if="row.status === 'ACTIVE'"
                        class="timeline-importance"
                      >重要度 {{ row.importance.toFixed(2) }}</span>
                    </div>
                    <!-- 行内只留「编辑 + 更多」：原来 4 个链接常显，其中 2 个破坏性，
                     每行都在喊。状态类操作收进菜单，默认不占视线。 -->
                    <div class="memory-actions">
                      <el-button
                        link
                        type="primary"
                        size="small"
                        @click="openMemoryEditor(row)"
                      >
                        编辑
                      </el-button>
                      <el-dropdown
                        trigger="click"
                        placement="bottom-end"
                        @command="runMemoryCommand(row, String($event))"
                      >
                        <button
                          type="button"
                          class="row-more"
                        >
                          更多<el-icon><ArrowDown /></el-icon>
                        </button>
                        <template #dropdown>
                          <el-dropdown-menu>
                            <template v-if="row.status === 'ACTIVE'">
                              <el-dropdown-item command="archived">
                                归档
                              </el-dropdown-item>
                              <el-dropdown-item command="invalidated">
                                标记失效
                              </el-dropdown-item>
                            </template>
                            <el-dropdown-item
                              v-else
                              command="active"
                            >
                              恢复有效
                            </el-dropdown-item>
                            <el-dropdown-item
                              command="trash"
                              divided
                              style="color:var(--red)"
                            >
                              移入回收站
                            </el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </div>
                  </div>
                </article>
                <div
                  v-if="!memoryRows.length"
                  class="card-empty"
                >
                  <el-icon><Collection /></el-icon>
                  <span>{{ isSearching ? "没有匹配的记忆" : "还没有长期记忆" }}</span>
                  <span>{{ isSearching ? "换个关键词，或清空搜索框回到完整列表" : "保存长期记忆之后，这里会按时间倒序出现对应条目" }}</span>
                </div>
                <PagerBar
                  v-if="memoryTotal > 0"
                  :page="memoryPage"
                  :total="memoryTotal"
                  :total-pages="memoryTotalPages"
                  :page-size="PAGE_SIZE"
                  flush
                  @update:page="changePage"
                />
              </template>
            </div>
          </div>
        </section>
      </div>
    </template>

    <el-dialog
      v-model="memoryDialogOpen"
      title="新增长期记忆"
      width="min(560px, 94vw)"
    >
      <el-form label-position="top">
        <el-form-item label="记忆分类">
          <el-select
            v-model="draftMemoryCategory"
            style="width:100%"
          >
            <el-option
              v-for="option in memoryCategoryOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="记忆范围">
          <el-radio-group v-model="draftMemoryScope">
            <el-radio-button value="character">
              角色全局
            </el-radio-button>
            <el-radio-button value="private">
              我的私人
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="记忆内容">
          <el-input
            v-model="draftMemoryContent"
            type="textarea"
            :rows="5"
            maxlength="12000"
            show-word-limit
            placeholder="例如：用户更喜欢简洁、直接的解释。"
          />
        </el-form-item>
        <div class="info-callout">
          <span>保存后会写入 PostgreSQL，并立即出现在角色记忆列表中。角色全局记忆在本角色所有对话中都可检索；私人记忆只在你自己和这个角色对话时使用，不会混入其他用户。</span>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="memoryDialogOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="memorySaving"
          @click="saveMemory"
        >
          保存记忆
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="memoryEditDialogOpen"
      title="编辑长期记忆"
      width="min(560px, 94vw)"
      :close-on-click-modal="!memoryEditSaving"
    >
      <div
        v-if="memoryEditLoading"
        class="empty-state"
      >
        正在加载记忆详情……
      </div>
      <el-form
        v-else
        label-position="top"
      >
        <el-form-item label="记忆分类">
          <el-select
            v-model="draftEditMemoryCategory"
            style="width:100%"
          >
            <el-option
              v-for="option in memoryCategoryOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="记忆内容">
          <el-input
            v-model="draftEditMemoryContent"
            type="textarea"
            :rows="5"
            maxlength="12000"
            show-word-limit
          />
        </el-form-item>
        <div class="info-callout">
          <span>修改只更新当前长期记忆。已经生成的阶段总结会保留生成时的历史副本。</span>
        </div>

        <!-- 溯源：这条记忆是从哪条消息 / 哪份总结来的。以前只取了数据没渲染，等于白取 -->
        <section class="mem-src">
          <h4 class="mem-src-h">
            她是怎么记住的
          </h4>
          <template v-if="editingMemorySource">
            <p class="mem-src-meta">
              {{ sourceSpeakerLabel(editingMemorySource.role, editingMemorySource.eventType) }}
              · {{ formatFullTime(editingMemorySource.occurredAt) }}
            </p>
            <!-- 会话名单独一行：自动建的会话标题里本身就带时间戳，和上面挤一行会出现两个日期 -->
            <p class="mem-src-conv">
              {{ editingMemorySource.conversation.title || "未命名会话" }}
            </p>
            <p class="mem-src-body">
              {{ editingMemorySource.content }}
            </p>
          </template>
          <template v-else-if="editingMemorySnapshot">
            <p class="mem-src-meta">
              第 {{ editingMemorySnapshot.version }} 版阶段总结 ·
              {{ formatPeriod(editingMemorySnapshot.periodStart, editingMemorySnapshot.periodEnd) }}
            </p>
            <p class="mem-src-body">
              {{ editingMemorySnapshot.summary }}
            </p>
          </template>
          <p
            v-else
            class="mem-src-empty"
          >
            这条记忆没有来源记录 —— 可能是手动录入，或产生于溯源字段上线之前。
          </p>
        </section>
      </el-form>
      <template #footer>
        <el-button @click="memoryEditDialogOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="memoryEditSaving"
          :disabled="memoryEditLoading"
          @click="saveEditedMemory"
        >
          保存修改
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="conversationDialogOpen"
      title="录入对话记录"
      width="min(640px, 94vw)"
    >
      <el-form label-position="top">
        <el-form-item label="会话标题（可选）">
          <el-input
            v-model="draftConversationTitle"
            maxlength="255"
            placeholder="例如：第一次讨论角色设定"
          />
        </el-form-item>
        <el-form-item label="对话内容">
          <el-input
            v-model="draftTranscript"
            type="textarea"
            :rows="10"
            maxlength="24000"
            show-word-limit
            placeholder="用户：你好&#10;角色：你好呀！&#10;用户：下一句"
          />
        </el-form-item>
        <div class="info-callout">
          <span>每行一条消息，按发生顺序填写。支持“用户：”“我：”“user:”“角色：”“助手：”“assistant:”。纯文本录入没有原始时间戳，系统会按行顺序设置导入时间。</span>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="conversationDialogOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="conversationSaving"
          @click="saveConversation"
        >
          保存对话
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="recycleBinOpen"
      title="记忆回收站"
      width="min(760px, 94vw)"
      :close-on-click-modal="false"
    >
      <p class="recycle-intro">
        已移出当前记忆集合的条目。恢复会回到移入回收站前的状态；永久删除仅移除当前长期记忆条目，历史归档仍保留生成时的副本。
      </p>
      <div
        v-if="recycleBinLoading"
        class="empty-state"
      >
        正在读取回收站……
      </div>
      <div
        v-else-if="!recycleBinEntries.length"
        class="empty-state"
      >
        回收站是空的。移入回收站的长期记忆会显示在这里。
      </div>
      <div
        v-else
        class="recycle-list"
      >
        <article
          v-for="memory in recycleBinEntries"
          :key="memory.id"
          class="recycle-card"
        >
          <div class="recycle-card-head">
            <div>
              <strong class="recycle-card-title">{{ memoryCategoryOptions.find((option) => option.value === memory.category)?.label || "长期记忆" }}</strong>
              <div class="recycle-card-meta">
                移入前状态：{{ memoryStatusText(memory.statusBeforeTrash) }} · {{ formatRecycleDate(memory.deletedAt) }}
              </div>
            </div>
            <span class="pill pill-gray">回收站</span>
          </div>
          <p class="recycle-card-body">
            {{ memory.content }}
          </p>
          <div class="recycle-card-actions">
            <el-button
              size="small"
              :loading="recycleBinBusyIds.includes(memory.id)"
              @click="restoreTrashedMemory(memory)"
            >
              恢复
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :loading="recycleBinBusyIds.includes(memory.id)"
              @click="permanentlyDeleteMemory(memory)"
            >
              永久删除条目
            </el-button>
          </div>
        </article>
      </div>
      <!-- 翻页条留在滚动区外面：列表滚到哪儿，「上一页 / 下一页」都还在原位 -->
      <PagerBar
        v-if="!recycleBinLoading && recycleBinTotal > 0"
        :page="recycleBinPage"
        :total="recycleBinTotal"
        :total-pages="recycleBinTotalPages"
        :page-size="RECYCLE_PAGE_SIZE"
        @update:page="changeRecycleBinPage"
      />
      <template #footer>
        <el-button @click="recycleBinOpen = false">
          关闭
        </el-button>
      </template>
    </el-dialog>

    <!-- 群聊记录：群聊也算她的记忆，但不进长期记忆列表，单独一个抽屉按群号翻 -->
    <el-drawer
      v-model="groupChatOpen"
      title="群聊记录"
      size="min(760px, 100vw)"
    >
      <p class="gc-hint">
        群聊属于角色全局记忆，会参与周期总结。这里按群号分开看：左边选群，右边是她和群友的往来。
      </p>
      <div
        v-if="groupChatError"
        class="gc-empty"
      >
        {{ groupChatError }}
      </div>
      <div
        v-else-if="!groupChatLoading && !groupChatGroups.length"
        class="gc-empty"
      >
        还没有群聊记录。绑定 QQ 小号、群聊过闸门之后，这里才会出现她跟别人的往来。
      </div>
      <div
        v-else
        class="gc-layout"
      >
        <aside class="gc-list">
          <button
            v-for="group in groupChatGroups"
            :key="group.conversationId"
            type="button"
            class="gc-item"
            :class="{ on: group.conversationId === groupChatSelectedId }"
            @click="selectGroupChat(group.conversationId)"
          >
            <span class="gc-item-title">{{ group.label }}</span>
            <span class="gc-item-meta">{{ group.messageCount }} 条 · {{ formatSourceTime(group.lastMessageAt || group.updatedAt) }}</span>
          </button>
        </aside>
        <section
          v-loading="groupChatLoading"
          class="gc-thread"
        >
          <header class="gc-thread-h">
            <strong>{{ selectedGroupChat?.label || "群聊" }}</strong>
            <span class="gc-thread-sub">{{ selectedGroupChat?.connectionName || "QQ 渠道" }} · 最近 {{ groupChatMessages.length }} 条</span>
          </header>
          <div class="gc-msgs">
            <article
              v-for="message in groupChatMessages"
              :key="message.id"
              class="gc-msg"
              :class="{ self: message.role === 'ASSISTANT' }"
            >
              <div class="gc-who">
                <span class="gc-name">{{ groupChatSpeaker(message) }}</span>
                <span class="gc-time">{{ formatSourceTime(message.occurredAt) }}</span>
              </div>
              <p class="gc-text">
                {{ message.content }}
              </p>
            </article>
          </div>
        </section>
      </div>
    </el-drawer>

    <!-- 私聊记录：按 QQ 号分开；私聊不进原文清理，分页一直往前翻 -->
    <el-drawer
      v-model="privateChatOpen"
      title="私聊记录"
      size="min(760px, 100vw)"
    >
      <p class="gc-hint">
        私聊基本全部保留（不进原文清理），也是忆泡的取材来源之一。这里按 QQ 号分开看：左边选人，右边是往来原文。
      </p>
      <div
        v-if="privateChatError"
        class="gc-empty"
      >
        {{ privateChatError }}
      </div>
      <div
        v-else-if="!privateChatLoading && !privateChatChats.length"
        class="gc-empty"
      >
        还没有私聊记录。绑定 QQ 小号、有人私聊她之后，这里会出现往来。
      </div>
      <div
        v-else
        class="gc-layout"
      >
        <aside class="gc-list">
          <button
            v-for="chat in privateChatChats"
            :key="chat.conversationId"
            type="button"
            class="gc-item"
            :class="{ on: chat.conversationId === privateChatSelectedId }"
            @click="selectPrivateChat(chat.conversationId)"
          >
            <span class="gc-item-title">{{ chat.label }}</span>
            <span class="gc-item-meta">{{ chat.messageCount }} 条 · {{ formatSourceTime(chat.lastMessageAt || chat.updatedAt) }}</span>
          </button>
        </aside>
        <section
          v-loading="privateChatLoading"
          class="gc-thread"
        >
          <header class="gc-thread-h">
            <strong>{{ selectedPrivateChat?.label || "私聊" }}</strong>
            <span class="gc-thread-sub">{{ selectedPrivateChat?.connectionName || "QQ 渠道" }} · 共 {{ selectedPrivateChat?.messageCount || 0 }} 条 · 已载入 {{ privateChatMessages.length }} 条</span>
          </header>
          <button
            v-if="privateChatHasMore"
            type="button"
            class="load-more"
            :disabled="privateChatLoadingMore"
            @click="loadOlderPrivateChat"
          >
            {{ privateChatLoadingMore ? "加载中…" : "加载更早的消息" }}
          </button>
          <div class="gc-msgs">
            <article
              v-for="message in privateChatMessages"
              :key="message.id"
              class="gc-msg"
              :class="{ self: message.role === 'ASSISTANT' }"
            >
              <div class="gc-who">
                <span class="gc-name">{{ privateChatSpeaker(message) }}</span>
                <span class="gc-time">{{ formatSourceTime(message.occurredAt) }}</span>
              </div>
              <p class="gc-text">
                {{ message.content }}
              </p>
            </article>
          </div>
        </section>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览页 / 角色管理页 A 套「色块平铺」：一张白台面，零描边零阴影，
   层次只靠明度差 + 间距，颜色只给状态。
   L0 画布(--bg) → L1 白砖 #fff → L2 卡内分节靠留白 → L3 状态药丸上色
   选择器带 scoped 属性后是 (0,2,0)，压过 main.css 里 .card / .pill 的
   (0,1,0)，所以不必写 .page-wrap 前缀，也不动全局样式。
   ══════════════════════════════════════════════════════════════ */

/* 白砖：去掉 1px #e6e9ef 描边 + 0 1px 2px 阴影 */
.card{border:0;border-radius:10px;box-shadow:none}

/* 「调整」：挂在归档周期格里的行内按钮，跟 sb-f 同字号，不抢视觉（统计带本身在 main.css 的 .stat-band） */
.ms-link{padding:0;border:0;background:none;color:var(--brand-strong);font:inherit;font-weight:600;cursor:pointer}
.ms-link:hover{text-decoration:underline}
.ms-link:disabled{color:var(--faint);cursor:not-allowed}

/* 「已记录对话」的链接多了一个：小屏不能再 nowrap，否则「私聊记录」会被整段省略 */
.sb-f-wrap{overflow:visible;white-space:normal;text-overflow:clip;line-height:1.9}

/* 长期记忆列表布局。 */
.panel-grid{margin-top:0}

/* ── 列表卡片 ───────────────────────────────────────── */
.tl-card{padding:14px 18px 10px}
.tl-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tl-search{min-width:170px;flex:1}
.tl-select{width:132px;flex:none}
/* 回收站是「管这批记忆」的工具，排在搜索/范围后面，不做成第三个控件的样子 */
.tool-link{display:inline-flex;flex:none;align-items:center;gap:4px;height:32px;padding:0 6px;border:0;background:none;color:var(--dim);font-size:12px;font-weight:600;cursor:pointer}
.tool-link:hover{color:var(--brand-strong)}
.tool-link .el-icon{font-size:14px}
.tl-loading{padding:34px 0;color:var(--dim);font-size:12px;text-align:center}
.timeline-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}
/* 时间是信息，不能落在 --faint(2.55:1) 上 */
.timeline-heading .muted-note{color:var(--dim)}
/* 去横线：行间 2px 缝 + hover 铺底，跟总览页同一套分块语言 */
.timeline{gap:2px}
.timeline-item{margin:0 -12px;border-bottom:0;border-radius:8px;padding:12px;transition:background .14s var(--ease)}
.timeline-item:hover{background:var(--surface-2)}
/* 记忆正文是全页要读的东西，12px 太紧了；跟标题同为 14px，靠字重和明度分层 */
.timeline-summary{font-size:14px;line-height:1.7}
.timeline-meta{color:var(--dim)}
/* 重要度：只在生效中的记忆上出现。排序改动看不见就没法核对，所以把它摆出来。 */
.timeline-importance{color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums}

.load-more{width:100%;margin-top:4px;border:0;border-radius:8px;background:none;padding:12px 0;color:var(--dim);font-size:12px;font-weight:600;cursor:pointer;transition:background .14s var(--ease),color .14s var(--ease)}
.load-more:hover{background:var(--surface-2);color:var(--brand-strong)}
/* 记忆溯源：弹窗底部的「她是怎么记住的」 */
.mem-src{margin-top:14px;border-top:1px solid var(--surface-3);padding-top:12px}
.mem-src-h{margin:0 0 6px;color:var(--text-2);font-size:12px;font-weight:700}
.mem-src-meta{margin:0;color:var(--dim);font-size:12px;line-height:1.7}
.mem-src-conv{overflow:hidden;margin:1px 0 0;color:var(--dim);font-size:12px;line-height:1.6;text-overflow:ellipsis;white-space:nowrap}
.mem-src-body{margin:6px 0 0;max-height:180px;overflow:auto;border-radius:8px;background:var(--surface-2);padding:9px 11px;color:var(--text-2);font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.mem-src-empty{margin:0;color:var(--dim);font-size:12px;line-height:1.7}

/* 行内动作：只剩「编辑」+「更多」两个入口 */
.memory-actions{display:flex;align-items:center;gap:10px;margin-top:4px}
.memory-actions .el-button{margin-left:0;font-size:12px}
.memory-actions .el-button + .el-button{margin-left:0}
/* Element 默认 primary 是 #d94a76=4.05:1，换成本项目的深一档（5.25:1） */
.memory-actions :deep(.el-button.is-link.el-button--primary){color:var(--brand-strong)}
.memory-actions :deep(.el-button.is-link.el-button--primary:hover){color:#a8305a}
.row-more{display:inline-flex;align-items:center;gap:2px;border:0;border-radius:var(--radius-xs);background:none;padding:0 4px;color:var(--text-2);font-size:12px;font-weight:400;cursor:pointer;transition:color .14s var(--ease)}
.row-more:hover{color:var(--text)}
.row-more .el-icon{font-size:12px}

/* 记录类型标记：单字 + 软底深字（原来借用 pill-* 的底色，这里补齐前景色） */
.timeline-marker{font-size:12px;font-weight:700}
.timeline-marker.pill-green{background:var(--green-soft);color:#0b7a54}
.timeline-marker.pill-purple{background:var(--brand-soft);color:var(--brand-strong)}
.timeline-marker.pill-blue{background:var(--blue-soft);color:#3d4dab}
.timeline-marker.pill-amber{background:var(--amber-soft);color:#8f5c05}
.timeline-marker.pill-gray{background:var(--surface-3);color:var(--text-2)}

/* ── 回收站弹窗 ─────────────────────────────────────── */
.recycle-intro{margin:0 0 14px;color:var(--dim);font-size:12px;line-height:1.8}
.recycle-list{display:flex;flex-direction:column;gap:10px;max-height:55vh;overflow:auto}
.recycle-card{padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.recycle-card-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}
.recycle-card-title{color:var(--text-2);font-size:14px;font-weight:700}
.recycle-card-meta{margin-top:5px;color:var(--dim);font-size:12px}
.recycle-card-body{margin:10px 0;color:var(--dim);font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.recycle-card-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}

/* ── 群聊记录抽屉 ───────────────────────────────────── */
/* 群号是这一屏的「主键」，用等宽字把它和正文区分开，别让它看起来像一句话 */
.gc-hint{margin:0 0 12px;color:var(--dim);font-size:12px;line-height:1.8}
.gc-empty{border-radius:10px;background:var(--surface-2);padding:20px 16px;color:var(--dim);font-size:13px;line-height:1.8;text-align:center}
.gc-layout{display:grid;grid-template-columns:210px minmax(0,1fr);gap:14px;min-height:420px}
.gc-list{display:flex;flex-direction:column;gap:2px;align-self:start;max-height:70vh;overflow:auto}
.gc-item{display:flex;flex-direction:column;gap:3px;border:0;border-radius:8px;background:none;padding:9px 11px;text-align:left;cursor:pointer;transition:background .14s var(--ease)}
.gc-item:hover{background:var(--surface-2)}
.gc-item.on{background:var(--brand-soft)}
.gc-item-title{color:var(--text-2);font-size:13px;font-weight:600}
.gc-item.on .gc-item-title{color:var(--brand-strong)}
.gc-item-meta{color:var(--dim);font-size:12px}
.gc-thread{display:flex;flex-direction:column;min-width:0;border-radius:10px;background:var(--surface-2);padding:12px 14px}
.gc-thread-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px;margin-bottom:10px;border-bottom:1px solid var(--surface-3);padding-bottom:9px}
.gc-thread-h strong{color:var(--text);font-size:14px;font-weight:600}
.gc-thread-sub{color:var(--dim);font-size:12px}
.gc-msgs{display:flex;flex-direction:column;gap:8px;max-height:64vh;overflow:auto;padding-right:2px}
.gc-msg{margin:0;border-radius:8px;background:var(--surface);padding:9px 11px}
/* 她自己说的话靠右、换底色：一眼能分出「谁在说」 */
.gc-msg.self{background:var(--brand-soft)}
.gc-who{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px}
.gc-name{color:var(--text-2);font-size:12px;font-weight:600}
.gc-msg.self .gc-name{color:var(--brand-strong)}
.gc-time{color:var(--dim);font-size:12px}
.gc-text{margin:0;color:var(--text-2);font-size:13px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}

@media(max-width:640px){
  .tl-card{padding:12px 14px 8px}
  .tl-select{width:100%}
  .stat-band{padding:14px}
  .gc-layout{grid-template-columns:1fr;min-height:0}
  .gc-list{flex-direction:row;overflow-x:auto;max-height:none}
  .gc-item{flex:0 0 150px}
  .gc-msgs{max-height:52vh}
}

/* 成长系统的长期记忆视图不显示阶段总结侧栏，主列表使用完整宽度。 */
.panel-grid-growth { grid-template-columns: minmax(0, 1fr); }
</style>
