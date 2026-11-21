<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { createMemoryApi, type MemoryDayPage } from "~/api/memory";

/**
 * 忆泡月历：一个月一格，格子里写着那天有几条忆泡。
 *
 * 数据走 `listDays` 的区间模式（`from`/`to`），一个月最多 31 行，一次取完；
 * 没有记录的日子也会返回，所以空白天和「这天没整理」能分开看。
 */
const props = defineProps<{
  characterId: string;
  /** 当前选中的日期，用来高亮。 */
  selected?: string;
  /** 角色时区里的今天，用来标「今天」。 */
  today?: string;
}>();

const emit = defineEmits<{ select: [dayKey: string] }>();

const api = createMemoryApi(useApiRequest());
/** el-calendar 的 v-model 要 Date；月份字符串由它算出来。 */
const monthDate = ref(startOfMonth(props.selected || props.today || new Date().toISOString().slice(0, 10)));
const month = computed(() => monthDate.value.toISOString().slice(0, 7));
const loading = ref(false);
const counts = ref<Map<string, number>>(new Map());
const states = ref<Map<string, "DRAFT" | "FINAL">>(new Map());

function startOfMonth(day: string): Date {
  const [year, value] = day.slice(0, 7).split("-").map(Number);
  return new Date(Date.UTC(year!, value! - 1, 1));
}

const monthLabel = computed(() => `${month.value.slice(0, 4)} 年 ${Number(month.value.slice(5, 7))} 月`);

/** 月份起止；和服务端 `day-range.ts` 同一套规则，前端只需要算格子范围。 */
function monthRange(key: string): { from: string; to: string } | null {
  if (!/^d{4}-d{2}$/u.test(key)) return null;
  const [year, value] = key.split("-").map(Number);
  if (!year || !value || value < 1 || value > 12) return null;
  const lastDay = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(lastDay).padStart(2, "0")}` };
}

async function loadMonth(key: string) {
  const range = monthRange(key);
  if (!range) return;
  loading.value = true;
  try {
    const page: MemoryDayPage = await api.listDays({
      characterId: props.characterId, page: 1, pageSize: 31, from: range.from, to: range.to,
    });
    const nextCounts = new Map<string, number>();
    const nextStates = new Map<string, "DRAFT" | "FINAL">();
    for (const day of page.days) {
      if (day.eventCount > 0) nextCounts.set(day.dayKey, day.eventCount);
      if (day.state) nextStates.set(day.dayKey, day.state);
    }
    counts.value = nextCounts;
    states.value = nextStates;
  } catch {
    ElMessage.error("读取忆泡日历失败，请稍后重试。");
    counts.value = new Map();
    states.value = new Map();
  } finally {
    loading.value = false;
  }
}

function shiftMonth(step: number) {
  const next = new Date(Date.UTC(monthDate.value.getUTCFullYear(), monthDate.value.getUTCMonth() + step, 1));
  monthDate.value = next;
}

/** el-calendar 的日期格：只在有忆泡的日子上做标记，不改变点击行为。 */
function countOf(day: string) {
  return counts.value.get(day) ?? 0;
}

function stateOf(day: string) {
  return states.value.get(day);
}

function isToday(day: string) {
  return Boolean(props.today) && day === props.today;
}

watch(month, key => { void loadMonth(key); }, { immediate: true });
watch(() => props.characterId, () => { void loadMonth(month.value); });
</script>

<template>
  <section
    v-loading="loading"
    class="memory-calendar"
  >
    <header class="calendar-head">
      <el-button
        size="small"
        text
        :aria-label="'上个月'"
        @click="shiftMonth(-1)"
      >
        ‹ 上个月
      </el-button>
      <strong>{{ monthLabel }}</strong>
      <el-button
        size="small"
        text
        :aria-label="'下个月'"
        @click="shiftMonth(1)"
      >
        下个月 ›
      </el-button>
    </header>
    <el-calendar v-model="monthDate">
      <template #date-cell="{ data }">
        <div
          class="calendar-cell"
          :class="{
            'is-selected': data.day === props.selected,
            'is-today': isToday(data.day),
            'has-events': countOf(data.day) > 0,
          }"
          @click="emit('select', data.day)"
        >
          <span class="calendar-day">{{ Number(data.day.slice(8, 10)) }}</span>
          <span
            v-if="countOf(data.day) > 0"
            class="calendar-count"
          >{{ countOf(data.day) }} 条</span>
          <span
            v-else-if="stateOf(data.day) === 'DRAFT'"
            class="calendar-pending"
          >未整理</span>
        </div>
      </template>
    </el-calendar>
  </section>
</template>

<style scoped>
.memory-calendar {
  /* 放在两列网格里时占满整行：日历压在日期列表与详情之上。 */
  grid-column: 1 / -1;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 8px 12px 12px;
  background: var(--el-bg-color);
}
.calendar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 14px;
}
.calendar-cell {
  height: 100%;
  min-height: 44px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 4px;
  border-radius: 6px;
  cursor: pointer;
}
.calendar-cell.has-events {
  background: var(--el-color-primary-light-9);
}
.calendar-cell.is-selected {
  outline: 2px solid var(--el-color-primary);
  outline-offset: -2px;
}
.calendar-cell.is-today .calendar-day {
  color: var(--el-color-primary);
  font-weight: 600;
}
.calendar-day {
  font-size: 13px;
}
.calendar-count {
  font-size: 12px;
  color: var(--el-color-primary);
}
.calendar-pending {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
