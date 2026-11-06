<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character } from "~/utils/mock-data";

/**
 * 日记 / 手账：同一天的两份独立文本。
 *
 * - 日记：第一人称叙事，读今天经历了什么。
 * - 手账：结构化记录（片段 / 想法 / 一句 / 灵感 / 待续），读今天留下了什么。
 *
 * 两份各自版本、各自编辑/重写；手账的「一句」摘自某一版日记。
 */
await useCharacterListData();
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

function dayLabel(dayKey: string): string {
  if (dayKey === todayKey.value) return "今天";
  if (dayKey === yesterdayKey.value) return "昨天";
  const [year, monthValue, dateValue] = dayKey.split("-").map(Number);
  if (!year || !monthValue || !dateValue) return dayKey;
  // 星期是日历属性，用 UTC 构造避免浏览器本地时区把日期挪一天。
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][new Date(Date.UTC(year, monthValue - 1, dateValue)).getUTCDay()];
  return `${monthValue} 月 ${dateValue} 日 · 周${weekday}`;
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
  page.value = 1;
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
watch([page, month], () => {
  page.value = Math.max(1, page.value);
  void loadList(true, id.value);
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
  <div class="page-wrap">
    <PageHeader
      eyebrow="工作空间 / 日记与手账"
      title="日记与手账"
      description="同一天的两份独立文本：日记是第一人称叙事，手账是结构化记录；各自版本、各自编辑。"
    />
    <CharacterBar
      path="/journal"
      empty-text="先创建一个角色，这里才会有她的日记和手账。"
    />

    <div
      v-if="!currentCharacter"
      class="card empty-card"
    >
      <p class="muted-note">
        还没有角色。
      </p>
    </div>

    <template v-else>
      <div class="card journal-toolbar">
        <span class="toolbar-label">补写某一天</span>
        <el-date-picker
          v-model="writeDay"
          type="date"
          value-format="YYYY-MM-DD"
          :clearable="false"
          style="width: 150px"
          @change="markWriteDayTouched"
        />
        <el-button
          :loading="writing"
          @click="writeDayNow('BOTH')"
        >
          让她写这一天
        </el-button>
        <span class="toolbar-gap" />
        <el-date-picker
          v-model="month"
          type="month"
          value-format="YYYY-MM"
          placeholder="全部月份"
          clearable
          style="width: 150px"
        />
      </div>

      <div class="journal-layout">
        <aside class="card journal-list">
          <div class="journal-list-head">
            <h2>写过的日子</h2>
            <span class="muted-note">{{ total }} 天</span>
          </div>

          <div
            v-if="loading"
            class="muted-note journal-empty"
          >
            正在读取…
          </div>
          <div
            v-else-if="!items.length"
            class="muted-note journal-empty"
          >
            还没有日记或手账。挑一个日期，点「让她写这一天」试试。
          </div>
          <button
            v-for="item in items"
            :key="item.id"
            type="button"
            class="journal-item"
            :class="{ active: item.dayKey === selectedDay }"
            @click="selectDay(item.dayKey)"
          >
            <span class="journal-item-top">
              <span class="journal-item-day">{{ dayLabel(item.dayKey) }}</span>
              <span class="journal-item-badges">
                <el-tag
                  v-if="item.diaryVersion"
                  size="small"
                  effect="plain"
                >
                  日记
                </el-tag>
                <el-tag
                  v-if="item.handbookVersion"
                  size="small"
                  type="success"
                  effect="plain"
                >
                  手账
                </el-tag>
              </span>
            </span>
            <span
              v-if="item.diaryFirstLine"
              class="journal-item-line"
            >{{ item.diaryFirstLine }}</span>
            <span
              v-else
              class="journal-item-line journal-item-muted"
            >这一天没有日记。</span>
            <span
              v-if="item.handbookQuote"
              class="journal-item-quote"
            >「{{ item.handbookQuote }}」</span>
          </button>

          <PagerBar
            v-if="total > 0"
            :page="page"
            :total-pages="totalPages"
            :total="total"
            :page-size="PAGE_SIZE"
            unit="天"
            flush
            @update:page="page = $event"
          />
        </aside>

        <section class="card journal-detail">
          <div
            v-if="detailLoading"
            class="muted-note"
          >
            正在读取这一天…
          </div>

          <template v-else-if="detail">
            <header class="journal-head">
              <h2>{{ dayLabel(detail.dayKey) }}</h2>
              <el-tag
                size="small"
                :type="detail.status === 'ACTIVE' ? 'success' : 'info'"
                effect="plain"
              >
                {{ detail.status === "ACTIVE" ? "写过了" : "没写" }}
              </el-tag>
              <span class="muted-note">更新于 {{ clockOf(detail.updatedAt) }}</span>
            </header>

            <div
              v-if="detail.status === 'SKIPPED' && !detail.diary && !detail.handbook"
              class="journal-empty-state"
            >
              <p>这一天她没写日记，也没写手账。</p>
              <p class="muted-note">
                {{ detail.skipReason || "没有什么值得记的事。" }}
              </p>
            </div>

            <el-tabs v-model="activeTab">
              <el-tab-pane
                label="日记"
                name="DIARY"
              >
                <template v-if="detail.diary">
                  <article class="journal-card">
                    <div class="journal-card-head">
                      <h3>
                        日记
                        <span
                          v-if="detail.diary.title"
                          class="journal-card-sub"
                        >{{ detail.diary.title }}</span>
                      </h3>
                      <button
                        type="button"
                        class="btn-link"
                        @click="openEdit('DIARY')"
                      >
                        编辑
                      </button>
                    </div>
                    <div class="journal-content">
                      {{ detail.diary.content }}
                    </div>
                  </article>

                  <footer class="journal-foot">
                    <span class="muted-note">
                      第 {{ detail.diary.version }} 版 · {{ revisionTypeLabel(detail.diary.revisionType) }} ·
                      来源：对话 {{ detail.diary.sources.messages }} 条 · 忆泡 {{ detail.diary.sources.events }} 条
                    </span>
                  </footer>

                  <div class="journal-actions">
                    <el-button
                      :loading="regenerating"
                      @click="regenerate('DIARY')"
                    >
                      重写日记
                    </el-button>
                    <el-button @click="openHistory('DIARY')">
                      日记历史（{{ detail.revisionCounts.diary }}）
                    </el-button>
                  </div>
                </template>
                <div
                  v-else
                  class="journal-empty-state"
                >
                  <p>这一天还没有日记。</p>
                  <el-button
                    :loading="writing"
                    @click="writeCurrent('DIARY')"
                  >
                    写日记
                  </el-button>
                </div>
              </el-tab-pane>

              <el-tab-pane
                label="手账"
                name="HANDBOOK"
              >
                <template v-if="detail.handbook">
                  <article
                    v-if="detail.handbook.content"
                    class="journal-card"
                  >
                    <div class="journal-card-head">
                      <h3>手账</h3>
                    </div>
                    <template v-if="handbookSections">
                      <section
                        v-for="section in handbookSections"
                        :key="section.title"
                        class="handbook-section"
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
                      class="journal-content"
                    >
                      {{ detail.handbook.content }}
                    </div>
                  </article>

                  <article
                    v-if="detail.handbook.thought"
                    class="journal-card"
                  >
                    <div class="journal-card-head">
                      <h3>今日想法</h3>
                    </div>
                    <p class="journal-thought">
                      {{ detail.handbook.thought }}
                    </p>
                  </article>

                  <article
                    v-if="detail.handbook.quote"
                    class="journal-card journal-quote-card"
                  >
                    <div class="journal-card-head">
                      <h3>今日一句</h3>
                    </div>
                    <blockquote class="journal-quote">
                      「{{ detail.handbook.quote }}」
                    </blockquote>
                    <p class="muted-note journal-quote-note">
                      摘自日记{{ detail.handbook.sourceDiaryVersion ? `第 ${detail.handbook.sourceDiaryVersion} 版` : "正文" }}，不是另写的。
                    </p>
                  </article>

                  <article
                    v-if="detail.handbook.tags.length"
                    class="journal-card"
                  >
                    <div class="journal-card-head">
                      <h3>标签</h3>
                    </div>
                    <div class="journal-tags">
                      <el-tag
                        v-for="tag in detail.handbook.tags"
                        :key="tag"
                        size="small"
                        effect="plain"
                      >
                        {{ tag }}
                      </el-tag>
                    </div>
                  </article>

                  <footer class="journal-foot">
                    <span class="muted-note">
                      第 {{ detail.handbook.version }} 版 · {{ revisionTypeLabel(detail.handbook.revisionType) }} ·
                      来源：对话 {{ detail.handbook.sources.messages }} 条 · 忆泡 {{ detail.handbook.sources.events }} 条
                    </span>
                  </footer>

                  <div class="journal-actions">
                    <el-button @click="openEdit('HANDBOOK')">
                      编辑
                    </el-button>
                    <el-button
                      :loading="regenerating"
                      @click="regenerate('HANDBOOK')"
                    >
                      重写手账
                    </el-button>
                    <el-button @click="openHistory('HANDBOOK')">
                      手账历史（{{ detail.revisionCounts.handbook }}）
                    </el-button>
                  </div>
                </template>
                <div
                  v-else
                  class="journal-empty-state"
                >
                  <p>这一天还没有手账。</p>
                  <el-button
                    :loading="writing"
                    @click="writeCurrent('HANDBOOK')"
                  >
                    写手账
                  </el-button>
                </div>
              </el-tab-pane>
            </el-tabs>

            <footer class="journal-foot journal-foot-cross">
              <NuxtLink
                class="btn-link"
                :to="{ path: '/days', query: { c: id } }"
              >
                去看那天的忆泡
              </NuxtLink>
            </footer>
          </template>

          <div
            v-else
            class="journal-empty-state"
          >
            <p>{{ selectedDay ? `${dayLabel(selectedDay)}还没有日记或手账。` : "选中左边的一天，或补写某一天。" }}</p>
          </div>
        </section>
      </div>
    </template>

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
      <div
        v-if="historyLoading"
        class="muted-note"
      >
        正在读取…
      </div>
      <div
        v-else-if="!revisions.length"
        class="muted-note"
      >
        还没有版本。
      </div>
      <div
        v-for="revision in revisions"
        :key="revision.id"
        class="history-item"
      >
        <div class="history-head">
          <span class="history-version">第 {{ revision.version }} 版</span>
          <span class="muted-note">{{ revisionTypeLabel(revision.revisionType) }} · {{ clockOf(revision.createdAt) }}</span>
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
.journal-toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 16px; margin-top: 16px; }
.toolbar-label { font-size: 13px; color: var(--text-2); }
.toolbar-gap { flex: 1; }
.journal-layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 18px; margin-top: 16px; }
.journal-list { padding: 16px; display: flex; flex-direction: column; gap: 6px; }
.journal-list-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; }
.journal-list-head h2 { font-size: 14px; font-weight: 600; color: var(--text-2); }
.journal-item { display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; cursor: pointer; text-align: left; }
.journal-item:hover { background: var(--surface-2, #f6f7fb); }
.journal-item.active { background: var(--surface-2, #f6f7fb); border-color: var(--line); }
.journal-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.journal-item-day { font-size: 13px; color: var(--text-2); font-weight: 600; }
.journal-item-badges { display: inline-flex; gap: 4px; }
.journal-item-line { font-size: 12px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.journal-item-muted { color: var(--faint); }
.journal-item-quote { font-size: 12px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.journal-empty { padding: 10px 0; }
.journal-detail { padding: 18px; }
.journal-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.journal-head h2 { font-size: 16px; font-weight: 600; color: var(--text-2); }
.journal-card { border-top: 1px solid var(--line); padding: 16px 0; }
.journal-card:first-of-type { border-top: 0; }
.journal-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.journal-card-head h3 { font-size: 14px; font-weight: 600; color: var(--text-2); }
.journal-card-sub { margin-left: 8px; font-size: 12px; font-weight: 400; color: var(--faint); }
.journal-content { font-size: 14px; line-height: 1.9; color: var(--dim); white-space: pre-wrap; }
.journal-thought { font-size: 13px; line-height: 1.8; color: var(--dim); }
.journal-quote-card { background: var(--surface-2, #faf9f6); border-radius: 10px; padding: 16px; border-top: 0; margin-top: 4px; }
.journal-quote { font-size: 16px; line-height: 1.8; color: var(--text-2); margin: 0; font-weight: 500; }
.journal-quote-note { margin-top: 8px; }
.journal-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.handbook-section { margin-top: 12px; }
.handbook-section:first-child { margin-top: 0; }
.handbook-section h4 { font-size: 13px; font-weight: 600; color: var(--text-2); margin-bottom: 6px; }
.handbook-section ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.handbook-section li { font-size: 13px; line-height: 1.8; color: var(--dim); }
.journal-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px dashed var(--line); padding-top: 12px; margin-top: 12px; }
.journal-foot-cross { border-top: 0; justify-content: flex-end; }
.journal-actions { display: flex; gap: 10px; margin-top: 14px; }
.journal-empty-state { padding: 28px 0; text-align: center; color: var(--dim); font-size: 13px; }
.journal-empty-state p { margin: 4px 0 12px; }
.history-item { border-top: 1px solid var(--line); padding: 12px 0; display: flex; flex-direction: column; gap: 8px; }
.history-item:first-child { border-top: 0; }
.history-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.history-version { font-size: 13px; font-weight: 600; color: var(--text-2); }
.history-preview { font-size: 12px; line-height: 1.7; color: var(--dim); margin: 0; }
.btn-link { background: none; border: 0; padding: 0; color: var(--dim); font-size: 12px; cursor: pointer; }
.btn-link:hover { color: var(--text-2); text-decoration: underline; }
@media (max-width: 900px) {
  .journal-layout { grid-template-columns: 1fr; }
  .journal-toolbar { flex-wrap: wrap; }
}
</style>
