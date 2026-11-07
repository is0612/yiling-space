<script setup lang="ts">
import { ArrowRight, ArrowDown, Collection, Files, Search, MagicStick, Delete, Loading } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { type Character, type Snapshot, type TimelineEntry, type TimelineType } from "~/utils/mock-data";
import MemorySectionNavigation from "~/components/MemorySectionNavigation.vue";

const props = defineProps<{ growthMode?: boolean }>();
const isGrowthMode = computed(() => props.growthMode === true);

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
const { id } = useCharacterSelection(isGrowthMode.value ? "/growth/memory" : "/memory");

const currentCharacter = ref<Character | null>(null);
const snapshots = ref<Snapshot[]>([]);
const snapshotCreating = ref(false);
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
const timelineEntries = ref<TimelineEntry[]>([]);
/** 服务端直接数的全量条数（不受「只载最近 N 条」影响） */
const timelineCounts = ref({ message: 0, event: 0, memory: 0, snapshot: 0, memoryEvent: 0 });
/** 每天的整理进度（按角色时区）：日期头显示「上次整理几点」、今天是否还在长。 */
type TimelineDay = { dayKey: string; state: "DRAFT" | "FINAL"; eventCount: number; extractedAt: string | null };
const timelineDays = ref<Record<string, TimelineDay>>({});
/** 角色时区里的「今天」，由服务端给，前端不自己算。 */
const todayKey = ref("");
const timelineLoading = ref(false);
const recycleBinOpen = ref(false);
const recycleBinLoading = ref(false);
const recycleBinEntries = ref<RecycleBinEntry[]>([]);
const recycleBinBusyIds = ref<string[]>([]);

/**
 * 群聊记录：群聊挂在角色全局记忆范围下，本来就算她的记忆，但时间线只取记忆与总结
 * （`kinds=memory,snapshot`），原始消息不进这条流，所以页面上看不到。
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
/**
 * 统计带用服务端的全量计数，不用「已载入条数」——
 * 这条流默认只载记忆和总结（不含消息），拿载入数当统计会显示成 0。
 */
const recordedMessageCount = computed(() => timelineCounts.value.message);
const recordedEventCount = computed(() => timelineCounts.value.event);
const commitmentCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "memory" && entry.title === "承诺与约定" && entry.tag === "长期记忆").length);
/** 记忆 + 忆泡 + 总结的总量 vs 实际载入量：差值为「没载进来的更早记录」 */
const loadedTotal = computed(() => timelineEntries.value.length);
const knownTotal = computed(() => isGrowthMode.value
  ? timelineCounts.value.memory
  : timelineCounts.value.memory + timelineCounts.value.snapshot + timelineCounts.value.memoryEvent);
const truncated = computed(() => knownTotal.value > loadedTotal.value);
/**
 * 来源筛选，而不是「渠道」筛选：服务端 timeline 的 channel 里混了两个维度 ——
 * 真实渠道（连接名 / 本地会话）和长期记忆的范围（长期记忆 / 私人记忆）。
 * 挤在一个没有标签的下拉里，选「长期记忆」实际筛出的是「所有非私人记忆条目」。
 * 这里按维度分组；阶段总结的「全部渠道」是跨渠道汇总，仍按通配处理。
 */
const SOURCE_ALL = "全部来源";
const SOURCE_WILDCARD = "全部渠道";
const MEMORY_SCOPE_SOURCES = new Set(["长期记忆", "私人记忆"]);
const realChannelOptions = computed(() => [...new Set(timelineEntries.value
  .map((entry) => entry.channel)
  .filter((channel) => channel !== SOURCE_WILDCARD && !MEMORY_SCOPE_SOURCES.has(channel)))].sort());
const memoryScopeOptions = computed(() => [...new Set(timelineEntries.value
  .map((entry) => entry.channel)
  .filter((channel) => MEMORY_SCOPE_SOURCES.has(channel)))].sort());
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
/** 待生效的归档周期：接口没返 / 旧缓存里是 undefined 都按「没有改动」处理。 */
const pendingIntervalDays = computed(() => character.value.pendingIntervalDays ?? null);
const activeFilter = ref(isGrowthMode.value ? "长期记忆" : "全部记录");
const visibleFilterOptions = computed(() => isGrowthMode.value
  ? filterOptions.filter((option) => option.type === "memory")
  : filterOptions);
const channelFilter = ref(SOURCE_ALL);
const query = ref("");
/**
 * 这页是「记忆中枢」，不是聊天记录查看器：主列表默认只放长期记忆和阶段总结。
 * 对话原文走「群聊记录 / 私聊记录」弹窗，否则聊天一多就会把记忆挤出取数窗口。
 */
const filterOptions = [
  { label: "全部记录", type: undefined },
  { label: "长期记忆", type: "memory" as TimelineType },
  { label: "忆泡", type: "memoryEvent" as TimelineType },
  { label: "阶段总结", type: "snapshot" as TimelineType },
];
/**
 * 排序：最新在最前，直接沿用服务端给的顺序。
 *
 * `/timeline` 已经按真实时间戳倒序取回（忆泡看 occurredAt、记忆看 updatedAt、
 * 总结看 createdAt），跨天与同一天都是准确的。这里只筛选、不重排：
 * 以前默认「同一天里忆泡整类排在记忆前面」，于是 09:00 的忆泡压在 23:00 刚更新过的
 * 记忆上方，看着就不像时间线；而 `time` 是给人看的字符串（记忆 `2026/11/05 14:20`、
 * 总结 `2026-11-05`），拿它比大小等于按格式排、不是按时间排。
 */
const filteredEntries = computed(() => {
  const type = filterOptions.find((option) => option.label === activeFilter.value)?.type;
  return timelineEntries.value.filter((entry) => {
    const typeMatches = !type || entry.type === type;
    const sourceMatches = channelFilter.value === SOURCE_ALL
      || entry.channel === SOURCE_WILDCARD
      || entry.channel === channelFilter.value;
    const textMatches = !query.value || `${entry.title} ${entry.summary} ${entry.source}`.toLowerCase().includes(query.value.toLowerCase());
    return typeMatches && sourceMatches && textMatches;
  });
});

/** 时间线一屏只放一页，避免 20+ 条把页面拉成 2700px 的长卷 */
const PAGE_SIZE = 10;
const visibleCount = ref(PAGE_SIZE);
const pagedEntries = computed(() => filteredEntries.value.slice(0, visibleCount.value));
watch([activeFilter, channelFilter, query], () => {
  visibleCount.value = PAGE_SIZE;
});

/**
 * 按天分组：条目按时间倒序，「同一天」一定是连续的，所以只需要判断这一天变了没有。
 * 日期直接用服务端渲染好的 time 前缀（已经按角色时区格式化），前端不再重算时区。
 */
function dayKeyOf(entry: TimelineEntry) {
  // 记忆条目用 zh-CN（2026/10/29），快照用 en-CA（2026-10-29）—— 不归一化会把同一天拆成两组。
  return entry.time.slice(0, 10).replace(/\//g, "-");
}
const dayStats = computed(() => {
  const map = new Map<string, { count: number; draft: number }>();
  // 统计用「筛选后的全部条目」，不是当前这一页：一天被分页截断时，
  // 日期头仍应显示这一天真实有几条，而不是本页看到的几条。
  for (const entry of filteredEntries.value) {
    const key = dayKeyOf(entry);
    const row = map.get(key) ?? { count: 0, draft: 0 };
    row.count += 1;
    if (entry.type === "memoryEvent" && entry.tag === "还在记") row.draft += 1;
    map.set(key, row);
  }
  return map;
});
function isDayStart(index: number) {
  if (index === 0) return true;
  const current = pagedEntries.value[index];
  const previous = pagedEntries.value[index - 1];
  return Boolean(current && previous) && dayKeyOf(current!) !== dayKeyOf(previous!);
}
/** 日期键加减天数（跨月/跨年都按 UTC 日历算，不碰时区）。 */
function shiftDayKey(key: string, delta: number) {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function dayLabelAt(index: number) {
  const entry = pagedEntries.value[index];
  if (!entry) return "";
  const key = dayKeyOf(entry);
  const stats = dayStats.value.get(key);
  const suffix = stats ? ` · ${stats.count} 条` : "";
  // 「今天 / 昨天」按服务端给的角色时区算，前端不自己猜。
  if (todayKey.value && key === todayKey.value) return `今天${suffix}`;
  if (todayKey.value && key === shiftDayKey(todayKey.value, -1)) return `昨天${suffix}`;
  const [year, month, day] = key.split("-");
  const label = year && month && day
    ? `${year} 年 ${Number(month)} 月 ${Number(day)} 日`
    : key;
  return label + suffix;
}
function dayHasDraftAt(index: number) {
  const entry = pagedEntries.value[index];
  if (!entry) return false;
  return (dayStats.value.get(dayKeyOf(entry))?.draft ?? 0) > 0;
}
/** 最近的整理时刻：让人知道「今天这几条」有多新。 */
function formatClock(iso: string | null | undefined) {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const hour = String(at.getHours()).padStart(2, "0");
  const minute = String(at.getMinutes()).padStart(2, "0");
  return `${hour}:${minute}`;
}
function dayExtractedAt(index: number) {
  const entry = pagedEntries.value[index];
  if (!entry) return "";
  const clock = formatClock(timelineDays.value[dayKeyOf(entry)]?.extractedAt);
  return clock ? `上次整理 ${clock}` : "";
}

/**
 * 今天还没有任何条目时的占位行。
 *
 * 日期头是由条目驱动的：今天还没整理出忆泡，列表里就完全看不到「今天」，
 * 用户会以为页面坏了。这里补一行「今天 · 0 条 · 还没整理」，并指向右上角那个按钮。
 * 只在「全部记录 / 忆泡」两个筛选下出现 —— 看「长期记忆」时提忆泡是噪声。
 */
const showTodayPlaceholder = computed(() => {
  if (isGrowthMode.value || !todayKey.value) return false;
  if (activeFilter.value !== "全部记录" && activeFilter.value !== "忆泡") return false;
  return !filteredEntries.value.some((entry) => dayKeyOf(entry) === todayKey.value);
});
const todayPlaceholderNote = computed(() => {
  const clock = formatClock(timelineDays.value[todayKey.value]?.extractedAt);
  return clock ? `上次整理 ${clock}` : "还没整理，点右上角「立即整理忆泡」";
});

/** 筛选 chip 后面跟随的条数：用服务端全量计数，不是「载入了多少条」 */
function countFor(label: string) {
  const type = filterOptions.find((option) => option.label === label)?.type;
  if (type === "memory") return timelineCounts.value.memory;
  if (type === "snapshot") return timelineCounts.value.snapshot;
  if (type === "memoryEvent") return timelineCounts.value.memoryEvent;
  return knownTotal.value;
}

type TimelineResponse = {
  entries: TimelineEntry[];
  counts: { message: number; event: number; memory: number; snapshot: number; memoryEvent: number };
  days: TimelineDay[];
  today: string;
};

let timelineRequestSeq = 0;
async function loadTimeline(targetCharacterId = id.value) {
  const seq = ++timelineRequestSeq;
  if (targetCharacterId !== id.value) return;
  timelineLoading.value = true;
  try {
    // kinds 只取记忆、总结与忆泡：额度全给记忆（400 条），消息不再抢窗口
    const result = await $fetch<TimelineResponse>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/timeline?kinds=${isGrowthMode.value ? "memory" : "memory,snapshot,memoryEvent"}&limit=400`,
    );
    if (seq !== timelineRequestSeq || targetCharacterId !== id.value) return;
    timelineEntries.value = result.entries;
    timelineCounts.value = result.counts;
    timelineDays.value = Object.fromEntries(result.days.map((day) => [day.dayKey, day]));
    todayKey.value = result.today;
  } catch {
    if (seq !== timelineRequestSeq || targetCharacterId !== id.value) return;
    timelineEntries.value = [];
    timelineCounts.value = { message: 0, event: 0, memory: 0, snapshot: 0, memoryEvent: 0 };
    timelineDays.value = {};
    todayKey.value = "";
    ElMessage.error("记忆时间线读取失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === timelineRequestSeq) timelineLoading.value = false;
  }
}

// ── 全库检索 ────────────────────────────────────────────────
/**
 * 时间线只载最近 400 条，所以「找三个月前那条偏好」必须走服务端。
 * 搜索框一有内容就切换到检索模式（列表换成检索结果），清空即回到时间线。
 * 游标翻页由服务端给，前端只管往后追加。
 */
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

const searchRows = ref<MemoryRow[]>([]);
const searchTotal = ref(0);
const searchCursor = ref<string | null>(null);
const searchLoading = ref(false);
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
function formatMemoryTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
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

let searchRequestSeq = 0;
function resetSearch() {
  searchRequestSeq += 1;
  searchRows.value = [];
  searchTotal.value = 0;
  searchCursor.value = null;
  searchLoading.value = false;
}

async function runSearch(reset: boolean) {
  if (!isSearching.value) return;
  if (!reset && !searchCursor.value) return;
  const seq = ++searchRequestSeq;
  const targetCharacterId = id.value;
  const targetQuery = query.value.trim();
  searchLoading.value = true;
  try {
    const params = new URLSearchParams({ limit: "30", q: targetQuery });
    if (!reset && searchCursor.value) params.set("cursor", searchCursor.value);
    const result = await $fetch<{ items: MemoryRow[]; total: number; nextCursor: string | null }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/memories?${params.toString()}`,
    );
    if (seq !== searchRequestSeq || targetCharacterId !== id.value || targetQuery !== query.value.trim()) return;
    searchRows.value = reset ? result.items : [...searchRows.value, ...result.items];
    searchTotal.value = result.total;
    searchCursor.value = result.nextCursor;
  } catch {
    if (seq !== searchRequestSeq || targetCharacterId !== id.value || targetQuery !== query.value.trim()) return;
    if (reset) resetSearch();
    ElMessage.error("记忆检索失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === searchRequestSeq) searchLoading.value = false;
  }
}

/** 防抖 300ms：找一条记忆不该每敲一个字打一次库 */
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer);
  resetSearch();
  if (!isSearching.value) return;
  searchTimer = setTimeout(() => void runSearch(true), 300);
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  characterLoadSeq += 1;
  timelineRequestSeq += 1;
  snapshotRequestSeq += 1;
  searchRequestSeq += 1;
  recycleBinRequestSeq += 1;
  memoryDetailRequestSeq += 1;
  groupChatRequestSeq += 1;
  privateChatRequestSeq += 1;
});

let snapshotRequestSeq = 0;
async function loadSnapshots(targetCharacterId = id.value) {
  const seq = ++snapshotRequestSeq;
  if (targetCharacterId !== id.value) return;
  try {
    const result = await $fetch<Snapshot[]>(`/api/characters/${encodeURIComponent(targetCharacterId)}/snapshots`);
    if (seq === snapshotRequestSeq && targetCharacterId === id.value) snapshots.value = result;
  } catch {
    if (seq !== snapshotRequestSeq || targetCharacterId !== id.value) return;
    snapshots.value = [];
    ElMessage.error("阶段总结加载失败，请确认本地数据库已迁移。");
  }
}

let characterLoadSeq = 0;
async function loadCharacter() {
  const requestedCharacterId = id.value;
  const seq = ++characterLoadSeq;
  // 角色列表为空 / 还没解析出 id 时不要发请求，否则会打出无意义的 404 提示
  if (!requestedCharacterId) {
    currentCharacter.value = null;
    snapshots.value = [];
    timelineEntries.value = [];
    return;
  }
  try {
    const result = await $fetch<Character>(`/api/characters/${encodeURIComponent(requestedCharacterId)}`);
    if (seq !== characterLoadSeq || requestedCharacterId !== id.value) return;
    currentCharacter.value = result;
    await Promise.all([...(isGrowthMode.value ? [] : [loadSnapshots(requestedCharacterId)]), loadTimeline(requestedCharacterId)]);
  } catch {
    if (seq !== characterLoadSeq || requestedCharacterId !== id.value) return;
    currentCharacter.value = null;
    snapshots.value = [];
    timelineEntries.value = [];
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
    await loadCharacter();
    ElMessage.success("长期记忆已保存到数据库，并加入时间线。");
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
 * 时间线行和检索结果都走这里：时间线行的 id 是 `memory:<uuid>`，检索结果直接就是 uuid。
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

function openMemoryEditor(entry: TimelineEntry) {
  const memoryId = entry.id.startsWith("memory:") ? entry.id.slice("memory:".length) : "";
  void openMemoryDetail(memoryId);
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
    await loadCharacter();
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

async function setMemoryStatus(entry: TimelineEntry, status: "active" | "archived" | "invalidated") {
  const memoryId = entry.id.startsWith("memory:") ? entry.id.slice("memory:".length) : "";
  if (!memoryId) return;

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
    await $fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: { status },
    });
    await loadCharacter();
    ElMessage.success(`记忆已${actionLabel}。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "更新记忆状态失败。";
    ElMessage.error(message);
  }
}

/** 行内「更多」菜单：状态类操作收进菜单，一行只留「编辑」+ 一个入口 */
async function runMemoryCommand(entry: TimelineEntry, command: string) {
  if (command === "trash") {
    await moveMemoryToTrash(entry);
    return;
  }
  await setMemoryStatus(entry, command as "active" | "archived" | "invalidated");
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
async function loadRecycleBin(targetCharacterId = id.value) {
  const seq = ++recycleBinRequestSeq;
  if (targetCharacterId !== id.value) return;
  recycleBinLoading.value = true;
  try {
    const result = await $fetch<RecycleBinEntry[]>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/memories/trash`,
    );
    if (seq === recycleBinRequestSeq && targetCharacterId === id.value) recycleBinEntries.value = result;
  } catch {
    if (seq !== recycleBinRequestSeq || targetCharacterId !== id.value) return;
    recycleBinEntries.value = [];
    ElMessage.error("回收站加载失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === recycleBinRequestSeq) recycleBinLoading.value = false;
  }
}

async function openRecycleBin() {
  recycleBinOpen.value = true;
  await loadRecycleBin();
}

async function moveMemoryToTrash(entry: TimelineEntry) {
  const memoryId = entry.id.startsWith("memory:") ? entry.id.slice("memory:".length) : "";
  if (!memoryId) return;
  try {
    await ElMessageBox.confirm(
      "这条记忆将从主时间线和当前长期记忆集合中移出，但不会被立即永久删除。你可以在回收站中恢复。已有阶段总结会保留生成时的历史副本。",
      "移入记忆回收站",
      { confirmButtonText: "移入回收站", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  try {
    await $fetch(`/api/memories/${encodeURIComponent(memoryId)}/trash`, { method: "POST" });
    await loadCharacter();
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
    await Promise.all([loadRecycleBin(), loadCharacter()]);
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
    await Promise.all([loadRecycleBin(), loadCharacter()]);
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
    await loadCharacter();
    ElMessage.success(`已保存 ${result.messageCount} 条对话消息并刷新时间线。${result.timestampsEstimated ? "消息时间按录入顺序估算。" : ""}`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "录入对话失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    conversationSaving.value = false;
  }
}

function toneFor(tagTone: string) {
  return ({ green: "pill-green", purple: "pill-purple", blue: "pill-blue", amber: "pill-amber", gray: "pill-gray" } as Record<string, string>)[tagTone] || "pill-gray";
}
function markerFor(type: TimelineType) {
  return type === "message" ? "对" : type === "memory" ? "忆" : type === "snapshot" ? "档" : "事";
}
function formatSourceTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}
/**
 * 和阶段总结页的「手动存档」是同一个动作（同一个 POST），所以名词、确认文案保持一致。
 * 以前这里叫「手动归档」且没有二次确认 —— 名字像「立刻启动自动归档」，误点一次就多一份版本。
 */
async function manualSnapshot() {
  if (snapshotCreating.value) return;
  try {
    await ElMessageBox.confirm(
      "只把当下这一刻拍成快照：当前周期内的消息来源 + 全部生效中的长期记忆。不调用模型，也不会触发或替代自动归档。自动归档由调度器在周期结束时排任务、调模型提炼。",
      "手动存档（不调用模型）",
      { confirmButtonText: "存档", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  snapshotCreating.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, { method: "POST" });
    await Promise.all([loadSnapshots(), loadTimeline()]);
    ElMessage.success("已存档。已关联周期内的消息/事件与长期记忆来源；没有调用模型。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "归档保存失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    snapshotCreating.value = false;
  }
}

/**
 * 立即 AI 归档：手动触发「自动归档」跑一次。
 *
 * 本地没起调度器时，周期任务永远不会自己来；这个入口走的是和自动归档同一套队列与幂等键，
 * 所以它不会另造一份总结，只是把「现在」当成周期边界跑一遍。
 */
const aiArchiving = ref(false);
async function runAiArchive() {
  if (aiArchiving.value) return;
  try {
    await ElMessageBox.confirm(
      "现在就跑一次自动归档：调模型提炼最近一个周期的对话，生成阶段总结，并按结果新增 / 更新长期记忆。会产生模型调用费用。",
      "立即 AI 归档",
      { confirmButtonText: "开始归档", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  aiArchiving.value = true;
  try {
    const result = await $fetch<{
      queued: string[];
      skipped: string[];
      processed: Array<{ status: string; message: string }>;
      pending: number;
      advancedTo: string | null;
      /** 执行超过请求里的等待窗口，已转后台；进度看右下角面板。 */
      processing?: boolean;
    }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots/generate`, { method: "POST" });

    void refreshMemoryProgress();
    await Promise.all([loadSnapshots(), loadTimeline()]);

    const failed = result.processed.find((item) => item.status === "FAILED" || item.status === "RETRY_WAIT");
    const ok = result.processed.filter((item) => item.status === "SUCCEEDED");
    if (result.processing) {
      ElMessage.info("已开始归档，进度在右下角；切页面、刷新都不会中断。");
    } else if (failed) {
      // 失败时周期边界不会推进，这段数据下次还能补上，所以要说清楚去重试而不是重来
      ElMessage.warning(`${failed.message}（这次没有推进周期，去「后台任务」点重试即可）`);
    } else if (result.pending > 0) {
      ElMessage.warning(`还有 ${result.pending} 个归档任务在队列里没跑完，去「后台任务」看一下。`);
    } else if (ok.length) {
      ElMessage.success(ok.map((item) => item.message).join("；"));
    } else if (result.skipped.length) {
      ElMessage.info(result.skipped.join("；"));
    } else {
      ElMessage.info("任务已排队，但没有可执行的 worker；启动 worker 后会继续处理。");
    }
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "归档失败，请检查模型配置与数据库连接。";
    ElMessage.error(message);
  } finally {
    aiArchiving.value = false;
  }
}

/**
 * 归档/整理转到后台跑完之后，把列表刷一遍。
 *
 * 面板轮询一直在跑（它读的是任务行），这里只是接住「某个任务刚结束」这个信号：
 * 不刷新的话，页面上的阶段总结和忆泡会停在点击那一刻，看起来像没生效。
 */
const { lastFinished } = useMemoryProgress();
watch(lastFinished, (job) => {
  if (!job || job.characterId !== id.value) return;
  if (!isGrowthMode.value) void loadSnapshots();
  void loadTimeline();
});

/**
 * 立即整理忆泡：昨天收口 + 今天增量。
 *
 * 调度器每小时才跑一次，用户点按钮时不该等；服务端会排任务并当场开始执行。
 * 超过几秒还没跑完就先回响应、执行留在后台，所以这里要能接住 `processing`：
 * 结果由右下角面板展示，而不是这一句 toast。
 */
const eventExtracting = ref(false);
async function runEventExtraction() {
  if (eventExtracting.value) return;
  eventExtracting.value = true;
  try {
    const result = await $fetch<{
      queued: string[];
      processed: Array<{ status: string; message: string }>;
      /** 没排任何任务时的原因：上一次还在跑，还是确实没有新对话。 */
      notice?: "queued" | "running" | "no-new-messages";
      /** 执行超过请求里的等待窗口，已转后台；进度看右下角面板。 */
      processing?: boolean;
    }>(`/api/characters/${encodeURIComponent(id.value)}/memory-events/extract`, { method: "POST" });
    void refreshMemoryProgress();
    await loadTimeline();
    const failed = result.processed.find((item) => item.status !== "SUCCEEDED" && item.status !== "SKIPPED");
    if (result.processing) {
      /**
       * 服务端只等了几秒就把请求放回来了，执行还在后台跑。
       * 这里不要再说「已排队但没有 worker」—— 那是另一回事。
       */
      ElMessage.info(`已开始整理 ${result.queued.length} 段，进度在右下角；切页面、刷新都不会中断。`);
    } else if (result.queued.length === 0) {
      /**
       * 之前这里一律说「昨天和今天还没有对话」。可实际上「上次还在跑」也会走到这一支，
       * 而上一次失败时更冤 —— 对话明明在，用户却被告知没什么可整理的。
       * 失败/取消现在会直接重排并当场重跑，走到这里只剩两种真实原因。
       */
      ElMessage.info(result.notice === "running"
        ? "上一次整理正在跑，等它结束再点一次。"
        : "昨天和今天没有可整理的新对话：已经整理过的不会重复跑一遍。");
    } else if (failed) {
      ElMessage.warning(failed.message);
    } else if (result.processed.length === 0) {
      ElMessage.info("已排队，但当前没有可执行的 worker；启动 worker 后会继续处理。");
    } else {
      ElMessage.success(result.processed.map((item) => item.message).join("；"));
    }
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "整理忆泡失败，请检查本地开发服务器日志。";
    ElMessage.error(message);
  } finally {
    eventExtracting.value = false;
  }
}

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
  timelineRequestSeq += 1;
  snapshotRequestSeq += 1;
  recycleBinRequestSeq += 1;
  memoryDetailRequestSeq += 1;
  privateChatRequestSeq += 1;
  groupChatRequestSeq += 1;
  currentCharacter.value = null;
  snapshots.value = [];
  timelineEntries.value = [];
  timelineCounts.value = { message: 0, event: 0, memory: 0, snapshot: 0, memoryEvent: 0 };
  timelineDays.value = {};
  resetSearch();
  recycleBinEntries.value = [];
  recycleBinOpen.value = false;
  recycleBinLoading.value = false;
  memoryDialogOpen.value = false;
  memoryEditDialogOpen.value = false;
  memoryEditLoading.value = false;
  editingMemoryId.value = "";
  draftEditMemoryContent.value = "";
  channelFilter.value = SOURCE_ALL;
  if (searchTimer) clearTimeout(searchTimer);
  if (isSearching.value) void runSearch(true);
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
    <MemorySectionNavigation v-if="isGrowthMode" active="memory" />
    <PageHeader
      :eyebrow="isGrowthMode ? '成长系统 / 记忆系统' : '工作空间 / 角色记忆'"
      :description="isGrowthMode ? '查看、检索和整理她的长期记忆，并追溯每条记忆的来源。' : '通过左下角切换角色，查看它的对话、阶段总结与长期记忆。'"
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
        <button
          v-if="!isGrowthMode"
          type="button"
          class="btn"
          :disabled="eventExtracting"
          :aria-busy="eventExtracting"
          @click="runEventExtraction"
        >
          <el-icon
            v-if="eventExtracting"
            class="is-loading"
          >
            <Loading />
          </el-icon>
          <el-icon v-else>
            <MagicStick />
          </el-icon>{{ eventExtracting ? "整理中…" : "立即整理忆泡" }}
        </button>
        <button
          v-if="!isGrowthMode"
          type="button"
          class="btn primary"
          :disabled="aiArchiving || !id"
          title="等同于自动归档跑一次：排队、调模型、当场执行"
          @click="runAiArchive"
        >
          <el-icon><MagicStick /></el-icon>{{ aiArchiving ? "归档中…" : "立即 AI 归档" }}
        </button>
        <button
          v-if="!isGrowthMode"
          type="button"
          class="btn"
          :disabled="snapshotCreating"
          @click="manualSnapshot"
        >
          <el-icon><Files /></el-icon>{{ snapshotCreating ? "存档中…" : "手动存档（不调模型）" }}
        </button>
      </template>
    </PageHeader>

    <template v-if="characters.length">
      <!-- 一组数字只讲一遍：原来 KPI 四格 + 右栏「记忆状态」卡是同一组数据。
         这里收成一条静音统计带，字号 18px，比记忆正文更弱。 -->
      <div class="card stat-band">
        <div class="sb-cell">
          <span class="sb-k">长期记忆</span>
          <span class="sb-v">{{ character.memoryCount }}<small>条</small></span>
          <span class="sb-f">承诺与约定 {{ commitmentCount }} 项</span>
        </div>
        <div v-if="!isGrowthMode" class="sb-cell">
          <span class="sb-k">归档周期</span>
          <!-- 主数字只放「正在生效」的周期。设置页选「下一个周期」保存后，
               库里是 active=旧值 + pending=新值，这里再拿新值当主数字就会
               和实际排期对不上。待生效的改动跟在脚注里说清楚。 -->
          <span class="sb-v">{{ character.intervalDays }}<small>天</small></span>
          <span class="sb-f sb-f-wrap">
            <template v-if="pendingIntervalDays !== null">
              下一次 {{ character.nextSnapshot }} 归档，之后改为 {{ pendingIntervalDays }} 天 ·
            </template>
            <template v-else>
              下一次 {{ character.nextSnapshot }} ·
            </template>
            <button
              type="button"
              class="ms-link"
              :disabled="!character.id"
              @click="navigateTo('/characters/' + character.id + '/settings/memory')"
            >调整</button>
          </span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">已记录对话</span>
          <span class="sb-v">{{ timelineLoading ? "—" : recordedMessageCount }}<small>条</small></span>
          <span class="sb-f sb-f-wrap">
            平台事件 {{ timelineLoading ? "—" : recordedEventCount }} 项 ·
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

      <div class="panel-grid" :class="{ 'panel-grid-growth': isGrowthMode }">
        <section>
          <div class="sec-h">
            <h2>{{ isSearching ? (isGrowthMode ? "长期记忆检索" : "记忆检索") : (isGrowthMode ? "长期记忆时间线" : "角色记忆时间线") }}</h2>
            <span class="sub">{{ isSearching ? searchTotal + " 条命中" : filteredEntries.length + "/" + timelineEntries.length + " 条" }}</span>
            <button
              v-if="isSearching"
              type="button"
              class="more"
              @click="query = ''"
            >
              回到时间线
            </button>
          </div>
          <div class="card tl-card">
            <div
              v-if="!isSearching"
              class="filters"
            >
              <button
                v-for="option in visibleFilterOptions"
                :key="option.label"
                type="button"
                class="chip"
                :class="{ on: activeFilter === option.label }"
                @click="activeFilter = option.label"
              >
                {{ option.label }}<span class="n">{{ countFor(option.label) }}</span>
              </button>
            </div>
            <div class="tl-tools">
              <el-input
                v-model="query"
                clearable
                placeholder="搜索全部记忆（不受时间线条数限制）……"
                class="tl-search"
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>
              <el-select
                v-if="!isSearching && (realChannelOptions.length || memoryScopeOptions.length)"
                v-model="channelFilter"
                class="tl-select"
                aria-label="按来源筛选时间线"
              >
                <el-option
                  :label="SOURCE_ALL"
                  :value="SOURCE_ALL"
                />
                <el-option-group
                  v-if="realChannelOptions.length"
                  label="渠道"
                >
                  <el-option
                    v-for="channel in realChannelOptions"
                    :key="channel"
                    :label="channel"
                    :value="channel"
                  />
                </el-option-group>
                <el-option-group
                  v-if="memoryScopeOptions.length"
                  label="记忆范围"
                >
                  <el-option
                    v-for="channel in memoryScopeOptions"
                    :key="channel"
                    :label="channel"
                    :value="channel"
                  />
                </el-option-group>
              </el-select>
              <button
                type="button"
                class="tool-link"
                @click="openRecycleBin"
              >
                <el-icon><Delete /></el-icon>回收站
              </button>
            </div>
            <!-- 检索模式：结果来自全库，不受时间线那 400 条的限制 -->
            <div
              v-if="isSearching"
              class="timeline"
            >
              <div class="search-head">
                <span>在全部 {{ timelineCounts.memory }} 条长期记忆里按内容查（含已被替代与已失效的）</span>
              </div>
              <div
                v-if="searchLoading && !searchRows.length"
                class="tl-loading"
              >
                正在检索……
              </div>
              <template v-else>
                <article
                  v-for="row in searchRows"
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
                      <button
                        type="button"
                        class="row-more"
                        @click="openMemoryDetail(row.id)"
                      >
                        来源
                      </button>
                    </div>
                  </div>
                </article>
                <button
                  v-if="searchCursor"
                  type="button"
                  class="load-more"
                  :disabled="searchLoading"
                  @click="runSearch(false)"
                >
                  {{ searchLoading ? "加载中……" : "加载更多" }}
                </button>
                <div
                  v-if="!searchRows.length"
                  class="card-empty"
                >
                  <el-icon><Search /></el-icon>
                  <span>没有匹配的记忆</span>
                  <span>换个关键词，或清空搜索框回到时间线。</span>
                </div>
              </template>
            </div>
            <div
              v-else
              class="timeline"
            >
              <div
                v-if="timelineLoading"
                class="tl-loading"
              >
                正在加载已保存的时间线记录……
              </div>
              <template v-else>
                <div
                  v-if="showTodayPlaceholder"
                  class="timeline-day timeline-day-empty"
                >
                  <span class="timeline-day-label">今天 · 0 条</span>
                  <span class="timeline-day-meta">{{ todayPlaceholderNote }}</span>
                </div>
                <template
                  v-for="(entry, index) in pagedEntries"
                  :key="entry.id"
                >
                  <div
                    v-if="isDayStart(index)"
                    class="timeline-day"
                  >
                    <span class="timeline-day-label">{{ dayLabelAt(index) }}</span>
                    <span
                      v-if="dayExtractedAt(index)"
                      class="timeline-day-meta"
                    >{{ dayExtractedAt(index) }}</span>
                    <span
                      v-if="dayHasDraftAt(index)"
                      class="timeline-day-draft"
                    >还在记</span>
                  </div>
                  <article
                    class="timeline-item"
                  >
                    <div
                      class="timeline-marker"
                      :class="toneFor(entry.tagTone)"
                    >
                      {{ markerFor(entry.type) }}
                    </div>
                    <div class="timeline-content">
                      <div class="timeline-heading">
                        <span class="timeline-title">{{ entry.title }}</span><span class="muted-note">{{ entry.time }}</span>
                      </div>
                      <p class="timeline-summary">
                        {{ entry.summary }}
                      </p>
                      <div class="timeline-meta">
                        <span
                          class="pill"
                          :class="toneFor(entry.tagTone)"
                        >{{ entry.tag }}</span><span v-if="entry.channel !== entry.tag">{{ entry.channel }}</span><span>{{ entry.source }}</span><span
                          v-if="entry.type === 'memory' && entry.importance !== undefined"
                          class="timeline-importance"
                        >重要度 {{ entry.importance.toFixed(2) }}</span>
                      </div>
                      <!-- 行内只留「编辑 + 更多」：原来 4 个链接常显，其中 2 个破坏性，
                       每行都在喊。状态类操作收进菜单，默认不占视线。 -->
                      <div
                        v-if="entry.type === 'memory'"
                        class="memory-actions"
                      >
                        <el-button
                          link
                          type="primary"
                          size="small"
                          @click="openMemoryEditor(entry)"
                        >
                          编辑
                        </el-button>
                        <el-dropdown
                          trigger="click"
                          placement="bottom-end"
                          @command="runMemoryCommand(entry, String($event))"
                        >
                          <button
                            type="button"
                            class="row-more"
                          >
                            更多<el-icon><ArrowDown /></el-icon>
                          </button>
                          <template #dropdown>
                            <el-dropdown-menu>
                              <template v-if="entry.tag === '长期记忆'">
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
                </template>
                <p
                  v-if="truncated"
                  class="tl-note"
                >
                  这里只列最近 {{ loadedTotal }} 条（共 {{ knownTotal }} 条长期记忆）。更早的用上面的搜索框查。
                </p>
                <button
                  v-if="filteredEntries.length > visibleCount"
                  type="button"
                  class="load-more"
                  @click="visibleCount += PAGE_SIZE"
                >
                  加载更多（还有 {{ filteredEntries.length - visibleCount }} 条）
                </button>
                <div
                  v-if="!filteredEntries.length"
                  class="card-empty"
                >
                  <el-icon><Collection /></el-icon>
                  <span>{{ timelineEntries.length ? "没有匹配的记录" : "还没有已保存的记录" }}</span>
                  <span>{{ timelineEntries.length ? "换个筛选条件或清空搜索词再试一次" : "保存长期记忆之后，这里会按时间顺序出现对应条目" }}</span>
                </div>
              </template>
            </div>
          </div>
        </section>

        <aside v-if="!isGrowthMode" class="side-col">
          <div class="sec-h">
            <h2>最近归档</h2>
            <span class="sub">{{ snapshots.length }} 份</span>
            <button
              type="button"
              class="more"
              @click="navigateTo('/snapshots?c=' + character.id)"
            >
              全部<el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="card snap-card">
            <NuxtLink
              v-for="snapshot in snapshots.slice(0, 2)"
              :key="snapshot.id"
              :to="'/snapshots?c=' + character.id"
              class="snap-row"
            >
              <span class="snap-top">
                <span>{{ snapshot.kind === "MANUAL" ? "手动存档" : "第 " + snapshot.number + " 份阶段总结" }}</span>
                <span class="muted-note">v{{ snapshot.version }}</span>
              </span>
              <span class="snap-sum">{{ snapshot.summary }}</span>
            </NuxtLink>
            <div
              v-if="!snapshots.length"
              class="card-empty"
            >
              <el-icon><Files /></el-icon>
              <span>还没有保存的总结</span>
              <span>生成一份阶段总结，或等周期 Worker 跑完，这里会出现版本记录</span>
            </div>
          </div>
        </aside>
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
          <span>保存后会写入 PostgreSQL，并立即出现在角色记忆时间线中。角色全局记忆在本角色所有对话中都可检索；私人记忆只在你自己和这个角色对话时使用，不会混入其他用户。</span>
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
      <template #footer>
        <el-button @click="recycleBinOpen = false">
          关闭
        </el-button>
      </template>
    </el-dialog>

    <!-- 群聊记录：群聊也算她的记忆，但不进时间线，单独一个抽屉按群号翻 -->
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

/* 时间线下面两栏：左时间线 + 右角色栏，比例与概览页一致 */
.panel-grid{margin-top:0}

/* ── 时间线卡片 ─────────────────────────────────────── */
.tl-card{padding:14px 18px 10px}
.tl-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tl-search{min-width:170px;flex:1}
.tl-select{width:132px;flex:none}
/* 回收站是「管这批记忆」的工具，排在搜索/渠道后面，不做成第三个控件的样子 */
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
/* 重要度：只在记忆条目上出现。排序改动看不见就没法核对，所以把它摆出来。 */
.timeline-importance{color:var(--faint);font-size:12px;font-variant-numeric:tabular-nums}

.load-more{width:100%;margin-top:4px;border:0;border-radius:8px;background:none;padding:12px 0;color:var(--dim);font-size:12px;font-weight:600;cursor:pointer;transition:background .14s var(--ease),color .14s var(--ease)}
.load-more:hover{background:var(--surface-2);color:var(--brand-strong)}
/* 截断说明：只在「库里比载入的多」时出现，别让人以为记忆丢了 */
.tl-note{margin:8px 0 0;border-radius:8px;background:var(--surface-2);padding:8px 10px;color:var(--dim);font-size:12px;line-height:1.7}
/* 检索模式的头：一句话说明检索范围，别让人以为在搜总结 */
.search-head{margin:2px 0 10px;border-radius:8px;background:var(--surface-2);padding:7px 10px;color:var(--dim);font-size:12px;line-height:1.7}
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

/* ── 右栏 ──────────────────────────────────────────── */
/* 右栏现在只剩「最近归档」一块，跟着滚，别在下面留一大片空白 */
.side-col{position:sticky;top:72px;align-self:start}

/* ── 最近归档 ──────────────────────────────────────── */
.snap-card{padding:6px}
.snap-row{display:block;border-radius:8px;padding:10px 12px;transition:background .14s var(--ease)}
.snap-row + .snap-row{margin-top:2px}
.snap-row:hover{background:var(--surface-2)}
.snap-top{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text-2);font-size:12px;font-weight:600}
.snap-sum{display:-webkit-box;overflow:hidden;margin-top:5px;color:var(--dim);font-size:12px;line-height:1.7;-webkit-box-orient:vertical;-webkit-line-clamp:2}

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

/* 单列时右栏不再吸顶，否则会跟着页面滚到内容之外 */
@media(max-width:1150px){.side-col{position:static}}
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
