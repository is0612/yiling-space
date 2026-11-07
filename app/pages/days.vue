<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { type Character } from "~/utils/mock-data";
import { formatDayClock } from "~/utils/day-time";

// 标题放顶栏（AppShell 读 route.meta.topbar），正文页头只留 crumb 和说明。
definePageMeta({
  topbar: { title: "忆泡日历" },
});

/**
 * 忆泡日历：一天一行，点开看那天发生了什么。
 *
 * 数据源是 `memory_event_days`（整理进度）+ `memory_events`（当天的忆泡），
 * 不是从时间线反推的 —— 这样「今天还没整理」也能作为一行出现。
 */
await useCharacterListData();
const { id } = useCharacterSelection("/days");

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
  messageGroups: DayMessageGroup[];
  usage: { calls: number; tokens: number };
  timeZone: string;
  eventsTotal: number;
  eventsTruncated: boolean;
} | null>(null);
/** 原文总数：按会话分组后要自己加总。用当天真实条数，不是「载进来的条数」。 */
const totalMessages = computed(() => (detail.value?.messageGroups ?? []).reduce((sum, group) => sum + (group.total ?? group.messages.length), 0));
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

    const nextSelected = result.days.some((day) => day.dayKey === selected.value)
      ? selected.value
      : result.days[0]?.dayKey ?? "";
    if (nextSelected !== selected.value) {
      selected.value = nextSelected;
      // selected watcher owns loading the newly selected day's detail.
    } else if (nextSelected) {
      // The selection did not change, so its watcher will not run.
      void loadDetail(nextSelected, targetCharacterId);
    } else {
      detailRequestSeq += 1;
      detail.value = null;
      detailLoading.value = false;
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
  const seq = ++detailRequestSeq;
  if (!targetCharacterId || targetCharacterId !== id.value || !dayKey) return;
  detailLoading.value = true;
  try {
    // URL 先落成 string 再传：模板字面量的字面类型会让 Nuxt 的路由类型推导爆栈（TS2321）。
    const url: string = `/api/characters/${encodeURIComponent(targetCharacterId)}/days/${encodeURIComponent(dayKey)}?page=${page}`;
    const result = await $fetch<{
      day: DayRow | null;
      events: DayEvent[];
      messageGroups: DayMessageGroup[];
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
    showMessages.value = false;
  } catch {
    if (seq !== detailRequestSeq || targetCharacterId !== id.value || dayKey !== selected.value) return;
    detail.value = null;
    ElMessage.error("这一天的忆泡读取失败。");
  } finally {
    if (seq === detailRequestSeq) detailLoading.value = false;
  }
}

watch(id, () => {
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
  editOpen.value = false;
  editing.value = null;
  editSaving.value = false;
  form.value = { title: "", detail: "", place: "", participants: "" };
  if (searchTimer) clearTimeout(searchTimer);
  void loadDays(id.value);
});
watch(selected, (dayKey) => {
  eventsPage.value = 1;
  if (dayKey) void loadDetail(dayKey, id.value, 1);
  else {
    detailRequestSeq += 1;
    detail.value = null;
    detailLoading.value = false;
  }
});
// 搜索：300ms 防抖。输入变化的当下就让旧请求失效，而不是等下一个请求发出。
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(searchQuery, () => {
  if (searchTimer) clearTimeout(searchTimer);
  daysRequestSeq += 1;
  detailRequestSeq += 1;
  days.value = [];
  daysTotal.value = 0;
  daysPage.value = 1;
  selected.value = "";
  detail.value = null;
  detailLoading.value = false;
  loading.value = true;
  searchTimer = setTimeout(() => {
    searchTimer = null;
    void loadDays(id.value);
  }, 300);
});
onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
  daysRequestSeq += 1;
  detailRequestSeq += 1;
  editSaveSeq += 1;
});

await loadDays();
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="工作空间 / 角色记忆"
      description="一天一行，点开看那天发生了什么。忆泡是整理过的事件，原文是当时的对话。"
    />
    <CharacterBar
      path="/days"
      empty-text="先创建一个角色，这里才会按天记录她经历过的事。"
    />

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
          size="small"
          placeholder="搜忆泡标题或详情"
          clearable
        />
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
          还没有整理过任何一天。点「角色记忆」页的「立即整理忆泡」试试。
        </div>
        <button
          v-for="day in days"
          :key="day.dayKey"
          type="button"
          class="day-item"
          :class="{ active: day.dayKey === selected }"
          @click="selected = day.dayKey"
        >
          <span class="day-item-label">{{ dayLabel(day.dayKey) }}</span>
          <span class="day-item-meta">
            {{ day.eventCount }} 条
            <span v-if="day.state === 'DRAFT'" class="day-item-draft">还在记</span>
          </span>
        </button>
        <el-pagination
          v-if="daysTotal > daysPageSize"
          class="day-pagination"
          small
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
            <h2>{{ dayLabel(detail.day?.dayKey ?? selected) }}</h2>
            <span class="muted-note">
              {{ detail.eventsTotal }} 条忆泡
              <template v-if="detail.day?.extractedAt"> · 上次整理 {{ clockOf(detail.day.extractedAt) }}</template>
              <template v-if="detail.usage.calls">
                · 整理 {{ detail.usage.calls }} 次 · {{ formatTokens(detail.usage.tokens) }} tokens
              </template>
            </span>
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
              已隐藏 {{ archivedEvents.length }} 条<template v-if="detail.eventsTruncated">（当前展示范围）</template>
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
            small
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
              @click="showMessages = !showMessages"
            >
              {{ showMessages ? "收起原文" : `查看当天原文（${totalMessages} 条）` }}
            </button>
            <div
              v-if="showMessages"
              class="original-list"
            >
              <template
                v-for="group in detail.messageGroups"
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
      v-model="editOpen"
      title="编辑忆泡"
      width="520px"
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
.original-group { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; font-size: 12px; font-weight: 600; color: var(--text-2); }
.original-group-n { font-weight: 400; color: var(--faint); font-size: 12px; }
.original-line { display: flex; gap: 8px; font-size: 13px; line-height: 1.7; }
/* 定宽而不是自适应：昵称长短不一时，正文那列才不会左右跳。 */
.original-role { flex: 0 0 6.5em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--faint); font-size: 12px; }
.original-text { color: var(--dim); }
@media (max-width: 900px) {
  .day-layout { grid-template-columns: 1fr; }
}
</style>
