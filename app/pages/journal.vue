<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { ArrowRight, Check, Clock, EditPen, Loading, Plus, Refresh } from "@element-plus/icons-vue";
import type { Character } from "~/utils/mock-data";
import { readApiErrorMessage } from "~/utils/api-error";
import {
  createJournalApi,
  type JournalDetail,
  type JournalKind,
  type JournalListItem,
  type JournalRevision,
} from "~/api/journal";

// 标题归顶栏（AppShell 读 route.meta.topbar）；正文不再重复一遍面包屑和说明行。
definePageMeta({
  topbar: {
    title: "日记手账",
    crumbs: [{ label: "工作空间" }],
  },
});

/**
 * 日记 / 手账：同一天的两份独立文本。
 *
 * - 日记：第一人称叙事，读今天经历了什么。
 * - 手账：结构化记录（片段 / 想法 / 一句 / 灵感 / 待续），读今天留下了什么。
 *
 * 两份各自版本、各自编辑/重写；手账的「一句」摘自某一版日记。
 */
const { getJournalDetail, listJournalRevisions, listJournals, regenerateJournal,
  restoreJournalRevision, saveJournalEntry, writeJournalDay } = createJournalApi(useApiRequest());
await useCharacterListData();
const route = useRoute();
const { id } = useCharacterSelection("/journal");

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
/** 「写日记」浮层：入口在目录标题行，浮层只放日期与确认。 */
const writeOpen = ref(false);
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

const readError = readApiErrorMessage;

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
    const result = await listJournals({
      characterId: targetCharacterId,
      page: targetPage,
      pageSize: PAGE_SIZE,
      ...(targetMonth ? { month: targetMonth } : {}),
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
    const result = await getJournalDetail({ characterId: targetCharacterId, dayKey });
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
  if (!targetCharacterId || writing.value) return;
  if (!dayKey) {
    ElMessage.warning("先选一个日期。");
    return;
  }
  const seq = ++writeRequestSeq;
  const selectionAtStart = selectedDay.value;
  writing.value = true;
  // 按钮点下就收起草稿浮层，进度交给目录标题行的「写日记」按钮。
  writeOpen.value = false;
  try {
    const result = await writeJournalDay({ characterId: targetCharacterId, dayKey, target });
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
    if (seq === writeRequestSeq) {
      writing.value = false;
    }
  }
}

/**
 * 空态按钮「让她写这一天」：这一天两份都缺，写一次 BOTH。
 * 只是把选中日期交给 writeDay 再转调 writeDayNow，防乱序 / 换角色的守卫全在它里面。
 */
function writeSelectedDay(): void {
  if (!selectedDay.value) return;
  writeDay.value = selectedDay.value;
  void writeDayNow("BOTH");
}

async function writeCurrent(kind: JournalKind): Promise<void> {
  const targetCharacterId = id.value;
  const dayKey = selectedDay.value;
  if (!targetCharacterId || !dayKey || writing.value) return;
  const seq = ++writeRequestSeq;
  writing.value = true;
  try {
    const result = await writeJournalDay({ characterId: targetCharacterId, dayKey, target: kind });
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
    const result = await regenerateJournal({ characterId: targetCharacterId, dayKey, kind });
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
    await saveJournalEntry({ characterId: target.characterId, dayKey: target.dayKey, ...payload });
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
    const result = await listJournalRevisions({ characterId: targetCharacterId, dayKey, kind });
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
    await restoreJournalRevision({ characterId: targetCharacterId, dayKey, kind, version });
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
  writeOpen.value = false;
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
      class="journal"
    >
      <!-- ═════════ 左栏：目录 ═════════ -->
      <aside class="rail">
        <div class="rail-head">
          <div class="rail-title">
            <h2>写过的日子</h2>
            <span class="rail-count">{{ total }} 天</span>
            <el-popover
              v-model:visible="writeOpen"
              placement="bottom-end"
              :width="236"
              trigger="click"
              popper-class="write-popper"
            >
              <template #reference>
                <button
                  type="button"
                  class="write"
                  :disabled="writing"
                >
                  <el-icon
                    v-if="writing"
                    class="is-loading"
                  >
                    <Loading />
                  </el-icon>
                  <el-icon v-else>
                    <Plus />
                  </el-icon>{{ writing ? "正在写…" : "写日记" }}
                </button>
              </template>
              <div class="write-pop">
                <div class="write-pop-date">
                  <el-date-picker
                    v-model="writeDay"
                    type="date"
                    value-format="YYYY-MM-DD"
                    :clearable="false"
                    @change="markWriteDayTouched"
                  />
                </div>
                <el-button
                  type="primary"
                  class="write-pop-go"
                  aria-label="写这一天"
                  :disabled="writing"
                  @click="writeDayNow('BOTH')"
                >
                  <el-icon><Check /></el-icon>
                </el-button>
              </div>
            </el-popover>
          </div>
          <!-- 月份筛选：外层 div 收口宽度 —— el-date-picker 是多根组件，
               直接往它身上挂 class 会因为属性透传失效而落不下来 -->
          <div class="month-field">
            <el-date-picker
              v-model="month"
              type="month"
              value-format="YYYY-MM"
              placeholder="全部月份"
              clearable
            />
          </div>
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
            还没有日记或手账。点右上角「写日记」，挑一天让她写。
          </p>

          <div
            v-for="group in dayGroups"
            :key="group.month"
            class="day-group"
          >
            <p class="month-label">
              {{ group.label }}
            </p>
            <button
              v-for="item in group.items"
              :key="item.id"
              type="button"
              class="day"
              :class="{
                'is-active': item.dayKey === selectedDay,
                'wd-sat': weekdayShort(item.dayKey) === '周六',
                'wd-sun': weekdayShort(item.dayKey) === '周日',
              }"
              :aria-current="item.dayKey === selectedDay"
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
                      class="mark is-diary"
                    >日记</span>
                    <span
                      v-if="item.handbookVersion"
                      class="mark is-hb"
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
            compact
            @update:page="page = $event"
          />
        </div>
      </aside>

      <!-- ═════════ 右栏：阅读区 ═════════ -->
      <section class="reader">
        <p
          v-if="detailLoading"
          class="reader-state"
        >
          正在读取这一天…
        </p>

        <template v-else-if="detail">
          <header class="reader-head">
            <span class="day-big">{{ dayNumber(detail.dayKey) }}</span>
            <div class="reader-when">
              <p class="reader-month">
                {{ yearMonthLabel(detail.dayKey) }} · {{ weekdayShort(detail.dayKey) }}
                <span
                  v-if="relativeFlag(detail.dayKey)"
                  class="day-flag"
                >{{ relativeFlag(detail.dayKey) }}</span>
              </p>
              <p class="reader-sub">
                更新于 {{ clockOf(detail.updatedAt) }}
              </p>
            </div>
            <div class="reader-head-right">
              <span
                class="state-chip"
                :class="{ 'is-skip': !detail.diary && !detail.handbook }"
              >{{ detail.diary || detail.handbook ? "写过了" : "没写" }}</span>
            </div>
          </header>

          <div class="reader-bar">
            <div
              class="seg"
              role="tablist"
              aria-label="日记与手账"
            >
              <button
                type="button"
                role="tab"
                class="seg-btn"
                :class="{
                  'is-on': activeTab === 'DIARY',
                  'is-empty': !detail.diary && !detail.handbook,
                }"
                :aria-selected="activeTab === 'DIARY'"
                @click="activeTab = 'DIARY'"
              >
                日记
              </button>
              <button
                type="button"
                role="tab"
                class="seg-btn"
                :class="{
                  'is-on': activeTab === 'HANDBOOK',
                  'is-empty': !detail.diary && !detail.handbook,
                }"
                :aria-selected="activeTab === 'HANDBOOK'"
                @click="activeTab = 'HANDBOOK'"
              >
                手账
              </button>
            </div>

            <!-- 改内容的三个入口跟着当前这份文本走；这一天没写就整组收起 -->
            <div
              v-if="detail.diary || detail.handbook"
              class="ops"
            >
              <template v-if="activeRevision">
                <button
                  type="button"
                  class="op"
                  @click="openEdit(activeTab)"
                >
                  <el-icon><EditPen /></el-icon>编辑
                </button>
                <button
                  type="button"
                  class="op"
                  :disabled="regenerating"
                  @click="regenerate(activeTab)"
                >
                  <el-icon :class="{ 'is-loading': regenerating }">
                    <Refresh />
                  </el-icon>重写
                </button>
                <button
                  type="button"
                  class="op"
                  @click="openHistory(activeTab)"
                >
                  <el-icon><Clock /></el-icon>历史 <span class="n">{{ activeRevisionCount }}</span>
                </button>
              </template>
            </div>
          </div>

          <div class="reader-body">
            <!-- 那天没写：给原因 + 给动作，不留「写过了 + 一片空白」 -->
            <div
              v-if="!detail.diary && !detail.handbook"
              class="reader-empty"
            >
              <span
                class="empty-ico"
                aria-hidden="true"
              >日</span>
              <h3>这一天她还什么都没写</h3>
              <p>
                {{ detail.skipReason || "那天没有可用的对话，也没有留下忆泡。可以让她读一遍那几天的记忆再补写，写不写由她判断。" }}
              </p>
              <button
                type="button"
                class="go"
                :disabled="writing"
                @click="writeSelectedDay"
              >
                让她写这一天
              </button>
            </div>

            <template v-else-if="activeTab === 'DIARY'">
              <template v-if="detail.diary">
                <article class="sheet">
                  <h2
                    v-if="detail.diary.title"
                    class="sheet-title"
                  >
                    {{ detail.diary.title }}
                  </h2>
                  <div
                    v-if="detail.diary.content"
                    class="sheet-body"
                  >
                    <p
                      v-for="(para, index) in detail.diary.content.split(/\r?\n\s*\r?\n/)"
                      :key="index"
                    >
                      {{ para }}
                    </p>
                  </div>
                </article>
                <p class="sheet-meta">
                  第 {{ detail.diary.version }} 版
                  <span class="sep">·</span>{{ revisionTypeLabel(detail.diary.revisionType) }}
                  <span class="sep">·</span>来源：对话 {{ detail.diary.sources.messages }} 条 · 忆泡 {{ detail.diary.sources.events }} 条
                  <NuxtLink
                    class="meta-link"
                    :to="{ path: '/growth/memory/events', query: { ...route.query, c: id } }"
                  >
                    去看那天的忆泡
                    <el-icon><ArrowRight /></el-icon>
                  </NuxtLink>
                </p>
              </template>
              <div
                v-else
                class="reader-empty is-compact"
              >
                <p>这一天还没有日记。</p>
                <button
                  type="button"
                  class="go"
                  :disabled="writing"
                  @click="writeCurrent('DIARY')"
                >
                  写日记
                </button>
              </div>
            </template>

            <template v-else>
              <template v-if="detail.handbook">
                <div class="hb">
                  <blockquote
                    v-if="detail.handbook.quote"
                    class="quote-card"
                  >
                    <p class="quote-text">
                      「{{ detail.handbook.quote }}」
                    </p>
                    <p class="quote-note">
                      摘自日记{{ detail.handbook.sourceDiaryVersion ? `第 ${detail.handbook.sourceDiaryVersion} 版` : "正文" }}，不是另写的。
                    </p>
                  </blockquote>

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
                  <p
                    v-else
                    class="sheet-body"
                  >
                    {{ detail.handbook.content }}
                  </p>

                  <section
                    v-if="detail.handbook.thought"
                    class="thought"
                  >
                    <h4>今日想法</h4>
                    <p>{{ detail.handbook.thought }}</p>
                  </section>

                  <div
                    v-if="detail.handbook.tags.length"
                    class="tags"
                  >
                    <span
                      v-for="tag in detail.handbook.tags"
                      :key="tag"
                      class="tag"
                    >{{ tag }}</span>
                  </div>
                </div>

                <p class="sheet-meta">
                  第 {{ detail.handbook.version }} 版
                  <span class="sep">·</span>{{ revisionTypeLabel(detail.handbook.revisionType) }}
                  <span class="sep">·</span>来源：对话 {{ detail.handbook.sources.messages }} 条 · 忆泡 {{ detail.handbook.sources.events }} 条
                  <NuxtLink
                    class="meta-link"
                    :to="{ path: '/growth/memory/events', query: { ...route.query, c: id } }"
                  >
                    去看那天的忆泡
                    <el-icon><ArrowRight /></el-icon>
                  </NuxtLink>
                </p>
              </template>
              <div
                v-else
                class="reader-empty is-compact"
              >
                <p>这一天还没有手账。</p>
                <button
                  type="button"
                  class="go"
                  :disabled="writing"
                  @click="writeCurrent('HANDBOOK')"
                >
                  写手账
                </button>
              </div>
            </template>
          </div>
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
/* ════════════════════════════════════════════════════════════════════════
   日记手账：目录（左 306）+ 阅读区（右自适应）。
   色 / 间距 / 圆角只取 main.css 的令牌：白砖零描边，层次靠明度差与间距。
   ════════════════════════════════════════════════════════════════════════ */
.journal-page { display: flex; flex-direction: column; gap: var(--sp-4); }

/* ── 两栏骨架 ── */
.journal {
  display: grid;
  grid-template-columns: 306px minmax(0, 1fr);
  gap: var(--sp-4);
  align-items: start;
}

/* ── 左：目录 ──
   一天一行，目录会很长，所以列表自己滚、翻页钉在栏底，整页不被一条长目录拽长。
   吸顶跟着 sticky 顶栏走：top = 顶栏 56 + 8；高度到底部再留 16 的呼吸。 */
.rail {
  position: sticky;
  top: calc(var(--topbar-h) + var(--sp-2));
  display: flex;
  max-height: calc(100vh - var(--topbar-h) - var(--sp-4) - var(--sp-2));
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--surface);
}
.rail-head {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sp-4) 14px var(--sp-3);
}
.rail-title { display: flex; align-items: baseline; gap: var(--sp-2); }
.rail-title h2 { color: var(--text); font-size: 14px; font-weight: 700; }
.rail-count { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }

/* 写日记：主色实心；右侧「编辑 / 重写」是同尺寸的幽灵按钮，层级一眼分得开 */
.write {
  display: inline-flex;
  height: 30px;
  margin-left: auto;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: var(--radius-xs);
  background: var(--brand-btn);
  padding: 0 11px;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  transition: background .15s var(--ease);
}
.write:hover { background: var(--brand-btn-h); }
.write:disabled { cursor: progress; opacity: .85; }
.write:focus-visible { outline: 2px solid var(--brand-line); outline-offset: 2px; }
.write .el-icon { font-size: 12px; }

/* 月份筛选：压成一个安静的下拉（30 高 / --surface-2 底 / 无描边 / 只占内容宽）。
   Element 默认的输入框样式（白底 + 描边 + 220px 定宽）在这里会像个表单字段，全部盖掉。 */
.month-field { display: flex; }
.month-field :deep(.el-input),
.month-field :deep(.el-date-editor) { width: auto; }
.month-field :deep(.el-input__wrapper) {
  height: 30px;
  border-radius: var(--radius-xs);
  background: var(--surface-2);
  padding: 0 8px 0 10px;
  box-shadow: none;
  transition: background .14s var(--ease);
}
.month-field :deep(.el-input__wrapper:hover) { background: var(--surface-3); }
.month-field :deep(.el-input__wrapper.is-focus) { background: var(--surface-3); box-shadow: 0 0 0 1px var(--brand-line) inset; }
.month-field :deep(.el-input__inner) {
  height: 30px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  text-align: left;
}
.month-field :deep(.el-input__prefix),
.month-field :deep(.el-input__suffix) { color: var(--faint); }
.month-field :deep(.el-input__icon) { font-size: 12px; }

.rail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--sp-2) var(--sp-2); }
.rail-state { padding: var(--sp-3) var(--sp-2); color: var(--dim); font-size: 12px; line-height: 1.8; }
.month-label {
  padding: 10px 6px var(--sp-1);
  color: var(--faint);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: .04em;
}

/* 一天一行：日期数字作左侧锚点，右侧三行（标记 / 摘要 / 引文） */
.day {
  position: relative;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 10px;
  width: 100%;
  border: 0;
  border-radius: var(--radius);
  background: none;
  padding: 9px var(--sp-2) 9px 6px;
  text-align: left;
  cursor: pointer;
  transition: background .14s var(--ease);
}
.day + .day { margin-top: 2px; }
.day:hover { background: var(--surface-2); }
.day.is-active,
.day.is-active:hover { background: var(--brand-soft); }
/* 选中：左边一道 3px 竖条 —— 和好友档案的顶部强度条同一套「靠边编码」，
   灰度下靠形状也读得出来 */
.day.is-active::before {
  position: absolute;
  top: 10px;
  bottom: 10px;
  left: 0;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
  content: "";
}
.day:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.day-date { display: flex; flex-direction: column; align-items: center; gap: 1px; padding-top: 2px; }
.day-num {
  color: var(--text);
  font-size: 21px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.02em;
}
.day.is-active .day-num { color: var(--brand-strong); }
/* 周末日期数字淡一档；<i> 只借它的语义，样式上必须归正 */
.day.wd-sat .day-num,
.day.wd-sun .day-num { color: var(--faint); }
.day.is-active.wd-sat .day-num,
.day.is-active.wd-sun .day-num { color: var(--brand-strong); }
.day-wd { color: var(--dim); font-size: 12px; font-style: normal; line-height: 1.3; letter-spacing: .02em; }

.day-body { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.day-top { display: flex; align-items: center; gap: var(--sp-2); }
/* 标记用「点 + 字」：19 天 × 2 枚药丸太吵，一行里只要读得出有哪两份 */
.day-marks { display: flex; align-items: center; gap: 9px; color: var(--dim); font-size: 12px; }
.mark { display: inline-flex; align-items: center; gap: 4px; }
.mark::before { width: 5px; height: 5px; border-radius: 50%; background: var(--faint); content: ""; }
.mark.is-diary::before { background: var(--brand); }
.mark.is-hb::before { background: var(--amber); }
.day-flag {
  border-radius: 4px;
  background: var(--brand-soft);
  padding: 0 5px;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  line-height: 16px;
}
.day-excerpt {
  overflow: hidden;
  color: var(--text-2);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.day.is-active .day-excerpt { color: var(--text); }
.day-excerpt.is-empty { color: var(--faint); }
.day-quote {
  overflow: hidden;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-foot { padding: var(--sp-2) var(--sp-3); border-top: 1px solid var(--surface-3); }

/* ── 右：阅读区 ── */
.reader {
  display: flex;
  min-height: 440px;
  flex-direction: column;
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-5) 30px 22px;
}
.reader-head { display: flex; align-items: flex-start; gap: var(--sp-4); }
/* 46/700：这一天是整页的主角，比顶栏标题还大一级 */
.day-big {
  color: var(--text);
  font-size: 46px;
  font-weight: 700;
  line-height: .92;
  font-variant-numeric: tabular-nums;
  letter-spacing: -.03em;
}
.reader-when { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-1); padding-top: var(--sp-1); }
.reader-month {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  color: var(--text-2);
  font-size: 14px;
  font-weight: 600;
}
.reader-month .day-flag { padding: 0 6px; font-size: 12px; line-height: 18px; }
.reader-sub { color: var(--dim); font-size: 12px; }
.reader-head-right { display: flex; margin-left: auto; align-items: center; gap: 10px; padding-top: 6px; }
/* 状态用「写过了 / 没写」两色软底，不用 el-tag 的默认样式 */
.state-chip {
  display: inline-flex;
  height: 22px;
  align-items: center;
  gap: 5px;
  border-radius: 999px;
  background: var(--green-soft);
  padding: 0 9px;
  color: var(--green);
  font-size: 12px;
  font-weight: 600;
}
.state-chip.is-skip { background: var(--surface-3); color: var(--dim); }

/* 分段（日记 / 手账）与操作同一行：左边切内容，右边改内容 */
.reader-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  border-bottom: 1px solid var(--surface-3);
  padding-bottom: 14px;
}
.seg { display: flex; gap: 2px; border-radius: var(--radius-sm); background: var(--surface-2); padding: 3px; }
.seg-btn {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  padding: 0 var(--sp-3);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.seg-btn:hover { background: var(--surface); }
.seg-btn.is-on { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgba(16, 24, 40, .06); }
.seg-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
/* 这一天没写：两段都置灰，白色药丸也收掉，避免看起来「可切」 */
.seg-btn.is-empty,
.seg-btn.is-empty:hover,
.seg-btn.is-empty.is-on { background: none; color: var(--faint); box-shadow: none; cursor: default; }

.ops { display: flex; margin-left: auto; align-items: center; gap: 2px; }
.op {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  padding: 0 9px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.op:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
.op:disabled { cursor: progress; opacity: .7; }
.op:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.op .el-icon { font-size: 14px; }
.op .n { color: var(--faint); font-variant-numeric: tabular-nums; }

.reader-body { flex: 1; padding-top: var(--sp-5); }

/* 日记：一张纸，正文限宽 640、行高 1.95 —— 长文读起来不费劲 */
.sheet { max-width: 640px; }
.sheet-title {
  margin-bottom: 14px;
  color: var(--text);
  font-size: 21px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: -.01em;
}
.sheet-body { color: var(--text-2); font-size: 16px; line-height: 1.95; }
/* 段落由模板按空行切开；段内的单换行仍保留（pre-line） */
.sheet-body p { margin: 0 0 15px; white-space: pre-line; }
.sheet-body p:last-child { margin-bottom: 0; }

/* 页脚元信息：第几版、谁改的、素材从哪来 —— 一行说完，右侧给出处 */
.sheet-meta {
  display: flex;
  max-width: 640px;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-5);
  border-top: 1px solid var(--surface-3);
  padding-top: var(--sp-3);
  color: var(--dim);
  font-size: 12px;
}
.sheet-meta .sep { color: var(--faint); }
.meta-link {
  display: inline-flex;
  margin-left: auto;
  align-items: center;
  gap: 3px;
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
.meta-link .el-icon { font-size: 12px; }
.meta-link:hover { text-decoration: underline; text-underline-offset: 3px; }

/* 手账：结构化。「今日一句」用左侧竖线立起来，片段用小标题分块 */
.hb { display: flex; max-width: 660px; flex-direction: column; gap: var(--sp-5); }
.quote-card { border-left: 3px solid var(--brand-line); padding: 2px 0 2px var(--sp-4); }
.quote-text { color: var(--text); font-size: 18px; font-weight: 500; line-height: 1.75; }
.quote-note { margin-top: 6px; color: var(--dim); font-size: 12px; }
.hb-block h4 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 7px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .02em;
}
.hb-block h4::before { width: 5px; height: 5px; border-radius: 50%; background: var(--brand-line); content: ""; }
/* 栏目之间用 gap 分节，不再叠一条分隔线 —— 标题前的圆点已经足够分组 */
.hb-block ul { display: flex; flex-direction: column; gap: 2px; list-style: none; }
.hb-block li { position: relative; padding-left: 14px; color: var(--text-2); font-size: 14px; line-height: 1.9; }
.hb-block li::before {
  position: absolute;
  top: 12px;
  left: 2px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--faint);
  content: "";
}
.thought { border-radius: var(--radius); background: var(--surface-2); padding: 14px var(--sp-4); }
.thought h4 { margin-bottom: 6px; color: var(--dim); font-size: 12px; font-weight: 700; }
.thought p { color: var(--text); font-size: 14px; line-height: 1.85; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag {
  border-radius: var(--radius-xs);
  background: var(--surface-3);
  padding: 2px var(--sp-2);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.7;
}

/* ── 空态：给原因 + 给动作，不留一片白 ── */
.reader-empty {
  display: flex;
  min-height: 420px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.reader-empty.is-compact { min-height: 240px; }
.empty-ico {
  display: grid;
  width: 44px;
  height: 44px;
  margin-bottom: var(--sp-3);
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 18px;
}
.reader-empty h3 { color: var(--text); font-size: 16px; font-weight: 700; }
.reader-empty p { max-width: 420px; margin-top: 7px; color: var(--dim); font-size: 14px; line-height: 1.75; }
.go {
  height: 32px;
  margin-top: 14px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--brand-btn);
  padding: 0 14px;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background .15s var(--ease);
}
.go:hover:not(:disabled) { background: var(--brand-btn-h); }
.go:disabled { cursor: progress; opacity: .85; }
.go:focus-visible { outline: 2px solid var(--brand-line); outline-offset: 2px; }

.reader-state { padding: var(--sp-5); color: var(--dim); font-size: 14px; }
.reader-state-empty { flex: 1; display: flex; align-items: center; justify-content: center; text-align: center; }

/* ── 写日记浮层 / 空角色 / 弹窗 ── */
.write-pop { display: flex; align-items: center; gap: var(--sp-2); }
.write-pop-date { flex: 1; min-width: 0; }
.write-pop-date :deep(.el-input),
.write-pop-date :deep(.el-date-editor) { width: 100%; }
.write-pop-go { width: 32px; height: 32px; flex: none; padding: 0; }
.no-character {
  display: flex;
  min-height: 260px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
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
  border-top: 1px solid var(--line);
  padding: var(--sp-3) 0;
}
.history-item:first-of-type { border-top: 0; padding-top: 0; }
.history-head { display: flex; width: 100%; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
.history-version {
  border-radius: 999px;
  background: var(--surface-3);
  padding: 0 var(--sp-2);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  line-height: 20px;
}
.history-meta { color: var(--dim); font-size: 12px; }
.history-preview { color: var(--dim); font-size: 12px; line-height: 1.8; }

/* ── 响应式 ── */
@media (max-width: 1180px) {
  .journal { grid-template-columns: 272px minmax(0, 1fr); }
}
@media (max-width: 980px) {
  .journal { grid-template-columns: minmax(0, 1fr); }
  /* 单列时目录在正文之上，吸顶会把它钉在视口里挡住内容 */
  .rail { position: static; max-height: none; }
  .rail-body { max-height: 320px; }
}
@media (max-width: 620px) {
  .reader { padding: 18px var(--sp-4); }
  .day-big { font-size: 38px; }
  .reader-bar { align-items: stretch; flex-direction: column; }
  .ops { justify-content: flex-end; }
}
</style>
