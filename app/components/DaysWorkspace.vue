<script setup lang="ts">
import { Calendar, Search, ArrowLeft, ArrowRight, Document } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { type Character } from "~/utils/mock-data";
import { formatDayClock } from "~/utils/day-time";
import MemorySectionNavigation from "~/components/MemorySectionNavigation.vue";


/**
 * 忆泡日历：一天一行，点开看那天发生了什么。
 *
 * 数据源是 `memory_event_days`（整理进度）+ `memory_events`（当天的忆泡），
 * 不是从时间线反推的 —— 这样「今天还没整理」也能作为一行出现。
 */

await useCharacterListData();
const { id } = useCharacterSelection("/growth/memory/events");

type DayRow = {
  dayKey: string;
  state: "DRAFT" | "FINAL" | null;
  eventCount: number;
  extractedAt: string | null;
};
type DayEvent = {
  id: string;
  occurredAt: string;
  timeOfDay: string | null;
  place: string | null;
  participants: string[];
  title: string;
  detail: string;
  state: "DRAFT" | "FINAL";
  status: "ACTIVE" | "ARCHIVED";
  confidence: number | null;
  scope: "character" | "private" | "external";
};
type DayMessage = { id: string; role: string; content: string; occurredAt: string; author: string | null; member: string | null };
type DayMessageGroup = { id: string; title: string; total: number; messages: DayMessage[] };

const characters = useCharacterList();
const currentCharacter = computed<Character | null>(
  () => characters.value.find((item) => item.id === id.value) ?? null,
);

const days = ref<DayRow[]>([]);
const daysPage = ref(1);
const daysPageSize = ref(20);
const daysTotal = ref(0);
const today = ref("");
const timeZone = ref("Asia/Shanghai");
/** 按忆泡标题/详情搜索日期；空 = 普通列表。 */
const searchQuery = ref("");
const searchActive = computed(() => searchQuery.value.trim().length > 0);
const loading = ref(false);
const selected = ref("");
const eventsPage = ref(1);
const detail = ref<{
  day: DayRow | null;
  events: DayEvent[];
  usage: { calls: number; tokens: number };
  timeZone: string;
  /** 当天忆泡总数（含已隐藏），分页控件用。 */
  eventsTotal: number;
  eventsPage: number;
  eventsPageSize: number;
  eventsTotalPages: number;
} | null>(null);
/**
 * 当天原文：点「查看当天原文」才请求。
 *
 * 以前它跟忆泡一起返回，一天聊得多的时候（单群一天两千条）点开日期就要传几百条原文；
 * 页面上默认只看忆泡，这部分数据其实是白拿的。现在按需取，且不分页 ——
 * 「当天原文」本来就是一天的完整语义。
 */
const messageGroups = ref<DayMessageGroup[]>([]);
const messageTotal = ref(0);
const messagesLoading = ref(false);
const messagesLoadedFor = ref("");
let messagesRequestSeq = 0;
/** 原文总数：按会话分组后要自己加总。用当天真实条数，不是「载进来的条数」。 */
const totalMessages = computed(() => messageTotal.value);
/**
 * 原文里这句话是谁说的。
 *
 * 以前一律写「对方 / 她」：群里一屋子人全被揉成同一个「对方」，事后对不上是哪位群友。
 * 现在优先用消息里的昵称，昵称缺失退回群内代号（`member_2` 这种，改昵称也不会变），
 * 两样都没有才用「对方」兜底。她自己按角色名显示。
 */
function speakerOf(message: DayMessage) {
  if (message.role === "ASSISTANT") return currentCharacter.value?.name || "她";
  if (message.role !== "USER") return "系统";
  return message.author || message.member || "对方";
}
/**
 * 组标题上的条数。
 *
 * 每个会话只载当天最近 200 条（聊得多的群一天上千条），所以要说清「这是最近的一部分」，
 * 否则用户会以为那天只说了这么几句。
 */
function originalCountLabel(group: DayMessageGroup) {
  const total = group.total ?? group.messages.length;
  return total > group.messages.length
    ? `最近 ${group.messages.length} / ${total} 条`
    : `${group.messages.length} 条`;
}
const detailLoading = ref(false);
const showMessages = ref(false);
const selectedDayIndex = computed(() => days.value.findIndex(day => day.dayKey === selected.value));
function adjacentDay(offset: number) {
  const day = days.value[selectedDayIndex.value + offset];
  if (day) selectDay(day.dayKey);
}
function weekdayOf(dayKey: string) {
  const date = new Date(`${dayKey}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { weekday: "long", timeZone: "UTC" }).format(date);
}

// 每次新请求都会推进序号；角色、日期或搜索条件变化时，旧响应只能被丢弃。
let daysRequestSeq = 0;
let detailRequestSeq = 0;
let editSaveSeq = 0;

/** 隐藏的忆泡单独收起来：默认不占视线，但随时能恢复。 */
const activeEvents = computed(() => (detail.value?.events ?? []).filter((item) => item.status !== "ARCHIVED"));
const archivedEvents = computed(() => (detail.value?.events ?? []).filter((item) => item.status === "ARCHIVED"));

const editOpen = ref(false);
const editSaving = ref(false);
const editing = ref<DayEvent | null>(null);
const form = ref({ title: "", detail: "", place: "", participants: "" });

const knowledgeOpen = ref(false);
const knowledgeSaving = ref(false);
const knowledgeEvent = ref<DayEvent | null>(null);
const knowledgeForm = ref({ excerpt: "", reason: "" });
const knowledgeError = ref("");
let knowledgeRequestSeq = 0;
let knowledgeContextSeq = 0;

type KnowledgeRequestResult = {
  requestId: string; eventId: string | null; status: "PENDING" | "CREATED" | "SKIPPED";
  candidateId: string | null; created: boolean;
};
function canRequestKnowledge(event: DayEvent) {
  return event.scope === "character" && event.status === "ACTIVE";
}
function closeKnowledgeRequest() {
  knowledgeRequestSeq += 1;
  knowledgeOpen.value = false;
  knowledgeSaving.value = false;
  knowledgeEvent.value = null;
  knowledgeForm.value = { excerpt: "", reason: "" };
  knowledgeError.value = "";
}
function openKnowledgeRequest(event: DayEvent) {
  if (!canRequestKnowledge(event) || detailLoading.value || !detail.value?.events.some(item => item.id === event.id && canRequestKnowledge(item))) return;
  closeKnowledgeRequest();
  knowledgeContextSeq = detailRequestSeq;
  knowledgeEvent.value = event;
  knowledgeOpen.value = true;
}
async function submitKnowledgeRequest() {
  const target = knowledgeEvent.value;
  const characterId = id.value;
  const dayKey = selected.value;
  if (!target || !knowledgeOpen.value || knowledgeSaving.value || !characterId || !dayKey) return;
  if (knowledgeContextSeq !== detailRequestSeq || !canRequestKnowledge(target)) return;
  const current = detail.value?.events.find(item => item.id === target.id);
  if (!current || !canRequestKnowledge(current)) return;
  const excerpt = knowledgeForm.value.excerpt.trim();
  const reason = knowledgeForm.value.reason.trim();
  knowledgeError.value = "";
  if (excerpt.length < 20 || excerpt.length > 2000) {
    knowledgeError.value = "请选择或填写 20～2000 字的原文摘录。";
    return;
  }
  if (!current.detail.includes(excerpt)) {
    knowledgeError.value = "摘录必须是这条忆泡详情中的一段连续原文，不能改写或拼接。";
    return;
  }
  if (reason.length > 240) {
    knowledgeError.value = "提出理由不能超过 240 字。";
    return;
  }
  const seq = ++knowledgeRequestSeq;
  const contextSeq = detailRequestSeq;
  const isCurrent = () => seq === knowledgeRequestSeq && contextSeq === detailRequestSeq
    && characterId === id.value && dayKey === selected.value && knowledgeOpen.value
    && knowledgeEvent.value?.id === target.id;
  knowledgeSaving.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(characterId)}/memory-events/${encodeURIComponent(target.id)}/knowledge-candidate`;
    const result = await $fetch<KnowledgeRequestResult>(url, { method: "POST", body: { excerpt, reason } });
    if (!isCurrent()) return;
    closeKnowledgeRequest();
    if (result.status === "SKIPPED") ElMessage.info("该请求已跳过，未自动生成或入库知识。可到知识页面查看已有候选。");
    else if (result.status === "CREATED") ElMessage.success("该请求已处理，请到知识页面整理与确认候选；未自动入库。");
    else ElMessage.success(result.created
      ? "请求已提交，等待后台派发。请稍后到知识页面整理与确认候选；不会自动调用模型或入库。"
      : "该摘录已有待处理请求，请等待后台派发，稍后到知识页面整理与确认。");
  } catch (error) {
    if (!isCurrent()) return;
    const value = error as { data?: { statusMessage?: string }; statusMessage?: string };
    knowledgeError.value = value.data?.statusMessage ?? value.statusMessage ?? "提交失败，请稍后重试。";
  } finally {
    if (isCurrent()) knowledgeSaving.value = false;
  }
}


function openEdit(event: DayEvent) {
  editing.value = event;
  form.value = {
    title: event.title,
    detail: event.detail,
    place: event.place ?? "",
    participants: event.participants.join("、"),
  };
  editOpen.value = true;
}

async function saveEdit() {
  const target = editing.value;
  if (!target || editSaving.value) return;
  if (!form.value.title.trim() || !form.value.detail.trim()) {
    ElMessage.warning("标题和详情都不能为空。");
    return;
  }
  const targetCharacterId = id.value;
  const targetDayKey = selected.value;
  if (!targetCharacterId || !targetDayKey) return;
  const seq = ++editSaveSeq;
  editSaving.value = true;
  try {
    // 固定本次编辑的角色与日期，避免等待请求期间切换角色后刷新错页面。
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/memory-events/${encodeURIComponent(target.id)}`;
    const participants = form.value.participants
      .split(/[、,，\\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    await $fetch(url, {
      method: "PATCH",
      body: {
        title: form.value.title.trim(),
        detail: form.value.detail.trim(),
        place: form.value.place.trim(),
        participants,
      },
    });
    if (seq !== editSaveSeq || targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    editOpen.value = false;
    await loadDetail(targetDayKey, targetCharacterId);
    if (seq !== editSaveSeq || targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    ElMessage.success("忆泡已更新。");
  } catch (error) {
    if (seq !== editSaveSeq || targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "保存失败，请检查日志。";
    ElMessage.error(message);
  } finally {
    if (seq === editSaveSeq) editSaving.value = false;
  }
}

async function setEventStatus(event: DayEvent, status: "ACTIVE" | "ARCHIVED") {
  const targetCharacterId = id.value;
  const targetDayKey = selected.value;
  if (!targetCharacterId || !targetDayKey) return;
  try {
    if (status === "ARCHIVED") {
      await ElMessageBox.confirm(
        `「${event.title}」会从时间线上隐藏，但不会真删，之后可以恢复。`,
        "隐藏这条忆泡",
        { confirmButtonText: "隐藏", cancelButtonText: "取消", type: "warning" },
      );
    }
    // 确认框打开期间可能切换角色或日期；这种情况下取消旧页面的后续操作。
    if (targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/memory-events/${encodeURIComponent(event.id)}`;
    await $fetch(url, { method: "PATCH", body: { status } });
    if (targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    await loadDetail(targetDayKey, targetCharacterId);
    if (targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    ElMessage.success(status === "ARCHIVED" ? "已隐藏，可在「已隐藏」里恢复。" : "已恢复。");
  } catch (error) {
    // 取消确认框或切换页面不是操作失败，不弹红条。
    if (error === "cancel" || error === "close" || targetCharacterId !== id.value || targetDayKey !== selected.value) return;
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "操作失败，请检查日志。";
    ElMessage.error(message);
  }
}

function dayLabel(dayKey: string) {
  if (today.value && dayKey === today.value) return "今天";
  if (today.value) {
    const [y, m, d] = today.value.split("-").map(Number);
    const yesterday = new Date(Date.UTC(y!, m! - 1, d! - 1));
    const key = `${yesterday.getUTCFullYear()}-${String(yesterday.getUTCMonth() + 1).padStart(2, "0")}-${String(yesterday.getUTCDate()).padStart(2, "0")}`;
    if (dayKey === key) return "昨天";
  }
  const [year, month, date] = dayKey.split("-");
  return `${Number(month)} 月 ${Number(date)} 日`;
}
/** 大数字压缩成 12.3k，避免日期头被一串数字撑开。 */
function formatTokens(tokens: number) {
  if (!tokens) return "0";
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}
function clockOf(iso: string | null) {
  return formatDayClock(iso, timeZone.value);
}
function timeOf(event: DayEvent) {
  const clock = formatDayClock(event.occurredAt, timeZone.value);
  return [clock, event.timeOfDay].filter(Boolean).join(" · ");
}

async function loadDays(targetCharacterId = id.value) {
  const seq = ++daysRequestSeq;
  const keyword = searchQuery.value.trim();
  if (!targetCharacterId || targetCharacterId !== id.value) return;
  loading.value = true;
  try {
    const params = new URLSearchParams({ page: String(daysPage.value), pageSize: String(daysPageSize.value) });
    if (keyword) params.set("q", keyword);
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/days?${params.toString()}`;
    const result = await $fetch<{ today: string; timeZone: string; days: DayRow[]; page: number; pageSize: number; total: number; totalPages: number }>(url);
    if (seq !== daysRequestSeq || targetCharacterId !== id.value || keyword !== searchQuery.value.trim()) return;

    days.value = result.days;
    daysPage.value = result.page;
    daysPageSize.value = result.pageSize;
    daysTotal.value = result.total;
    today.value = result.today;
    timeZone.value = result.timeZone || "Asia/Shanghai";

    const previousSelected = selected.value;
    const nextSelected = result.days.some((day) => day.dayKey === previousSelected)
      ? previousSelected
      : result.days[0]?.dayKey ?? "";
    if (nextSelected !== previousSelected) selected.value = nextSelected;
    if (nextSelected) {
      // 详情必须在 setup 里等到，而不是丢给 watcher 补载：watcher 只在客户端冲刷，
      // SSR 首帧会停在「没有详情」的空分支，浏览器水合时客户端已是 loading 分支，
      // 于是报 Hydration node mismatch。
      // 刷新同一天时保留当前页；换到新的一天则回到第 1 页。
      await loadDetail(nextSelected, targetCharacterId, nextSelected === previousSelected ? eventsPage.value : 1);
    } else {
      detailRequestSeq += 1;
      detail.value = null;
      detailLoading.value = false;
      resetMessages();
    }
  } catch {
    if (seq !== daysRequestSeq || targetCharacterId !== id.value || keyword !== searchQuery.value.trim()) return;
    days.value = [];
    daysTotal.value = 0;
    detail.value = null;
    ElMessage.error("忆泡日历读取失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === daysRequestSeq) loading.value = false;
  }
}

async function loadDetail(dayKey: string, targetCharacterId = id.value, page = eventsPage.value) {
  closeKnowledgeRequest();
  const seq = ++detailRequestSeq;
  if (!targetCharacterId || targetCharacterId !== id.value || !dayKey) return;
  detailLoading.value = true;
  try {
    // URL 先落成 string 再传：模板字面量的字面类型会让 Nuxt 的路由类型推导爆栈（TS2321）。
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/days/${encodeURIComponent(dayKey)}?page=${page}`;
    const result = await $fetch<{
      day: DayRow | null;
      events: DayEvent[];
      usage: { calls: number; tokens: number };
      timeZone: string;
      eventsTotal: number;
      eventsTruncated: boolean;
      eventsPage: number;
      eventsPageSize: number;
      eventsTotalPages: number;
    }>(url);
    if (seq !== detailRequestSeq || targetCharacterId !== id.value || dayKey !== selected.value) return;
    detail.value = result;
    eventsPage.value = result.eventsPage;
    timeZone.value = result.timeZone || timeZone.value || "Asia/Shanghai";
    resetMessages();
  } catch {
    if (seq !== detailRequestSeq || targetCharacterId !== id.value || dayKey !== selected.value) return;
    detail.value = null;
    ElMessage.error("这一天的忆泡读取失败。");
  } finally {
    if (seq === detailRequestSeq) detailLoading.value = false;
  }
}

/** 换日期就丢掉上一天的原文：留着会在新一天下面短暂显示别人的对话。 */
function resetMessages() {
  messagesRequestSeq += 1;
  showMessages.value = false;
  messagesLoading.value = false;
  messageGroups.value = [];
  messageTotal.value = 0;
  messagesLoadedFor.value = "";
}

async function loadMessages(dayKey: string, targetCharacterId = id.value) {
  if (!dayKey || !targetCharacterId || targetCharacterId !== id.value) return;
  const seq = ++messagesRequestSeq;
  messagesLoading.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/days/${encodeURIComponent(dayKey)}/messages`;
    const result = await $fetch<{
      dayKey: string;
      timeZone: string;
      messageGroups: DayMessageGroup[];
      totalMessages: number;
    }>(url);
    if (seq !== messagesRequestSeq || targetCharacterId !== id.value || dayKey !== selected.value) return;
    messageGroups.value = result.messageGroups;
    messageTotal.value = result.totalMessages;
    messagesLoadedFor.value = dayKey;
  } catch {
    if (seq !== messagesRequestSeq || targetCharacterId !== id.value || dayKey !== selected.value) return;
    messageGroups.value = [];
    messageTotal.value = 0;
    messagesLoadedFor.value = "";
    ElMessage.error("当天原文读取失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === messagesRequestSeq) messagesLoading.value = false;
  }
}

/** 展开才请求；收起只是不显示，已经取到的原文保留着，再点开不用重新拉。 */
function toggleMessages() {
  showMessages.value = !showMessages.value;
  if (!showMessages.value) return;
  if (messagesLoadedFor.value === selected.value) return;
  void loadMessages(selected.value);
}

const { lastFinished } = useMemoryProgress();
watch(lastFinished, (job) => {
  if (!job || job.characterId !== id.value) return;
  void loadDays();
});

watch(id, () => {
  closeKnowledgeRequest();
  // 角色切换时作废旧角色的所有在途请求，并清空不属于新角色的页面状态。
  daysRequestSeq += 1;
  detailRequestSeq += 1;
  editSaveSeq += 1;
  selected.value = "";
  days.value = [];
  daysTotal.value = 0;
  daysPage.value = 1;
  eventsPage.value = 1;
  today.value = "";
  timeZone.value = "Asia/Shanghai";
  detail.value = null;
  loading.value = false;
  detailLoading.value = false;
  resetMessages();
  editOpen.value = false;
  editing.value = null;
  editSaving.value = false;
  form.value = { title: "", detail: "", place: "", participants: "" };
  if (searchTimer) clearTimeout(searchTimer);
  void loadDays(id.value);
});
/**
 * 点击左侧日期切换选中日。
 *
 * 不再用 `watch(selected)` 去追详情：watcher 只在客户端冲刷，SSR 首帧拿不到，
 * 水合时两边分支对不上；而且程序化改 `selected`（首屏、搜索、换角色）也会被连带触发。
 * 现在只有用户点击才走这里，首屏和刷新都由 `loadDays` 自己 await。
 */
function selectDay(dayKey: string) {
  if (!dayKey || dayKey === selected.value) return;
  selected.value = dayKey;
  eventsPage.value = 1;
  void loadDetail(dayKey, id.value, 1);
}
// 搜索：300ms 防抖。输入变化的当下就让旧请求失效，而不是等下一个请求发出。
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchQuery, () => {
  closeKnowledgeRequest();
  if (searchTimer) clearTimeout(searchTimer);
  daysRequestSeq += 1;
  detailRequestSeq += 1;
  days.value = [];
  daysTotal.value = 0;
  daysPage.value = 1;
  selected.value = "";
  detail.value = null;
  detailLoading.value = false;
  resetMessages();
  loading.value = true;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void loadDays(id.value);
  }, 300);
});
onBeforeUnmount(() => {
  closeKnowledgeRequest();
  if (searchTimer) clearTimeout(searchTimer);
  daysRequestSeq += 1;
  detailRequestSeq += 1;
  messagesRequestSeq += 1;
  editSaveSeq += 1;
});

await loadDays();
</script>

<template>
  <div class="page-wrap">
    <MemorySectionNavigation
      active="events"
    />
    <PageHeader
      description="沿着日期回看经历，让每一天的人、事和对话都有迹可循。"
    >
      <template #actions>
        <NuxtLink
          :to="{ path: '/growth/memory', query: { c: id } }"
          class="btn"
        >
          前往整理忆泡 <span aria-hidden="true">↗</span>
        </NuxtLink>
      </template>
    </PageHeader>
    <div
      v-if="currentCharacter"
      class="day-context"
    >
      <span><el-icon><Calendar /></el-icon>{{ currentCharacter.name }}的经历档案</span>
      <span>日期与时间按 {{ timeZone }} 显示</span>
    </div>

    <div
      v-if="!currentCharacter"
      class="card empty-card"
    >
      <p class="muted-note">
        还没有角色。
      </p>
    </div>

    <div
      v-else
      class="day-layout"
    >
      <aside class="card day-list">
        <div class="day-list-head">
          <h2>有记录的日子</h2>
          <span class="muted-note">{{ daysTotal }} 天</span>
        </div>
        <el-input
          v-model="searchQuery"
          class="day-search"
          placeholder="搜索经历、人物或关键词"
          aria-label="搜索忆泡标题和详情"
          clearable
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>
        <div
          v-if="searchActive"
          class="muted-note day-empty"
        >
          只列出命中「{{ searchQuery.trim() }}」的日子，数字是命中的条数。
        </div>
        <div
          v-if="loading"
          class="muted-note day-empty"
        >
          正在读取…
        </div>
        <div
          v-else-if="!days.length"
          class="muted-note day-empty"
        >
          {{ searchActive ? '没有找到相关经历，试试其他关键词。' : '还没有整理过的经历，前往总览整理忆泡后，这里就会留下记录。' }}
          <el-button
            v-if="searchActive"
            link
            type="primary"
            @click="searchQuery = ''"
          >
            清空搜索
          </el-button>
        </div>
        <button
          v-for="day in days"
          :key="day.dayKey"
          type="button"
          class="day-item"
          :class="{ active: day.dayKey === selected }"
          :aria-current="day.dayKey === selected ? 'date' : undefined"
          @click="selectDay(day.dayKey)"
        >
          <span class="day-date-tile"><strong>{{ Number(day.dayKey.slice(8, 10)) }}</strong><span>{{ Number(day.dayKey.slice(5, 7)) }} 月</span></span>
          <span class="day-date-copy"><span class="day-item-label">{{ dayLabel(day.dayKey) }}</span><span class="day-weekday">{{ day.dayKey.slice(0, 4) }} · {{ weekdayOf(day.dayKey) }}</span></span>
          <span class="day-item-meta">
            {{ day.eventCount }} 条
            <span
              v-if="day.state === 'DRAFT'"
              class="day-item-draft"
            >还在记</span>
          </span>
        </button>
        <el-pagination
          v-if="daysTotal > daysPageSize"
          class="day-pagination"
          size="small"
          background
          layout="prev, pager, next"
          :current-page="daysPage"
          :page-size="daysPageSize"
          :total="daysTotal"
          @current-change="(page: number) => { daysPage = page; void loadDays(); }"
        />
      </aside>

      <section class="card day-detail">
        <div
          v-if="detailLoading"
          class="muted-note"
        >
          正在读取这一天…
        </div>
        <template v-else-if="detail">
          <header class="day-detail-head">
            <div class="day-title-row">
              <div><span class="day-detail-kicker">{{ selected }} · {{ weekdayOf(selected) }}</span><h2>{{ dayLabel(detail.day?.dayKey ?? selected) }}的经历</h2></div>
              <div
                class="day-stepper"
                aria-label="切换当前页日期"
              >
                <el-button
                  :icon="ArrowLeft"
                  :disabled="selectedDayIndex < 0 || selectedDayIndex >= days.length - 1"
                  aria-label="当前页更早一天"
                  title="当前页更早一天"
                  @click="adjacentDay(1)"
                />
                <el-button
                  :icon="ArrowRight"
                  :disabled="selectedDayIndex <= 0"
                  aria-label="当前页更新一天"
                  title="当前页更新一天"
                  @click="adjacentDay(-1)"
                />
              </div>
            </div>
            <span class="muted-note">
              {{ detail.eventsTotal }} 条忆泡
              <template v-if="detail.day?.extractedAt"> · 上次整理 {{ clockOf(detail.day.extractedAt) }}</template>
              <template v-if="detail.usage.calls">
                · 整理 {{ detail.usage.calls }} 次 · {{ formatTokens(detail.usage.tokens) }} tokens
              </template>
            </span>
            <div class="day-detail-toolbar">
              <span>{{ detail.day?.state === 'FINAL' ? '已完成整理' : detail.day?.state === 'DRAFT' ? '尚未收口，可继续整理' : '尚无整理进度' }} · 当前页 {{ activeEvents.length }} 条可见忆泡</span><el-button
                link
                type="primary"
                :icon="Document"
                @click="toggleMessages"
              >
                {{ showMessages ? '收起当天原文' : '查看当天原文' }}
              </el-button>
            </div>
          </header>

          <div
            v-if="!activeEvents.length"
            class="muted-note day-empty"
          >
            {{ detail.eventsTotal > 0 ? "当前页没有可见的忆泡。" : "这一天还没有整理出忆泡。" }}
          </div>
          <article
            v-for="event in activeEvents"
            :key="event.id"
            class="event-card"
          >
            <div class="event-head">
              <span class="event-time">{{ timeOf(event) }}</span>
              <span
                v-if="event.state === 'DRAFT'"
                class="event-draft"
              >还在记</span>
              <span
                v-if="event.scope === 'private'"
                class="event-private"
              >私人</span>
              <span
                v-if="event.scope === 'external'"
                class="event-external"
              >外部身份</span>
            </div>
            <h3 class="event-title">
              {{ event.title }}
            </h3>
            <p class="event-detail">
              {{ event.detail }}
            </p>
            <div class="event-meta">
              <span v-if="event.place">地点：{{ event.place }}</span>
              <span v-if="event.participants.length">相关：{{ event.participants.join("、") }}</span>
            </div>
            <div class="event-actions">
              <el-button
                v-if="canRequestKnowledge(event)"
                link
                type="primary"
                @click="openKnowledgeRequest(event)"
              >
                提出知识候选
              </el-button>
              <button
                type="button"
                class="btn-link"
                @click="openEdit(event)"
              >
                编辑
              </button>
              <button
                type="button"
                class="btn-link"
                @click="setEventStatus(event, 'ARCHIVED')"
              >
                隐藏
              </button>
            </div>
          </article>

          <div
            v-if="archivedEvents.length"
            class="day-archived"
          >
            <p class="muted-note">
              已隐藏 {{ archivedEvents.length }} 条<template v-if="detail.eventsTotal > detail.eventsPageSize">
                （当前页）
              </template>
            </p>
            <div
              v-for="event in archivedEvents"
              :key="event.id"
              class="archived-line"
            >
              <span class="archived-title">{{ event.title }}</span>
              <button
                type="button"
                class="btn-link"
                @click="setEventStatus(event, 'ACTIVE')"
              >
                恢复
              </button>
            </div>
          </div>

          <el-pagination
            v-if="detail.eventsTotalPages > 1"
            class="event-pagination"
            size="small"
            background
            layout="prev, pager, next, total"
            :current-page="eventsPage"
            :page-size="detail.eventsPageSize"
            :total="detail.eventsTotal"
            @current-change="(page: number) => { eventsPage = page; void loadDetail(selected, id, page); }"
          />

          <div class="day-originals">
            <button
              type="button"
              class="btn"
              @click="toggleMessages"
            >
              {{ showMessages ? "收起原文" : messagesLoadedFor === selected ? `查看当天原文（${totalMessages} 条）` : "查看当天原文" }}
            </button>
            <div
              v-if="showMessages"
              class="original-list"
            >
              <p
                v-if="messagesLoading && !messageGroups.length"
                class="muted-note original-empty"
              >
                正在读取当天原文……
              </p>
              <p
                v-else-if="!messageGroups.length"
                class="muted-note original-empty"
              >
                这一天没有可追溯的对话原文。
              </p>
              <template
                v-for="group in messageGroups"
                :key="group.id"
              >
                <p class="original-group">
                  {{ group.title }}<span class="original-group-n">{{ originalCountLabel(group) }}</span>
                </p>
                <p
                  v-for="message in group.messages"
                  :key="message.id"
                  class="original-line"
                >
                  <span class="original-role">{{ speakerOf(message) }}</span>
                  <span class="original-text">{{ message.content }}</span>
                </p>
              </template>
            </div>
          </div>
        </template>
      </section>
    </div>

    <el-dialog
      :model-value="knowledgeOpen"
      title="提出知识候选"
      width="min(620px, 94vw)"
      @update:model-value="value => { if (!value) closeKnowledgeRequest(); }"
    >
      <p class="muted-note knowledge-note">
        请从这条公开忆泡中选择值得学习的一段原文。提交后由后台派发，请到知识页面整理与确认；不会自动调用模型或入库。
        每条忆泡仅可提出一次，跳过或删除候选后不会自动重建。来源失效或变更将阻止继续整理与采纳；已生成的候选可自行删除，明确入库后的知识独立保留。
      </p>
      <template v-if="knowledgeEvent">
        <p class="knowledge-source-title">
          {{ knowledgeEvent.title }}
        </p>
        <p class="knowledge-source">
          {{ knowledgeEvent.detail }}
        </p>
      </template>
      <el-form label-position="top">
        <el-form-item label="原文摘录（20～2000 字）">
          <el-input
            v-model="knowledgeForm.excerpt"
            type="textarea"
            :rows="5"
            :maxlength="2000"
            show-word-limit
            placeholder="选择上方一段连续原文后复制到这里，或直接填写原文；不要改写或拼接"
          />
        </el-form-item>
        <el-form-item label="提出理由（可选）">
          <el-input
            v-model="knowledgeForm.reason"
            type="textarea"
            :rows="2"
            :maxlength="240"
            show-word-limit
            placeholder="简短说明这段内容为什么值得成为知识候选"
          />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="knowledgeError"
        :title="knowledgeError"
        type="error"
        :closable="false"
        show-icon
      />
      <template #footer>
        <el-button @click="closeKnowledgeRequest">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="knowledgeSaving"
          @click="submitKnowledgeRequest"
        >
          确认提交请求
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="editOpen"
      title="编辑忆泡"
      width="min(560px, 94vw)"
    >
      <el-form
        label-width="72px"
        label-position="left"
      >
        <el-form-item label="标题">
          <el-input
            v-model="form.title"
            maxlength="200"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="详情">
          <el-input
            v-model="form.detail"
            type="textarea"
            :rows="4"
            maxlength="4000"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="地点">
          <el-input
            v-model="form.place"
            maxlength="200"
            placeholder="留空表示不记地点"
          />
        </el-form-item>
        <el-form-item label="人物">
          <el-input
            v-model="form.participants"
            placeholder="用、或逗号分隔，留空表示没有其他人在场"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="editSaving"
          @click="saveEdit"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.knowledge-note { margin: 0 0 14px; font-size: 13px; line-height: 1.7; }
.knowledge-source-title { margin: 0 0 6px; font-size: 14px; font-weight: 600; }
.knowledge-source { max-height: 220px; overflow: auto; white-space: pre-wrap; user-select: text; margin: 0 0 16px; padding: 12px; background: var(--surface-2); border-radius: 8px; font-size: 13px; line-height: 1.8; }
.day-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 18px; margin-top: 18px; }
.day-list { padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.day-list-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.day-list-head h2 { font-size: 14px; font-weight: 600; color: var(--text-2); }
.day-search { margin: 6px 0 2px; }
.day-pagination { justify-content: center; margin-top: 10px; }
.event-pagination { justify-content: flex-end; margin: 14px 0; }
.day-item { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 9px 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; cursor: pointer; text-align: left; }
.day-item:hover { background: var(--surface-2, #f6f7fb); }
.day-item.active { background: var(--surface-2, #f6f7fb); border-color: var(--line); }
.day-item-label { font-size: 13px; color: var(--text-2); }
.day-item-meta { font-size: 12px; color: var(--faint); display: inline-flex; gap: 6px; align-items: center; }
.day-item-draft { padding: 1px 6px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 12px; }
.day-detail { padding: 18px; }
.day-detail-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.day-detail-head h2 { font-size: 16px; font-weight: 600; color: var(--text-2); }
.day-empty { padding: 12px 0; }
.event-card { border-top: 1px solid var(--line); padding: 14px 0; }
.event-card:first-of-type { border-top: 0; }
.event-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--faint); }
.event-draft { padding: 1px 6px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 12px; }
.event-private { padding: 1px 6px; border-radius: 999px; background: #ede9fe; color: #5b21b6; font-size: 12px; }
.event-external { padding: 1px 6px; border-radius: 999px; background: #e0f2fe; color: #075985; font-size: 12px; }
.event-title { font-size: 14px; font-weight: 600; color: var(--text-2); margin-top: 4px; }
.event-detail { font-size: 13px; color: var(--dim); line-height: 1.8; margin-top: 4px; }
.event-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--faint); margin-top: 6px; }
.event-actions { display: flex; gap: 12px; margin-top: 8px; }
.btn-link { background: none; border: 0; padding: 0; color: var(--dim); font-size: 12px; cursor: pointer; }
.btn-link:hover { color: var(--text-2); text-decoration: underline; }
.day-archived { margin-top: 14px; border-top: 1px dashed var(--line); padding-top: 10px; }
.archived-line { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; }
.archived-title { font-size: 13px; color: var(--faint); }
.day-originals { margin-top: 16px; border-top: 1px dashed var(--line); padding-top: 14px; }
.original-list { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.original-empty { margin: 0; padding: 10px 12px; border-radius: 8px; background: var(--surface-2); }
.original-group { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--text-2); }
.original-group-n { font-weight: 400; color: var(--faint); font-size: 12px; }
.original-line { display: flex; gap: 8px; font-size: 13px; line-height: 1.7; }
/* 定宽而不是自适应：昵称长短不一时，正文那列才不会左右跳。 */
.original-role { flex: 0 0 6.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-size: 12px; }
.original-text { color: var(--dim); }
@media (max-width: 900px) {
  .day-layout { grid-template-columns: 1fr; }
}
.day-context { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin: 0 0 16px; color: var(--dim); font-size: 12px; }
.day-context > span:first-child { display: inline-flex; align-items: center; gap: 7px; color: var(--text-2); font-weight: 500; }
.card { border: 0; border-radius: 12px; box-shadow: none; }
.day-layout { grid-template-columns: 290px minmax(0, 1fr); align-items: start; margin-top: 0; }
.day-list { position: sticky; top: 20px; padding: 18px 14px; max-height: calc(100dvh - 130px); overflow-y: auto; }
.day-list-head { padding: 0 4px; }
.day-list-head h2 { margin: 0; }
.day-search { margin: 10px 0; }
.day-item { min-height: 78px; padding: 10px 8px; gap: 10px; flex: none; }
.day-item.active { border-color: var(--brand-line); background: var(--brand-soft); }
.day-date-tile { display: flex; width: 44px; min-height: 52px; flex: none; flex-direction: column; align-items: center; justify-content: center; gap: 2px; border-radius: 9px; background: var(--surface-2); color: var(--text-2); }
.day-date-tile strong { font-size: 21px; font-weight: 600; line-height: 1.1; }
.day-date-tile > span { font-size: 12px; }
.active .day-date-tile { background: var(--surface); color: var(--brand-strong); }
.day-date-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 6px; }
.day-item-label { font-weight: 600; }
.day-weekday { font-size: 12px; color: var(--dim); }
.day-item-meta { flex-direction: column; align-items: flex-end; color: var(--dim); }
.day-detail { padding: 24px 28px; min-height: 440px; }
.day-detail-head { display: block; border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 18px; }
.day-title-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.day-detail-kicker { color: var(--dim); font-size: 12px; }
.day-detail-head h2 { margin: 8px 0 0; font-size: 23px; }
.day-detail-head > .muted-note { display: block; color: var(--dim); line-height: 1.9; }
.day-stepper { display: flex; flex: none; gap: 6px; }
.day-stepper .el-button { margin: 0; padding: 8px; }
.day-detail-toolbar { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 14px; border-radius: 8px; background: var(--surface-2); padding: 10px 12px; color: var(--dim); font-size: 12px; }
.event-card { position: relative; border-top: 0; border-left: 1px solid var(--line); margin-left: 5px; padding: 0 0 26px 22px; }
.event-card::before { content: ''; position: absolute; top: 5px; left: -5px; width: 9px; height: 9px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 0 4px var(--surface); }
.event-head { color: var(--dim); flex-wrap: wrap; }
.event-time { color: var(--brand-strong); font-variant-numeric: tabular-nums; }
.event-title { margin: 10px 0 8px; font-size: 16px; line-height: 1.6; overflow-wrap: anywhere; }
.event-detail { margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.95; white-space: pre-wrap; overflow-wrap: anywhere; }
.event-meta { color: var(--dim); margin-top: 12px; line-height: 1.8; }
.event-actions { align-items: center; justify-content: flex-end; flex-wrap: wrap; border-radius: 8px; background: var(--surface-2); padding: 8px 12px; margin-top: 14px; }
.day-originals { border-top-style: solid; }
.original-list { border-radius: 10px; background: var(--surface-2); padding: 16px; }
.original-group { flex-wrap: wrap; }
.original-line { border-radius: 8px; background: var(--surface); padding: 10px 12px; margin: 0; }
.original-text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.original-role, .original-group-n, .archived-title { color: var(--dim); }
.day-item:focus-visible, .btn-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (max-width: 1050px) { .day-layout { grid-template-columns: 245px minmax(0, 1fr); gap: 14px; } .day-detail { padding: 20px; } }
@media (max-width: 760px) { .day-layout { grid-template-columns: 1fr; } .day-list { position: static; max-height: 350px; } .day-detail { padding: 18px; } .day-detail-head h2 { font-size: 20px; } .event-card { padding-left: 16px; } .original-line { flex-direction: column; gap: 4px; } .original-role { flex-basis: auto; } }
</style>
