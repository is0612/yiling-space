<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowRight, Clock, EditPen, MagicStick, Refresh } from "@element-plus/icons-vue";
import type { Character } from "~/utils/mock-data";

// 标题归顶栏（AppShell 读 route.meta.topbar）；正文不再重复一遍面包屑和说明行。
definePageMeta({
  topbar: { title: "日记与手账" },
});

/**
 * 日记 / 手账：同一天的两份独立文本。
 *
 * - 日记：第一人称叙事，读今天经历了什么。
 * - 手账：结构化记录（片段 / 想法 / 一句 / 灵感 / 待续），读今天留下了什么。
 *
 * 两份各自版本、各自编辑/重写；手账的「一句」摘自某一版日记。
 */
await useCharacterListData();
const route = useRoute();
const { id } = useCharacterSelection("/journal");
const requestFetch = useRequestFetch();

type JournalKind = "DIARY" | "HANDBOOK";
type JournalListItem = {
  id: string;
  dayKey: string;
  status: "ACTIVE" | "SKIPPED";
  diaryTitle: string | null;
  diaryFirstLine: string;
  handbookQuote: string | null;
  diaryVersion: number;
  handbookVersion: number;
  updatedAt: string;
};
type JournalRevision = {
  id: string;
  kind: JournalKind;
  version: number;
  title: string | null;
  content: string;
  thought: string | null;
  quote: string | null;
  tags: string[];
  sourceDiaryRevisionId: string | null;
  sourceDiaryVersion: number | null;
  revisionType: string;
  promptVersion: string | null;
  model: string | null;
  editedByUserId: string | null;
  createdAt: string;
  sources: { messages: number; events: number };
};
type JournalDetail = {
  id: string;
  dayKey: string;
  status: "ACTIVE" | "SKIPPED";
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
  diaryState: "PENDING" | "GENERATED" | "SKIPPED";
  handbookState: "PENDING" | "GENERATED" | "SKIPPED";
  diaryDecidedAt: string | null;
  handbookDecidedAt: string | null;
  revisionCounts: { diary: number; handbook: number };
  diary: JournalRevision | null;
  handbook: JournalRevision | null;
};
type JournalPage = {
  items: JournalListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  timeZone: string;
  todayKey: string;
  yesterdayKey: string;
};
type HandbookSection = { title: string; lines: string[] };

const PAGE_SIZE = 20;
const characters = useCharacterList();
const currentCharacter = computed<Character | null>(
  () => characters.value.find((item) => item.id === id.value) ?? null,
);

const items = ref<JournalListItem[]>([]);
const page = ref(1);
const total = ref(0);
const totalPages = ref(1);
const loading = ref(false);
const month = ref<string | null>("");
const selectedDay = ref("");
const detail = ref<JournalDetail | null>(null);
const detailLoading = ref(false);
const activeTab = ref<JournalKind>("DIARY");

const writeDay = ref("");
const writeDayTouched = ref(false);
const writing = ref(false);
const regenerating = ref(false);
const journalTimeZone = ref("Asia/Shanghai");
const todayKey = ref("");
const yesterdayKey = ref("");

const editOpen = ref(false);
const editSaving = ref(false);
const editKind = ref<JournalKind>("DIARY");
const form = reactive({ title: "", content: "", thought: "", quote: "", tags: "" });

const historyOpen = ref(false);
const historyLoading = ref(false);
const historyKind = ref<JournalKind>("DIARY");
const revisions = ref<JournalRevision[]>([]);
const restoring = ref(false);
const detailCharacterId = ref("");
const editTarget = ref<{ characterId: string; dayKey: string } | null>(null);
const historyTarget = ref<{ characterId: string; dayKey: string; kind: JournalKind } | null>(null);

// 每种异步操作独立序号：旧角色/旧日期/旧弹窗的响应不能覆盖当前页面。
let suppressNextPageReload = false;
let listRequestSeq = 0;
let detailRequestSeq = 0;
let historyRequestSeq = 0;
let writeRequestSeq = 0;
let regenerateRequestSeq = 0;
let editRequestSeq = 0;
let restoreRequestSeq = 0;

function markWriteDayTouched(): void {
  writeDayTouched.value = true;
}

/** 拆日期。星期是日历属性，一律用 UTC 构造，避免浏览器本地时区把日期挪一天。 */
function dayParts(dayKey: string): { year: number; month: number; date: number } | null {
  const [year, month, date] = dayKey.split("-").map(Number);
  if (!year || !month || !date) return null;
  return { year, month, date };
}

function weekdayShort(dayKey: string): string {
  const parts = dayParts(dayKey);
  if (!parts) return "";
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.date)).getUTCDay();
  return `周${["日", "一", "二", "三", "四", "五", "六"][weekday]}`;
}

/** 列表左栏只放「日」这个数字，年月交给分组标题，不在每一行重复。 */
function dayNumber(dayKey: string): string {
  return String(dayParts(dayKey)?.date ?? "");
}

function yearMonthLabel(dayKey: string): string {
  const parts = dayParts(dayKey);
  return parts ? `${parts.year} 年 ${parts.month} 月` : dayKey;
}

/** 今天 / 昨天是辅助标记，不替代正式日期。 */
function relativeFlag(dayKey: string): string {
  if (dayKey === todayKey.value) return "今天";
  if (dayKey === yesterdayKey.value) return "昨天";
  return "";
}

function dayLabel(dayKey: string): string {
  if (relativeFlag(dayKey)) return relativeFlag(dayKey);
  const parts = dayParts(dayKey);
  if (!parts) return dayKey;
  return `${parts.month} 月 ${parts.date} 日 · ${weekdayShort(dayKey)}`;
}

/** 版本时间也按角色时区显示，不跟浏览器走。 */
function clockOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: journalTimeZone.value,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("month")}-${read("day")} ${read("hour")}:${read("minute")}`;
}

function revisionTypeLabel(type: string): string {
  return {
    AI_GENERATED: "第一次写的",
    AI_REWRITE: "重新写的",
    USER_EDITED: "我改过的",
    RESTORED: "从旧版恢复的",
  }[type] ?? type;
}

function kindLabel(kind: JournalKind): string {
  return kind === "DIARY" ? "日记" : "手账";
}

function readError(error: unknown): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return "操作失败，请检查本地开发服务器日志。";
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "statusCode" in error && (error as { statusCode?: number }).statusCode === 404);
}

/** 手账正文里的 `## 小标题` 拆成栏目；格式被改乱了就退回整段显示。 */
function splitHandbook(content: string): HandbookSection[] | null {
  const sections: HandbookSection[] = [];
  let current: HandbookSection | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1]) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) return null;
    current.lines.push(line.replace(/^[-*]\s+/, ""));
  }
  return sections.length ? sections : null;
}

const handbookSections = computed<HandbookSection[] | null>(() => {
  const content = detail.value?.handbook?.content ?? "";
  return content ? splitHandbook(content) : null;
});

type DayGroup = { month: string; label: string; items: JournalListItem[] };

/** 列表按月份分组：跨月的一长串日子混在一起，读不出节奏。 */
const dayGroups = computed<DayGroup[]>(() => {
  const groups: DayGroup[] = [];
  for (const item of items.value) {
    const monthKey = item.dayKey.slice(0, 7);
    let group = groups[groups.length - 1];
    if (!group || group.month !== monthKey) {
      const [year, monthValue] = monthKey.split("-");
      group = { month: monthKey, label: `${year} 年 ${Number(monthValue)} 月`, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
});

/** 页头操作跟着当前 tab 走：一个入口，不再按两份文本各摊一套按钮。 */
const activeRevision = computed<JournalRevision | null>(() => {
  if (!detail.value) return null;
  return activeTab.value === "DIARY" ? detail.value.diary : detail.value.handbook;
});

const activeRevisionCount = computed(() => {
  if (!detail.value) return 0;
  return activeTab.value === "DIARY" ? detail.value.revisionCounts.diary : detail.value.revisionCounts.handbook;
});

async function loadList(keepSelection = false, targetCharacterId = id.value): Promise<void> {
  const seq = ++listRequestSeq;
  const targetPage = page.value;
  const targetMonth = month.value;
  if (!targetCharacterId) {
    items.value = [];
    total.value = 0;
    totalPages.value = 1;
    return;
  }
  loading.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals`;
    const result = await requestFetch<JournalPage>(url, {
      query: {
        page: targetPage,
        pageSize: PAGE_SIZE,
        ...(targetMonth ? { month: targetMonth } : {}),
      },
    });
    if (seq !== listRequestSeq || targetCharacterId !== id.value || targetPage !== page.value || targetMonth !== month.value) return;

    items.value = result.items;
    total.value = result.total;
    totalPages.value = result.totalPages;
    journalTimeZone.value = result.timeZone || "Asia/Shanghai";
    todayKey.value = result.todayKey || "";
    yesterdayKey.value = result.yesterdayKey || "";
    if (!writeDayTouched.value) writeDay.value = yesterdayKey.value;

    const selectedExists = items.value.some((item) => item.dayKey === selectedDay.value);
    if (!keepSelection && !selectedExists) {
      // 初次进入 / 换角色：默认选最新一天；这里显式加载详情，保证首屏左右两栏完整。
      selectedDay.value = items.value[0]?.dayKey ?? "";
    }
    if (!items.value.length) {
      selectedDay.value = "";
      detailRequestSeq += 1;
      detail.value = null;
      detailCharacterId.value = "";
      detailLoading.value = false;
    } else if (selectedDay.value) {
      await loadDetail(selectedDay.value, targetCharacterId);
    }
  } catch {
    if (seq !== listRequestSeq || targetCharacterId !== id.value) return;
    items.value = [];
    total.value = 0;
    totalPages.value = 1;
    detailRequestSeq += 1;
    detail.value = null;
    detailCharacterId.value = "";
    detailLoading.value = false;
    ElMessage.error("日记/手账读取失败，请检查本地开发服务器日志。");
  } finally {
    if (seq === listRequestSeq) loading.value = false;
  }
}

function selectDay(dayKey: string): void {
  if (!dayKey || dayKey === selectedDay.value) return;
  selectedDay.value = dayKey;
  void loadDetail(dayKey, id.value);
}

async function loadDetail(dayKey: string, targetCharacterId = id.value): Promise<void> {
  const seq = ++detailRequestSeq;
  if (!targetCharacterId || !dayKey) {
    detail.value = null;
    detailCharacterId.value = "";
    detailLoading.value = false;
    return;
  }
  detailLoading.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals/${encodeURIComponent(dayKey)}`;
    const result = await requestFetch<JournalDetail>(url);
    if (seq !== detailRequestSeq || targetCharacterId !== id.value || dayKey !== selectedDay.value) return;
    detail.value = result;
    detailCharacterId.value = targetCharacterId;
    // 只有一份时默认切到有的那一份，别让人对着空 tab 发呆。
    if (!detail.value.diary && detail.value.handbook) activeTab.value = "HANDBOOK";
    else if (!detail.value.handbook && detail.value.diary) activeTab.value = "DIARY";
  } catch (error) {
    if (seq !== detailRequestSeq || targetCharacterId !== id.value || dayKey !== selectedDay.value) return;
    if (!isNotFound(error)) ElMessage.error("这一天的日记/手账读取失败。");
    detail.value = null;
    detailCharacterId.value = "";
  } finally {
    if (seq === detailRequestSeq) detailLoading.value = false;
  }
}


async function writeDayNow(target: JournalKind | "BOTH" = "BOTH"): Promise<void> {
  const targetCharacterId = id.value;
  const dayKey = writeDay.value;
  if (!targetCharacterId || !dayKey || writing.value) return;
  const seq = ++writeRequestSeq;
  const selectionAtStart = selectedDay.value;
  writing.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals`;
    const result = await requestFetch<{ status: string; reason?: string }>(url, {
      method: "POST",
      body: { dayKey, target },
    });
    if (seq !== writeRequestSeq || targetCharacterId !== id.value) return;
    if (result.status === "created") ElMessage.success("写好了。");
    else ElMessage.info(result.reason || "这一天她没写。");
    if (selectedDay.value === selectionAtStart) {
      selectedDay.value = dayKey;
      page.value = 1;
    }
    await loadList(true, targetCharacterId);
  } catch (error) {
    if (seq === writeRequestSeq && targetCharacterId === id.value) ElMessage.error(readError(error));
  } finally {
    if (seq === writeRequestSeq) writing.value = false;
  }
}

async function writeCurrent(kind: JournalKind): Promise<void> {
  const targetCharacterId = id.value;
  const dayKey = selectedDay.value;
  if (!targetCharacterId || !dayKey || writing.value) return;
  const seq = ++writeRequestSeq;
  writing.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals`;
    const result = await requestFetch<{ status: string; reason?: string }>(url, {
      method: "POST",
      body: { dayKey, target: kind },
    });
    if (seq !== writeRequestSeq || targetCharacterId !== id.value) return;
    if (result.status === "created") ElMessage.success(`${kindLabel(kind)}写好了。`);
    else ElMessage.info(result.reason || `这一天她没写${kindLabel(kind)}。`);
    await loadList(true, targetCharacterId);
  } catch (error) {
    if (seq === writeRequestSeq && targetCharacterId === id.value) ElMessage.error(readError(error));
  } finally {
    if (seq === writeRequestSeq) writing.value = false;
  }
}

async function regenerate(kind: JournalKind): Promise<void> {
  const targetCharacterId = id.value;
  const dayKey = selectedDay.value;
  if (!targetCharacterId || !dayKey || regenerating.value) return;
  try {
    await ElMessageBox.confirm(
      `会重新读这一天的对话，写一个新的${kindLabel(kind)}版本；现在这一版仍保留在「历史版本」里。另一份不会动。`,
      `重写${kindLabel(kind)}？`,
      { type: "warning", confirmButtonText: "重写", cancelButtonText: "再想想" },
    );
  } catch {
    return;
  }
  // 确认框等待期间可能切换角色或日期，不能把旧页面的确认带到新角色。
  if (targetCharacterId !== id.value || dayKey !== selectedDay.value) return;
  const seq = ++regenerateRequestSeq;
  regenerating.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals/${encodeURIComponent(dayKey)}/regenerate`;
    const result = await requestFetch<{ status: string; reason?: string }>(url, {
      method: "POST",
      body: { target: kind },
    });
    if (seq !== regenerateRequestSeq || targetCharacterId !== id.value) return;
    if (result.status === "created") ElMessage.success(`${kindLabel(kind)}重写好了。`);
    else ElMessage.info(result.reason || `这一天她没写${kindLabel(kind)}。`);
    await loadList(true, targetCharacterId);
  } catch (error) {
    if (seq === regenerateRequestSeq && targetCharacterId === id.value) ElMessage.error(readError(error));
  } finally {
    if (seq === regenerateRequestSeq) regenerating.value = false;
  }
}

function openEdit(kind: JournalKind): void {
  const revision = kind === "DIARY" ? detail.value?.diary : detail.value?.handbook;
  if (!revision || !detail.value || detailCharacterId.value !== id.value || detail.value.dayKey !== selectedDay.value) return;
  editKind.value = kind;
  editTarget.value = { characterId: id.value, dayKey: detail.value.dayKey };
  form.title = revision.title ?? "";
  form.content = revision.content;
  form.thought = revision.thought ?? "";
  form.quote = revision.quote ?? "";
  form.tags = revision.tags.join("、");
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  const target = editTarget.value;
  if (!target || target.characterId !== id.value || editSaving.value) return;
  const seq = ++editRequestSeq;
  const payload = {
    kind: editKind.value,
    title: form.title,
    content: form.content,
    thought: form.thought,
    quote: form.quote,
    tags: form.tags.split(/[、,，]/u).map((tag) => tag.trim()).filter(Boolean),
  };
  editSaving.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(target.characterId)}/journals/${encodeURIComponent(target.dayKey)}`;
    await requestFetch(url, { method: "PATCH", body: payload });
    if (seq !== editRequestSeq || target.characterId !== id.value || editTarget.value?.dayKey !== target.dayKey) return;
    editOpen.value = false;
    editTarget.value = null;
    ElMessage.success("保存好了，旧版本还在历史里。");
    await loadList(true, target.characterId);
  } catch (error) {
    if (seq === editRequestSeq && target.characterId === id.value) ElMessage.error(readError(error));
  } finally {
    if (seq === editRequestSeq) editSaving.value = false;
  }
}

async function openHistory(kind: JournalKind): Promise<void> {
  const targetCharacterId = id.value;
  const dayKey = selectedDay.value;
  if (!targetCharacterId || !dayKey || detailCharacterId.value !== targetCharacterId) return;
  const seq = ++historyRequestSeq;
  historyKind.value = kind;
  historyTarget.value = { characterId: targetCharacterId, dayKey, kind };
  historyOpen.value = true;
  historyLoading.value = true;
  revisions.value = [];
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals/${encodeURIComponent(dayKey)}/revisions`;
    const result = await requestFetch<{ items: JournalRevision[] }>(url, { query: { kind } });
    if (seq !== historyRequestSeq || targetCharacterId !== id.value || historyTarget.value?.dayKey !== dayKey || historyTarget.value?.kind !== kind) return;
    revisions.value = result.items;
  } catch (error) {
    if (seq !== historyRequestSeq || targetCharacterId !== id.value) return;
    revisions.value = [];
    ElMessage.error(readError(error));
  } finally {
    if (seq === historyRequestSeq) historyLoading.value = false;
  }
}

async function restoreRevision(version: number): Promise<void> {
  const target = historyTarget.value;
  if (!target || target.characterId !== id.value || restoring.value) return;
  const { characterId: targetCharacterId, dayKey, kind } = target;
  try {
    await ElMessageBox.confirm(
      `会把${kindLabel(kind)}换成第 ${version} 版，并记成一个新版本；后面的版本不会消失。另一份不会动。`,
      "恢复这一版？",
      { type: "warning", confirmButtonText: "恢复", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  if (targetCharacterId !== id.value || historyTarget.value?.dayKey !== dayKey || historyTarget.value?.kind !== kind) return;
  const seq = ++restoreRequestSeq;
  restoring.value = true;
  try {
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/journals/${encodeURIComponent(dayKey)}/restore`;
    await requestFetch(url, { method: "POST", body: { kind, version } });
    if (seq !== restoreRequestSeq || targetCharacterId !== id.value) return;
    ElMessage.success("恢复好了，历史里还能看到原来的版本。");
    if (selectedDay.value === dayKey) await openHistory(kind);
    await loadList(true, targetCharacterId);
  } catch (error) {
    if (seq === restoreRequestSeq && targetCharacterId === id.value) ElMessage.error(readError(error));
  } finally {
    if (seq === restoreRequestSeq) restoring.value = false;
  }
}

watch(id, () => {
  // 角色切换立即作废旧请求与旧弹窗，避免旧角色的日记/历史留在新角色页面。
  listRequestSeq += 1;
  detailRequestSeq += 1;
  historyRequestSeq += 1;
  writeRequestSeq += 1;
  regenerateRequestSeq += 1;
  editRequestSeq += 1;
  restoreRequestSeq += 1;
  items.value = [];
  selectedDay.value = "";
  detail.value = null;
  detailCharacterId.value = "";
  if (page.value !== 1) {
    // 角色切换本身会重新加载列表；阻止 page watcher 再用 keepSelection=true 覆盖它。
    suppressNextPageReload = true;
    page.value = 1;
  }
  writeDay.value = "";
  writeDayTouched.value = false;
  revisions.value = [];
  historyTarget.value = null;
  historyOpen.value = false;
  historyLoading.value = false;
  editTarget.value = null;
  editOpen.value = false;
  editSaving.value = false;
  writing.value = false;
  regenerating.value = false;
  restoring.value = false;
  loading.value = false;
  detailLoading.value = false;
  void loadList(false, id.value);
});
watch(page, () => {
  if (suppressNextPageReload) {
    suppressNextPageReload = false;
    return;
  }
  if (page.value < 1) {
    page.value = 1;
    return;
  }
  void loadList(true, id.value);
});
watch(month, () => {
  // 月份过滤改变后，页码与选中日期都应重新定位到该月份的最新一条。
  if (page.value !== 1) {
    suppressNextPageReload = true;
    page.value = 1;
  }
  void loadList(false, id.value);
});
onBeforeUnmount(() => {
  listRequestSeq += 1;
  detailRequestSeq += 1;
  historyRequestSeq += 1;
  writeRequestSeq += 1;
  regenerateRequestSeq += 1;
  editRequestSeq += 1;
  restoreRequestSeq += 1;
});

await loadList();
</script>

<template>
  <div class="page-wrap journal-page">
    <section
      v-if="currentCharacter"
      class="write-strip"
    >
      <span
        class="write-badge"
        aria-hidden="true"
      >
        <el-icon><MagicStick /></el-icon>
      </span>
      <div class="write-copy">
        <p class="write-title">
          补写某一天
        </p>
        <p class="write-sub">
          挑一个日子，让她按那天的对话补上日记与手账。
        </p>
      </div>
      <div class="write-form">
        <el-date-picker
          v-model="writeDay"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          style="width: 148px"
          @change="markWriteDayTouched"
        />
        <el-button
          type="primary"
          :loading="writing"
          @click="writeDayNow('BOTH')"
        >
          让她写这一天
        </el-button>
      </div>
    </section>

    <div
      v-if="!currentCharacter"
      class="no-character"
    >
      <p class="no-character-title">
        还没有角色
      </p>
      <p class="muted-note">
        先建一个角色，日记与手账才有归属。
      </p>
    </div>

    <div
      v-else
      class="journal-grid"
    >
      <aside class="rail">
        <div class="rail-head">
          <div class="rail-title">
            <h2>写过的日子</h2>
            <span class="rail-count">{{ total }} 天</span>
          </div>
          <el-date-picker
            v-model="month"
            type="month"
            value-format="YYYY-MM"
            placeholder="全部月份"
            clearable
            class="rail-month"
          />
        </div>

        <div class="rail-body">
          <p
            v-if="loading"
            class="rail-state"
          >
            正在读取…
          </p>
          <p
            v-else-if="!items.length"
            class="rail-state"
          >
            还没有日记或手账。挑一个日期，点上面的「让她写这一天」试试。
          </p>

          <div
            v-for="group in dayGroups"
            :key="group.month"
            class="day-group"
          >
            <p class="day-group-label">
              {{ group.label }}
            </p>
            <button
              v-for="item in group.items"
              :key="item.id"
              type="button"
              class="day-row"
              :class="{ active: item.dayKey === selectedDay }"
              @click="selectDay(item.dayKey)"
            >
              <span class="day-date">
                <b class="day-num">{{ dayNumber(item.dayKey) }}</b>
                <i class="day-wd">{{ weekdayShort(item.dayKey) }}</i>
              </span>
              <span class="day-body">
                <span class="day-top">
                  <span
                    v-if="relativeFlag(item.dayKey)"
                    class="day-flag"
                  >{{ relativeFlag(item.dayKey) }}</span>
                  <span class="day-marks">
                    <span
                      v-if="item.diaryVersion"
                      class="mark mark-diary"
                    >日记</span>
                    <span
                      v-if="item.handbookVersion"
                      class="mark mark-handbook"
                    >手账</span>
                  </span>
                </span>
                <span
                  class="day-excerpt"
                  :class="{ 'is-empty': !item.diaryFirstLine }"
                >{{ item.diaryFirstLine || (item.handbookVersion ? "这一天只有手账。" : "这一天没有日记。") }}</span>
                <span
                  v-if="item.handbookQuote"
                  class="day-quote"
                >「{{ item.handbookQuote }}」</span>
              </span>
            </button>
          </div>
        </div>

        <div
          v-if="total > 0"
          class="rail-foot"
        >
          <PagerBar
            :page="page"
            :total-pages="totalPages"
            :total="total"
            :page-size="PAGE_SIZE"
            unit="天"
            flush
            @update:page="page = $event"
          />
        </div>
      </aside>

      <section class="reader">
        <p
          v-if="detailLoading"
          class="reader-state"
        >
          正在读取这一天…
        </p>

        <template v-else-if="detail">
          <header class="reader-head">
            <span class="reader-day">{{ dayNumber(detail.dayKey) }}</span>
            <div class="reader-when">
              <p class="reader-month">
                {{ yearMonthLabel(detail.dayKey) }} · {{ weekdayShort(detail.dayKey) }}
                <span
                  v-if="relativeFlag(detail.dayKey)"
                  class="reader-flag"
                >{{ relativeFlag(detail.dayKey) }}</span>
              </p>
              <p class="reader-sub">
                更新于 {{ clockOf(detail.updatedAt) }}
              </p>
            </div>
            <el-tag
              class="reader-status"
              size="small"
              effect="plain"
              :type="detail.status === 'ACTIVE' ? 'success' : 'info'"
            >
              {{ detail.status === "ACTIVE" ? "写过了" : "没写" }}
            </el-tag>
          </header>

          <div class="reader-bar">
            <div
              class="kind-switch"
              role="tablist"
              aria-label="日记与手账"
            >
              <button
                type="button"
                role="tab"
                class="kind-tab"
                :class="{ active: activeTab === 'DIARY' }"
                :aria-selected="activeTab === 'DIARY'"
                @click="activeTab = 'DIARY'"
              >
                日记
              </button>
              <button
                type="button"
                role="tab"
                class="kind-tab"
                :class="{ active: activeTab === 'HANDBOOK' }"
                :aria-selected="activeTab === 'HANDBOOK'"
                @click="activeTab = 'HANDBOOK'"
              >
                手账
              </button>
            </div>

            <div class="reader-ops">
              <template v-if="activeRevision">
                <el-button
                  text
                  size="small"
                  @click="openEdit(activeTab)"
                >
                  <el-icon><EditPen /></el-icon>编辑
                </el-button>
                <el-button
                  text
                  size="small"
                  :loading="regenerating"
                  @click="regenerate(activeTab)"
                >
                  <el-icon><Refresh /></el-icon>重写
                </el-button>
                <el-button
                  text
                  size="small"
                  @click="openHistory(activeTab)"
                >
                  <el-icon><Clock /></el-icon>历史 {{ activeRevisionCount }}
                </el-button>
              </template>
            </div>
          </div>

          <div class="reader-body">
            <div
              v-if="detail.status === 'SKIPPED' && !detail.diary && !detail.handbook"
              class="skip-note"
            >
              <p>这一天她没写日记，也没写手账。</p>
              <p class="skip-reason">
                {{ detail.skipReason || "没有什么值得记的事。" }}
              </p>
            </div>

            <template v-if="activeTab === 'DIARY'">
              <template v-if="detail.diary">
                <article class="sheet">
                  <h3
                    v-if="detail.diary.title"
                    class="sheet-title"
                  >
                    {{ detail.diary.title }}
                  </h3>
                  <div class="sheet-body">
                    {{ detail.diary.content }}
                  </div>
                </article>
                <p class="sheet-meta">
                  第 {{ detail.diary.version }} 版 · {{ revisionTypeLabel(detail.diary.revisionType) }} ·
                  来源：对话 {{ detail.diary.sources.messages }} 条 · 忆泡 {{ detail.diary.sources.events }} 条
                </p>
              </template>
              <div
                v-else
                class="reader-empty"
              >
                <p>这一天还没有日记。</p>
                <el-button
                  type="primary"
                  plain
                  :loading="writing"
                  @click="writeCurrent('DIARY')"
                >
                  写日记
                </el-button>
              </div>
            </template>

            <template v-else>
              <template v-if="detail.handbook">
                <article
                  v-if="detail.handbook.content"
                  class="sheet"
                >
                  <template v-if="handbookSections">
                    <section
                      v-for="section in handbookSections"
                      :key="section.title"
                      class="hb-block"
                    >
                      <h4>{{ section.title }}</h4>
                      <ul>
                        <li
                          v-for="(line, index) in section.lines"
                          :key="`${section.title}-${index}`"
                        >
                          {{ line }}
                        </li>
                      </ul>
                    </section>
                  </template>
                  <div
                    v-else
                    class="sheet-body"
                  >
                    {{ detail.handbook.content }}
                  </div>
                </article>

                <article
                  v-if="detail.handbook.thought"
                  class="thought-card"
                >
                  <h4 class="block-title">
                    今日想法
                  </h4>
                  <p class="thought">
                    {{ detail.handbook.thought }}
                  </p>
                </article>

                <blockquote
                  v-if="detail.handbook.quote"
                  class="quote-card"
                >
                  <p class="quote-text">
                    {{ detail.handbook.quote }}
                  </p>
                  <p class="quote-note">
                    摘自日记{{ detail.handbook.sourceDiaryVersion ? `第 ${detail.handbook.sourceDiaryVersion} 版` : "正文" }}，不是另写的。
                  </p>
                </blockquote>

                <div
                  v-if="detail.handbook.tags.length"
                  class="tag-row"
                >
                  <el-tag
                    v-for="tag in detail.handbook.tags"
                    :key="tag"
                    size="small"
                    effect="plain"
                    round
                  >
                    {{ tag }}
                  </el-tag>
                </div>

                <p class="sheet-meta">
                  第 {{ detail.handbook.version }} 版 · {{ revisionTypeLabel(detail.handbook.revisionType) }} ·
                  来源：对话 {{ detail.handbook.sources.messages }} 条 · 忆泡 {{ detail.handbook.sources.events }} 条
                </p>
              </template>
              <div
                v-else
                class="reader-empty"
              >
                <p>这一天还没有手账。</p>
                <el-button
                  type="primary"
                  plain
                  :loading="writing"
                  @click="writeCurrent('HANDBOOK')"
                >
                  写手账
                </el-button>
              </div>
            </template>
          </div>

          <footer class="reader-foot">
            <NuxtLink
              class="reader-link"
              :to="{ path: '/growth/memory/events', query: { ...route.query, c: id } }"
            >
              去看那天的忆泡
              <el-icon><ArrowRight /></el-icon>
            </NuxtLink>
          </footer>
        </template>

        <div
          v-else
          class="reader-state reader-state-empty"
        >
          <p>{{ selectedDay ? `${dayLabel(selectedDay)}还没有日记或手账。` : "选中左边的一天，或补写某一天。" }}</p>
        </div>
      </section>
    </div>

    <el-dialog
      v-model="editOpen"
      :title="`编辑${kindLabel(editKind)}`"
      width="640px"
    >
      <el-form
        label-width="64px"
        label-position="left"
      >
        <el-form-item
          v-if="editKind === 'DIARY'"
          label="标题"
        >
          <el-input
            v-model="form.title"
            maxlength="120"
            placeholder="可留空"
          />
        </el-form-item>
        <el-form-item :label="kindLabel(editKind)">
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="10"
            :maxlength="editKind === 'DIARY' ? 2000 : 1500"
            show-word-limit
          />
        </el-form-item>
        <template v-if="editKind === 'HANDBOOK'">
          <el-form-item label="想法">
            <el-input
              v-model="form.thought"
              type="textarea"
              :rows="3"
              maxlength="300"
              placeholder="可留空"
            />
          </el-form-item>
          <el-form-item label="一句">
            <el-input
              v-model="form.quote"
              maxlength="120"
              placeholder="必须是日记正文里的原话；留空表示没有"
            />
          </el-form-item>
          <el-form-item label="标签">
            <el-input
              v-model="form.tags"
              maxlength="120"
              placeholder="用、分开；可留空"
            />
          </el-form-item>
        </template>
      </el-form>
      <p class="dialog-note">
        保存会写成新版本，旧版本仍留在「历史」里可恢复。
      </p>
      <template #footer>
        <el-button @click="editOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="editSaving"
          @click="saveEdit"
        >
          保存为新版本
        </el-button>
      </template>
    </el-dialog>

    <el-drawer
      v-model="historyOpen"
      :title="`${kindLabel(historyKind)}历史版本`"
      size="440px"
    >
      <p
        v-if="historyLoading"
        class="rail-state"
      >
        正在读取…
      </p>
      <p
        v-else-if="!revisions.length"
        class="rail-state"
      >
        还没有版本。
      </p>
      <div
        v-for="revision in revisions"
        :key="revision.id"
        class="history-item"
      >
        <div class="history-head">
          <span class="history-version">第 {{ revision.version }} 版</span>
          <span class="history-meta">{{ revisionTypeLabel(revision.revisionType) }} · {{ clockOf(revision.createdAt) }}</span>
        </div>
        <p class="history-preview">
          {{ revision.content.slice(0, 160) || revision.thought || revision.quote || "（空）" }}{{ revision.content.length > 160 ? "…" : "" }}
        </p>
        <el-button
          size="small"
          :loading="restoring"
          @click="restoreRevision(revision.version)"
        >
          恢复这一版
        </el-button>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
/* 整页节奏：补写条 → 目录 / 正文两栏。间距只取 --sp-* 阶。 */
.journal-page { display: flex; flex-direction: column; gap: var(--sp-4); }

/* ── 补写条：第一落点，浅品牌底，不跟阅读区抢注意力 ── */
.write-strip {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--brand-line);
  border-radius: var(--radius);
  background: var(--brand-soft);
}
.write-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--brand);
  font-size: 16px;
}
.write-copy { flex: 1; min-width: 0; }
.write-title { color: var(--text); font-size: 14px; font-weight: 600; line-height: 1.5; }
.write-sub { margin-top: 2px; color: var(--dim); font-size: 12px; line-height: 1.6; }
.write-form { display: flex; align-items: center; gap: var(--sp-2); flex: none; }

/* ── 两栏 ── */
.journal-grid {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: start;
}

/* ── 左：目录 ──
   和角色管理同一套「色块平铺」：白砖零描边零阴影，层次只靠明度差和间距；
   列表自己滚、翻页条钉在砖底，整页不被一条长目录拽长；整块吸在顶栏下。 */
.rail {
  position: sticky;
  top: calc(var(--topbar-h) + var(--sp-4));
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 96px);
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--surface);
}
.rail-head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border-bottom: 1px solid var(--surface-3);
}
.rail-title { display: flex; align-items: baseline; gap: var(--sp-2); }
/* 分节标题 12/700 --dim：和角色档案的「档案 / 模型」同一档，靠字重分层不靠字号 */
.rail-title h2 { color: var(--dim); font-size: 12px; font-weight: 700; }
.rail-count { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
.rail-month { width: 100%; }
.rail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-1) var(--sp-2) var(--sp-2);
}
.rail-state { padding: var(--sp-3) var(--sp-2); color: var(--dim); font-size: 12px; line-height: 1.8; }
.rail-foot { padding: var(--sp-1) var(--sp-2) var(--sp-2); border-top: 1px solid var(--surface-3); }

.day-group + .day-group { margin-top: var(--sp-1); }
.day-group-label { padding: var(--sp-2) var(--sp-2) var(--sp-1); color: var(--dim); font-size: 12px; font-weight: 600; }
.day-row {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  gap: var(--sp-2);
  width: 100%;
  padding: var(--sp-2);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background .14s var(--ease), box-shadow .14s var(--ease);
}
.day-row:hover { background: var(--surface-2); }
/* 选中：极淡品牌底 + 内描边 + 左侧 3px 品牌条，和角色选择卡 `.char-tab.is-on` 同一套。
   底色和文字色都属于颜色通道，灰度下会消失，所以必须再给一个形状通道 */
.day-row.active,
.day-row.active:hover {
  background: #fff8fa;
  box-shadow: inset 0 0 0 1px var(--brand-line), inset 3px 0 0 var(--brand);
}
.day-row:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.day-date { display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 1px; }
.day-num { color: var(--text-2); font-size: 18px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.day-wd { color: var(--dim); font-size: 12px; font-style: normal; line-height: 1.2; }
.day-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.day-top { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); min-height: 18px; }
.day-flag { color: var(--brand-strong); font-size: 12px; font-weight: 600; line-height: 18px; }
.day-marks { display: inline-flex; gap: 4px; flex: none; }
/* 两份文本各一枚小印：无描边软底，和 main.css 的 .pill-* 一致 */
.mark {
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  font-size: 12px;
  line-height: 16px;
}
.mark-diary { background: var(--brand-soft); color: var(--brand-strong); }
.mark-handbook { background: var(--green-soft); color: var(--green); }
.day-excerpt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.6;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.day-excerpt.is-empty { color: var(--dim); }
.day-quote { overflow: hidden; color: var(--dim); font-size: 12px; line-height: 1.6; white-space: nowrap; text-overflow: ellipsis; }

/* ── 右：正文 ── */
.reader {
  display: flex;
  flex-direction: column;
  min-height: 440px;
  border-radius: var(--radius);
  background: var(--surface);
}
.reader-head {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5) var(--sp-3);
}
.reader-day {
  color: var(--brand);
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.reader-when { min-width: 0; }
.reader-month {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  color: var(--text-2);
  font-size: 14px;
  font-weight: 600;
}
.reader-flag {
  padding: 0 8px;
  border-radius: 999px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}
.reader-sub { margin-top: 3px; color: var(--dim); font-size: 12px; }
.reader-status { flex: none; }

/* 分段式切换 + 一组安静的文字按钮：动作全跟着当前这份文本走 */
.reader-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 0 var(--sp-5) var(--sp-3);
  border-bottom: 1px solid var(--surface-3);
}
.kind-switch { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--surface-3); }
.kind-tab {
  padding: 5px 16px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--dim);
  font-size: 14px;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.kind-tab:hover { color: var(--text-2); }
.kind-tab.active { background: var(--surface); color: var(--text); font-weight: 600; }
.kind-tab:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.reader-ops { display: flex; align-items: center; gap: 2px; }
/* Element 给相邻按钮 12px margin-left，和 gap 叠加后间距会忽宽忽窄，统一交给 gap */
.reader-ops :deep(.el-button + .el-button) { margin-left: 0; }
.reader-ops :deep(.el-button.is-text) { padding: 6px 8px; }
/* 文字按钮里图标和字之间没有默认间距，自己给一点 */
.reader-ops .el-icon { margin-right: 4px; }
.reader-link .el-icon { font-size: 12px; }

.reader-body { flex: 1; padding: var(--sp-4) var(--sp-5) var(--sp-5); }
.reader-body > * + * { margin-top: var(--sp-4); }

/* 正文按阅读宽度排版：16px / 2 倍行高，一行不超过 68 个字 */
.sheet-title { margin-bottom: var(--sp-3); color: var(--text); font-size: 18px; font-weight: 600; line-height: 1.5; }
.sheet-body {
  max-width: 68ch;
  color: var(--text-2);
  font-size: 16px;
  line-height: 2;
  letter-spacing: .01em;
  white-space: pre-wrap;
}

/* 手账栏目之间用最淡的 --surface-3 分节，和角色档案的「人设 / 示例」同一条线 */
.hb-block + .hb-block { margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--surface-3); }
.hb-block h4 { display: flex; align-items: center; gap: var(--sp-2); color: var(--text-2); font-size: 14px; font-weight: 600; }
.hb-block h4::before { content: ""; width: 3px; height: 12px; border-radius: 2px; background: var(--brand-line); }
.hb-block ul { display: flex; flex-direction: column; gap: 2px; margin-top: var(--sp-2); list-style: none; }
.hb-block li { position: relative; padding-left: var(--sp-4); color: var(--text-2); font-size: 14px; line-height: 1.9; }
.hb-block li::before {
  content: "";
  position: absolute;
  top: 11px;
  left: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--line-strong);
}

.block-title { margin-bottom: var(--sp-2); color: var(--text-2); font-size: 14px; font-weight: 600; }
/* 想法是一块浅砖，靠明度差分出来，不加描边 */
.thought-card {
  padding: var(--sp-4);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}
.thought { color: var(--text-2); font-size: 14px; line-height: 1.9; }
/* 「今日一句」是整页唯一一块带色底的，因为它只可能有一句；
   3px 竖条用 inset 阴影而不是 border-left，内容左侧不会被推偏 */
.quote-card {
  padding: var(--sp-4) var(--sp-5);
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  box-shadow: inset 3px 0 0 var(--brand-line);
}
.quote-text { color: var(--text); font-size: 18px; font-weight: 500; line-height: 1.8; }
.quote-note { margin-top: var(--sp-2); color: var(--dim); font-size: 12px; }
.tag-row { display: flex; flex-wrap: wrap; gap: 6px; }
.sheet-meta { color: var(--dim); font-size: 12px; line-height: 1.8; }

.skip-note {
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--amber-line);
  border-radius: var(--radius-sm);
  background: var(--amber-soft);
}
.skip-note p { color: var(--text-2); font-size: 14px; font-weight: 600; }
.skip-note .skip-reason { margin-top: 3px; color: var(--dim); font-size: 12px; font-weight: 400; }

.reader-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); padding: var(--sp-6) var(--sp-4); text-align: center; }
.reader-empty p { color: var(--dim); font-size: 14px; }
.reader-state { padding: var(--sp-5); color: var(--dim); font-size: 14px; }
.reader-state-empty { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; }
.reader-foot { display: flex; justify-content: flex-end; padding: 0 var(--sp-5) var(--sp-4); }
.reader-link { display: inline-flex; align-items: center; gap: 3px; color: var(--brand-strong); font-size: 12px; font-weight: 600; }
.reader-link:hover { text-decoration: underline; }

/* ── 空角色 / 弹窗 ── */
.no-character {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 260px;
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-6) var(--sp-5);
  text-align: center;
}
.no-character-title { margin-bottom: var(--sp-2); color: var(--text-2); font-size: 16px; font-weight: 600; }
.dialog-note { margin-top: var(--sp-2); color: var(--dim); font-size: 12px; line-height: 1.7; }

.history-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
  border-top: 1px solid var(--line);
}
.history-item:first-of-type { padding-top: 0; border-top: 0; }
.history-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); width: 100%; }
.history-version {
  padding: 0 8px;
  border-radius: 999px;
  background: var(--surface-3);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
}
.history-meta { color: var(--dim); font-size: 12px; }
.history-preview { color: var(--dim); font-size: 12px; line-height: 1.8; }

@media (max-width: 1180px) {
  .journal-grid { grid-template-columns: 264px minmax(0, 1fr); }
}
@media (max-width: 960px) {
  .journal-grid { grid-template-columns: minmax(0, 1fr); }
  /* 单列时目录在正文之上，吸顶会把它钉在视口里挡住内容 */
  .rail { position: static; max-height: none; }
  .rail-body { max-height: 320px; }
  .write-strip { flex-wrap: wrap; }
  .write-copy { flex-basis: calc(100% - 44px); }
  .write-form { width: 100%; }
}
@media (max-width: 620px) {
  .reader-head { grid-template-columns: auto minmax(0, 1fr); }
  .reader-status { grid-column: 1 / -1; justify-self: start; }
  .reader-bar { align-items: stretch; flex-direction: column; }
  .reader-ops { justify-content: flex-end; }
}
</style>
