<script setup lang="ts">
import { ArrowRight, Calendar, Collection, Document, Loading, MagicStick, Refresh, Setting } from "@element-plus/icons-vue";
import {
  ensureMemoryProgressPolling,
  isActiveMemoryJob,
  useMemoryProgress,
} from "~/composables/useMemoryProgress";
import { useMemoryActions } from "~/composables/useMemoryActions";

definePageMeta({ topbar: { title: "记忆系统" } });

await useCharacterListData();
const characters = useCharacterList();
const characterListError = useCharacterListError();
const { id, character } = useCharacterSelection("/growth/memory");
const extractionDialogOpen = ref(false);
const { snapshotGenerating, runSnapshotGeneration } = useMemoryActions(
  () => id.value,
  () => character.value?.name ?? "",
);
const { jobs, lastFinished } = useMemoryProgress();
function running(type: "EXTRACT_EVENTS" | "GENERATE_SNAPSHOT") {
  return jobs.value.some(
    (job) => job.characterId === id.value && job.type === type && isActiveMemoryJob(job.status),
  );
}
const eventRunning = computed(() => running("EXTRACT_EVENTS"));
const snapshotRunning = computed(() => snapshotGenerating.value || running("GENERATE_SNAPSHOT"));
const currentJobs = computed(() => jobs.value.filter((job) => job.characterId === id.value && isActiveMemoryJob(job.status)));
const taskSummary = computed(() => {
  if (currentJobs.value.some((job) => job.leaseExpired)) return "有任务需要处理";
  if (currentJobs.value.some((job) => job.status === "RETRY_WAIT")) return "有任务等待重试";
  if (currentJobs.value.some((job) => job.status === "RUNNING")) return "正在整理记忆";
  if (currentJobs.value.length) return "有任务等待执行";
  return "暂无进行中的任务";
});

type MemoryStats = { memory: number; commitment: number; message: number; event: number; snapshot: number; memoryEvent: number };
const stats = ref<MemoryStats | null>(null);
const statsLoading = ref(false);
const statsError = ref(false);
let statsRequest = 0;
async function loadStats() {
  const characterId = id.value;
  const request = ++statsRequest;
  stats.value = null;
  statsError.value = false;
  statsLoading.value = false;
  if (!characterId || !character.value) return;
  statsLoading.value = true;
  try {
    const result = await $fetch<MemoryStats>(`/api/characters/${encodeURIComponent(characterId)}/memory-stats`);
    if (request === statsRequest && characterId === id.value) stats.value = result;
  } catch {
    if (request === statsRequest && characterId === id.value) statsError.value = true;
  } finally {
    if (request === statsRequest) statsLoading.value = false;
  }
}
function count(value: number | undefined) {
  return value === undefined ? "—" : value.toLocaleString("zh-CN");
}
function memoryLink(path: string) {
  return { path, query: id.value ? { c: id.value } : {} };
}
const sections = computed(() => [
  { path: "/growth/memory/events", icon: Calendar, tone: "mint", label: "忆泡日历", question: "发生过什么", description: "按天回看具体经历，找到当时的人、事和对话依据。", value: stats.value?.memoryEvent, unit: "条忆泡", action: "回看每天的经历" },
  { path: "/growth/memory/snapshots", icon: Document, tone: "blue", label: "阶段总结", question: "这一段有什么变化", description: "回顾一段时间的经历与变化，查看提炼结果和历史版本。", value: stats.value?.snapshot, unit: "份总结记录", action: "查看阶段总结" },
  { path: "/growth/memory/long-term", icon: Collection, tone: "rose", label: "长期记忆", question: "什么值得一直记住", description: "维护事实、偏好、关系与约定，让重要的信息持续留存。", value: stats.value?.memory, unit: "条长期记忆", action: "管理记住的内容" },
]);
watch(id, () => {
  extractionDialogOpen.value = false;
  void loadStats();
});
watch(lastFinished, (finished) => {
  if (finished?.characterId === id.value) void loadStats();
});
onMounted(() => {
  ensureMemoryProgressPolling();
  void loadStats();
});
onBeforeUnmount(() => { statsRequest += 1; });
</script>

<template>
  <div class="page-wrap memory-home">
    <MemorySectionNavigation active="overview" />
    <PageHeader
      description="从每天的经历，到值得一直记住的事。"
    >
      <template #actions>
        <NuxtLink
          v-if="character"
          :to="memoryLink(`/characters/${id}/settings/memory`)"
          class="memory-settings-link"
        >
          <el-icon><Setting /></el-icon>记忆设置
        </NuxtLink>
      </template>
    </PageHeader>

    <template v-if="character">
      <section
        class="memory-hero"
        aria-label="当前角色的记忆"
      >
        <div class="hero-copy">
          <span class="hero-eyebrow">记忆档案 · {{ character.name }}</span>
          <h2>让每一次相处，都有迹可循</h2>
          <p>把对话整理成经历，再从经历中沉淀长期记忆。</p>
          <div class="hero-actions">
            <el-button
              type="primary"
              :icon="eventRunning ? Loading : MagicStick"
              @click="extractionDialogOpen = true"
            >
              {{ eventRunning ? "查看整理进度" : "整理忆泡" }}
            </el-button>
            <el-button
              :loading="snapshotRunning"
              @click="runSnapshotGeneration"
            >
              {{ snapshotRunning ? "总结生成中" : "生成阶段总结" }}
            </el-button>
          </div>
          <span class="hero-hint">整理前可预览对话范围；生成阶段总结会调用模型并更新长期记忆。</span>
        </div>
        <div
          class="hero-record"
          aria-label="原始记录统计"
        >
          <span>记忆从这里开始</span>
          <div
            class="record-count"
            :aria-busy="statsLoading"
          >
            {{ count(stats?.message) }}<small>条对话记录</small>
          </div>
          <p>原始对话是整理和追溯的依据，<br>保留期限与总结周期分别设置。</p>
          <NuxtLink :to="memoryLink('/growth/memory/long-term')">
            查看记忆与来源 <el-icon><ArrowRight /></el-icon>
          </NuxtLink>
        </div>
      </section>

      <div
        v-if="statsError"
        class="stats-error"
        role="status"
      >
        <span>暂时无法读取记忆统计，请稍后重试。</span>
        <el-button
          link
          type="primary"
          :icon="Refresh"
          @click="loadStats"
        >
          重新读取
        </el-button>
      </div>

      <div class="section-heading">
        <h2>浏览记忆</h2>
        <span>经历 → 阶段回顾 → 长期沉淀</span>
      </div>
      <section
        class="memory-overview-grid"
        aria-label="记忆分类"
      >
        <NuxtLink
          v-for="section in sections"
          :key="section.path"
          :to="memoryLink(section.path)"
          class="memory-overview-card"
          :class="section.tone"
        >
          <div class="overview-card-top">
            <span class="section-icon"><el-icon><component :is="section.icon" /></el-icon></span>
            <span class="section-question">{{ section.question }}</span>
          </div>
          <h3>{{ section.label }}</h3>
          <p>{{ section.description }}</p>
          <div
            class="section-count"
            :aria-busy="statsLoading"
          >
            <strong>{{ count(section.value) }}</strong><span>{{ section.unit }}</span>
          </div>
          <span class="memory-overview-action">{{ section.action }}<el-icon><ArrowRight /></el-icon></span>
        </NuxtLink>
      </section>

      <section
        class="memory-bottom-grid"
        aria-label="整理状态与计划"
      >
        <div class="memory-info-card">
          <div class="info-heading">
            <h2>整理状态</h2><NuxtLink :to="memoryLink('/tasks')">
              任务监控 <span aria-hidden="true">↗</span>
            </NuxtLink>
          </div>
          <div class="task-state">
            <span
              class="state-dot"
              :class="{ busy: currentJobs.length }"
            />{{ taskSummary }}
          </div>
          <p>关闭页面后，已保存的进度会保留。后续执行与重试需要后台 Worker 持续运行。</p>
          <el-button
            v-if="eventRunning"
            link
            type="primary"
            @click="extractionDialogOpen = true"
          >
            查看忆泡整理详情 <el-icon><ArrowRight /></el-icon>
          </el-button>
        </div>
        <div class="memory-info-card">
          <div class="info-heading">
            <h2>总结计划</h2><NuxtLink :to="memoryLink(`/characters/${id}/settings/memory`)">
              调整计划 <span aria-hidden="true">↗</span>
            </NuxtLink>
          </div>
          <dl class="schedule-details">
            <div><dt>总结周期</dt><dd>每 {{ character.intervalDays }} 天</dd></div>
            <div><dt>下次计划</dt><dd>{{ character.nextSnapshot || "尚未计划" }}</dd></div>
          </dl>
          <p v-if="character.pendingIntervalDays">
            下个周期起调整为每 {{ character.pendingIntervalDays }} 天。
          </p>
          <p v-else>
            按角色的周期设置整理阶段经历，实际执行情况可在任务监控中查看。
          </p>
        </div>
      </section>
    </template>
    <el-empty
      v-else
      :description="characterListError || (characters.length ? '请选择一个角色，查看它的记忆档案' : '创建第一个角色，开始积累属于它的记忆')"
    >
      <NuxtLink
        v-if="!characters.length && !characterListError"
        to="/characters"
        class="btn primary"
      >
        前往创建角色
      </NuxtLink>
    </el-empty>

    <MemoryExtractionDialog
      v-model="extractionDialogOpen"
      :character-id="id"
      :character-name="character?.name ?? ''"
    />
  </div>
</template>

<style scoped>
.memory-home { --memory-mint: #237b69; }
.memory-settings-link { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 13px; }
.memory-settings-link:hover { color: var(--brand-strong); }
.memory-hero { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 28px; border: 0; border-radius: 16px; background: linear-gradient(115deg, var(--surface, #fff) 45%, #f0f7f4); padding: 30px; }
.hero-eyebrow { color: var(--memory-mint); font-size: 12px; font-weight: 600; }
.hero-copy h2 { margin: 12px 0 10px; color: var(--text); font-size: 25px; font-weight: 650; line-height: 1.5; }
.hero-copy p { margin: 0; color: var(--dim); font-size: 14px; line-height: 1.8; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 23px; }
.hero-actions .el-button { margin: 0; min-height: 36px; }
.hero-hint { display: block; margin-top: 12px; color: var(--dim); font-size: 12px; line-height: 1.8; }
.hero-record { align-self: center; border-left: 1px solid #dce9e3; padding-left: 28px; }
.hero-record > span { color: var(--memory-mint); font-size: 12px; font-weight: 600; }
.record-count { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-top: 12px; color: var(--text); font-size: 34px; font-weight: 600; font-variant-numeric: tabular-nums; }
.record-count small { color: var(--dim); font-size: 12px; font-weight: 400; }
.hero-record p { margin: 10px 0 16px; color: var(--dim); font-size: 12px; line-height: 1.9; }
.hero-record a { display: inline-flex; align-items: center; gap: 7px; color: var(--memory-mint); font-size: 12px; font-weight: 600; }
.section-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin: 26px 0 12px; }
.section-heading h2, .info-heading h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 600; }
.section-heading > span { color: var(--dim); font-size: 12px; }
.memory-overview-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.memory-overview-card { --section-color: var(--memory-mint); --section-soft: #edf6f1; display: flex; min-width: 0; flex-direction: column; border: 0; border-radius: 12px; background: var(--surface, #fff); padding: 22px; color: inherit; text-decoration: none; transition: border-color .15s ease, box-shadow .15s ease; }
.memory-overview-card.blue { --section-color: #476aaf; --section-soft: #edf2fc; }
.memory-overview-card.rose { --section-color: var(--brand-strong); --section-soft: var(--brand-soft); }
.memory-overview-card:hover { background: var(--surface-2); }
.memory-overview-card:focus-visible, .memory-settings-link:focus-visible { outline: 2px solid var(--brand); outline-offset: 4px; }
.overview-card-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.section-icon { display: grid; width: 38px; height: 38px; flex: none; place-items: center; border-radius: 11px; background: var(--section-soft); color: var(--section-color); font-size: 20px; }
.section-question { color: var(--dim); font-size: 12px; }
.memory-overview-card h3 { margin: 18px 0 8px; color: var(--text); font-size: 17px; font-weight: 600; }
.memory-overview-card p { margin: 0; color: var(--dim); font-size: 13px; line-height: 1.85; }
.section-count { display: flex; align-items: baseline; gap: 8px; margin-top: auto; padding-top: 20px; }
.section-count strong { color: var(--text-2); font-size: 27px; font-weight: 600; font-variant-numeric: tabular-nums; }
.section-count span { color: var(--dim); font-size: 12px; }
.memory-overview-action { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 16px; border-top: 1px solid var(--line); padding-top: 14px; color: var(--section-color); font-size: 13px; font-weight: 500; }
.memory-bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 18px; }
.memory-info-card { min-width: 0; border-radius: 12px; background: var(--surface, #fff); padding: 20px 22px; }
.info-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.info-heading a { color: var(--dim); font-size: 12px; }
.info-heading a:hover { color: var(--brand-strong); }
.memory-info-card p { margin: 12px 0 0; color: var(--dim); font-size: 12px; line-height: 1.9; }
.memory-info-card > .el-button { margin-top: 12px; }
.task-state { display: flex; align-items: center; gap: 8px; margin-top: 20px; color: var(--text-2); font-size: 13px; }
.state-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dim); }
.state-dot.busy { background: #b97821; }
.schedule-details { display: flex; flex-wrap: wrap; gap: 16px 30px; margin: 18px 0 0; }
.schedule-details > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.schedule-details dt { color: var(--dim); font-size: 12px; }
.schedule-details dd { margin: 0; color: var(--text-2); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.stats-error { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; color: var(--dim); font-size: 12px; }
@media (max-width: 1100px) { .memory-hero { grid-template-columns: minmax(0, 1fr) 220px; padding: 24px; gap: 20px; } .hero-record { padding-left: 20px; } .memory-overview-card { padding: 18px; } .section-question { max-width: 100px; text-align: right; line-height: 1.6; } }
@media (max-width: 760px) { .memory-hero { grid-template-columns: 1fr; padding: 22px; } .hero-copy h2 { font-size: 22px; } .hero-record { border-left: 0; border-top: 1px solid #dce9e3; padding: 18px 0 0; } .hero-record p br { display: none; } .memory-overview-grid, .memory-bottom-grid { grid-template-columns: 1fr; } .section-question { max-width: none; } .section-count { padding-top: 16px; } }
</style>
