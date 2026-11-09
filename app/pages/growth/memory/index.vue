<script setup lang="ts">
import { Loading, MagicStick } from "@element-plus/icons-vue";
import {
  ensureMemoryProgressPolling,
  isActiveMemoryJob,
  useMemoryProgress,
} from "~/composables/useMemoryProgress";
import { useMemoryActions } from "~/composables/useMemoryActions";

definePageMeta({
  topbar: { title: "记忆系统" },
});

await useCharacterListData();
const characters = useCharacterList();
/** 总览页不绑定具体角色，跟随侧栏那个「当前角色」；切换角色时地址栏带 ?c=，这里会跟着走。 */
const { id, character } = useCharacterSelection("/growth/memory");

const { snapshotGenerating, eventExtracting, runSnapshotGeneration, runEventExtraction } = useMemoryActions(
  () => id.value,
  () => character.value?.name ?? "",
);

/**
 * 任务真的在跑的时候，按钮要一直禁用。
 *
 * `snapshotGenerating` / `eventExtracting` 只覆盖「请求还在等」的那几秒 —— 超时后服务端把响应放回来、
 * 执行转到后台，这时候按钮会恢复，连点第二下就会多排一次队。所以还要读任务表，
 * 让按钮跟着 DB 里的状态走（进度面板本来就在轮询这份数据）。
 */
const { jobs } = useMemoryProgress();
function running(type: "EXTRACT_EVENTS" | "GENERATE_SNAPSHOT") {
  return jobs.value.some(
    (job) => job.characterId === id.value && job.type === type && isActiveMemoryJob(job.status),
  );
}
const eventRunning = computed(() => eventExtracting.value || running("EXTRACT_EVENTS"));
const snapshotRunning = computed(() => snapshotGenerating.value || running("GENERATE_SNAPSHOT"));

onMounted(() => ensureMemoryProgressPolling());
</script>

<template>
  <div class="page-wrap">
    <MemorySectionNavigation active="overview" />
    <PageHeader
      eyebrow="成长系统 / 记忆系统"
      description="管理她记住的内容、每天发生的事，以及一段时间里的成长总结。"
    />

    <!-- 忆泡整理与阶段总结生成统一在总览页操作，子页负责查看和维护内容。 -->
    <section
      class="memory-quickbar"
      aria-label="快捷操作"
    >
      <div class="memory-quickbar-text">
        <h2>快捷操作</h2>
        <p v-if="character">
          当前角色「{{ character.name }}」。整理忆泡只处理还没整理过的对话；阶段总结会调模型生成一份总结并更新长期记忆。进度都在右下角，切页面不受影响。
        </p>
        <p v-else-if="characters.length">
          先在上方选一个角色，再整理她的记忆。
        </p>
        <p v-else>
          还没有角色，创建后再回来整理记忆。
        </p>
      </div>
      <div class="memory-quickbar-actions">
        <button
          type="button"
          class="btn"
          :disabled="!character || eventRunning"
          :aria-busy="eventRunning"
          :title="`把「昨天收口」和「今天增量」排进队列并当场跑一次`"
          @click="runEventExtraction"
        >
          <el-icon
            v-if="eventRunning"
            class="is-loading"
          >
            <Loading />
          </el-icon>
          <el-icon v-else>
            <MagicStick />
          </el-icon>{{ eventRunning ? "整理中…" : "整理忆泡" }}
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="!character || snapshotRunning"
          :aria-busy="snapshotRunning"
          title="等同于自动归档跑一次：排队、调模型、当场执行"
          @click="runSnapshotGeneration"
        >
          <el-icon
            v-if="snapshotRunning"
            class="is-loading"
          >
            <Loading />
          </el-icon>
          <el-icon v-else>
            <MagicStick />
          </el-icon>{{ snapshotRunning ? "生成中…" : "阶段总结" }}
        </button>
      </div>
    </section>

    <section
      class="memory-overview-grid"
      aria-label="记忆功能"
    >
      <NuxtLink
        to="/growth/memory/long-term"
        class="memory-overview-card"
      >
        <span class="memory-overview-kicker">01 · 长期记忆</span>
        <h2>长期记忆</h2>
        <p>查看、搜索和编辑已经沉淀下来的事实、偏好、关系、目标与约定，也能追溯来源。</p>
        <span class="memory-overview-action">管理长期记忆 <span aria-hidden="true">→</span></span>
      </NuxtLink>

      <NuxtLink
        to="/growth/memory/events"
        class="memory-overview-card"
      >
        <span class="memory-overview-kicker">02 · 忆泡日历</span>
        <h2>忆泡日历</h2>
        <p>按日期回看整理过的事件，查看当时的对话原文，修改或隐藏不需要的忆泡。</p>
        <span class="memory-overview-action">查看日历 / 编辑忆泡 <span aria-hidden="true">→</span></span>
      </NuxtLink>

      <NuxtLink
        to="/growth/memory/snapshots"
        class="memory-overview-card"
      >
        <span class="memory-overview-kicker">03 · 阶段总结</span>
        <h2>阶段总结</h2>
        <p>回顾一段时间内的经历、变化、关系与目标，查看 AI 提炼结果和历史版本。</p>
        <span class="memory-overview-action">查看历史总结 <span aria-hidden="true">→</span></span>
      </NuxtLink>
    </section>

    <section class="memory-overview-tools">
      <div>
        <h2>常用入口</h2>
        <p>执行动作在上面，这里只负责跳到对应页面细看。</p>
      </div>
      <div class="memory-overview-shortcuts">
        <NuxtLink to="/growth/memory/long-term">
          新增 / 编辑长期记忆
        </NuxtLink>
        <NuxtLink to="/growth/memory/events">
          看每天整理出的忆泡
        </NuxtLink>
        <NuxtLink to="/growth/memory/snapshots">
          查看与管理历史总结
        </NuxtLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ── 快捷操作 ──────────────────────────────────────── */
.memory-quickbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  margin-top: var(--sp-4);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 16px 20px;
}
.memory-quickbar h2 {
  margin: 0;
  color: var(--text-2);
  font-size: 14px;
  font-weight: 600;
}
.memory-quickbar p {
  margin: 6px 0 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 1.6;
}
.memory-quickbar-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--sp-2);
}

/* ── 功能卡片 ──────────────────────────────────────── */
.memory-overview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 18px;
}
.memory-overview-card {
  display: flex;
  min-height: 220px;
  flex-direction: column;
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 20px;
  color: inherit;
  text-decoration: none;
  transition: background .15s ease, transform .15s ease;
}
.memory-overview-card:hover {
  background: var(--surface-2, #f6f7fb);
  transform: translateY(-2px);
}
.memory-overview-kicker {
  color: var(--dim);
  font-size: 12px;
  letter-spacing: .04em;
}
.memory-overview-card h2 {
  margin: 18px 0 8px;
  color: var(--text-2);
  font-size: 17px;
  font-weight: 650;
}
.memory-overview-card p {
  margin: 0;
  color: var(--dim);
  font-size: 13px;
  line-height: 1.85;
}
.memory-overview-action {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: auto;
  padding-top: 20px;
  color: var(--accent, #0d9488);
  font-size: 13px;
  font-weight: 600;
}
.memory-overview-tools {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  margin-top: 18px;
  border-radius: 12px;
  background: var(--surface, #fff);
  padding: 18px 20px;
}
.memory-overview-tools h2 {
  margin: 0;
  color: var(--text-2);
  font-size: 14px;
}
.memory-overview-tools p {
  margin: 6px 0 0;
  color: var(--dim);
  font-size: 12px;
}
.memory-overview-shortcuts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.memory-overview-shortcuts a {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  border-radius: 7px;
  background: var(--surface-2, #f6f7fb);
  padding: 0 11px;
  color: var(--text-2);
  font-size: 12px;
  text-decoration: none;
}
.memory-overview-shortcuts a:hover {
  color: var(--accent, #0d9488);
}
@media (max-width: 900px) {
  .memory-quickbar { flex-direction: column; align-items: stretch; }
  .memory-quickbar-actions { justify-content: flex-start; }
  .memory-overview-grid { grid-template-columns: 1fr; }
  .memory-overview-card { min-height: 180px; }
  .memory-overview-tools { flex-direction: column; }
  .memory-overview-shortcuts { justify-content: flex-start; }
}
</style>
