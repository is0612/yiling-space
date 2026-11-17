<script setup lang="ts">
import type { Character } from "~/utils/mock-data";

type DailyUsage = {
  day: string;
  usage: { totalTokens: number; promptTokens: number; completionTokens: number; calls: number; byKind: Record<string, { totalTokens: number; calls: number }> };
  quota: { limit: number; used: number; remaining: number; exceeded: boolean };
};

const props = defineProps<{
  character: Character | null;
  providerLabel: string;
  apiKeySource: string;
  dailyUsage: DailyUsage | null;
  loadingUsage: boolean;
}>();
const emit = defineEmits<{ refresh: []; logs: [] }>();

const quotaPercent = computed(() => {
  const quota = props.dailyUsage?.quota;
  if (!quota || !quota.limit) return null;
  return Math.min(100, Math.round((quota.used / quota.limit) * 100));
});

const usageKinds = computed(() => Object.entries(props.dailyUsage?.usage.byKind ?? {}));

const KIND_LABELS: Record<string, string> = {
  chat: "对话接口",
  channel: "QQ 回复",
  snapshot: "阶段总结",
  events: "忆泡整理",
  journal: "日记/手账",
  "bili-screening": "值班粗筛",
  "bili-judge": "值班终判",
  proactive: "主动找话",
  vision: "群图片识别",
  "sticker-label": "表情包打标",
  "memory-assistant": "记忆助手",
  "context-assistant": "语境助手",
  "knowledge-assistant": "知识处理助手",
  "social-relationship-assistant": "关系评估助手",
  other: "其他",
};
</script>

<template>
  <aside class="ms-side">
    <section class="brick">
      <div class="card-head">
        <h2>当前配置</h2>
        <span class="sub">已写入数据库</span>
      </div>
      <div class="metric-row">
        <span>模型</span><span class="metric-value">{{ character?.chatModel || "未配置" }}</span>
      </div>
      <div class="metric-row">
        <span>服务商</span><span class="metric-value">{{ providerLabel }}</span>
      </div>
      <div class="metric-row">
        <span>API Key</span><span
          class="pill"
          :class="apiKeySource === 'missing' ? 'pill-rose' : 'pill-green'"
        >{{ apiKeySource === "character" ? "角色独立 Key" : apiKeySource === "environment" ? "服务端默认 Key" : "未配置" }}</span>
      </div>
      <div class="metric-row">
        <span>温度 / 上限</span><span class="metric-value">{{ character?.chatTemperature ?? "—" }} · {{ character?.chatMaxTokens ?? "—" }} tokens</span>
      </div>
      <div class="metric-row">
        <span>看图模型</span><span class="metric-value">{{ character?.visionModel || "跟随对话模型" }}</span>
      </div>
      <div class="metric-row">
        <span>记忆助手</span><span class="metric-value">{{ character?.memoryAssistantConfigured ? character.memoryAssistantModel : "未配置" }}</span>
      </div>
      <p class="side-note">
        模型未配置时，对话与自动归档会留在队列里，不会用规则摘要冒充 AI 输出。
      </p>
    </section>

    <section class="brick">
      <div class="card-head">
        <h2>今日用量</h2>
        <el-button
          text
          size="small"
          :disabled="!character"
          @click="emit('logs')"
        >
          调用日志
        </el-button>
      </div>

      <div class="usage-top">
        <span class="usage-value">{{ dailyUsage ? dailyUsage.usage.totalTokens.toLocaleString() : "—" }}</span>
        <span
          v-if="dailyUsage?.quota.limit"
          class="usage-limit"
        >/ {{ dailyUsage.quota.limit.toLocaleString() }} · {{ quotaPercent }}%</span>
        <span
          v-else
          class="usage-limit"
        >不限额度</span>
      </div>
      <div
        v-if="quotaPercent !== null"
        class="usage-bar"
        role="img"
        :aria-label="`今日用量 ${quotaPercent}%`"
      >
        <div
          class="usage-fill"
          :class="{ warn: quotaPercent >= 90 }"
          :style="{ width: quotaPercent + '%' }"
        />
      </div>

      <div class="metric-row">
        <span>调用次数</span><span class="metric-value">{{ dailyUsage?.usage.calls ?? 0 }}</span>
      </div>
      <div
        v-for="[kind, value] in usageKinds"
        :key="kind"
        class="metric-row"
      >
        <span>{{ KIND_LABELS[String(kind)] ?? kind }}</span>
        <span class="metric-value">{{ value.totalTokens.toLocaleString() }} · {{ value.calls }} 次</span>
      </div>

      <div class="usage-foot">
        <el-button
          text
          :loading="loadingUsage"
          @click="emit('refresh')"
        >
          {{ loadingUsage ? "刷新中…" : "刷新用量" }}
        </el-button>
        <span class="usage-note">额度用完不会自动清零：统计的是真实花费，调高额度或等次日恢复。</span>
      </div>
    </section>
  </aside>
</template>

<style scoped>
.brick { border-radius: 10px; background: var(--surface); padding: var(--sp-4) var(--sp-5); }
.card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: var(--sp-2); }
.card-head h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.card-head .sub { margin-left: auto; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }

/* 行线用最淡的 --surface-3，读数区不描边 */
.brick .metric-row { border-bottom: 0; padding: var(--sp-2) 0; color: var(--dim); }
.brick .metric-row + .metric-row { border-top: 1px solid var(--surface-3); }
.metric-value { max-width: 62%; color: var(--text-2); text-align: right; word-break: break-word; }
.brick .pill { border: 0; }

.usage-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--sp-2); margin: var(--sp-2) 0 var(--sp-2); }
.usage-value { color: var(--text); font-size: 22px; font-weight: 700; letter-spacing: -.015em; font-variant-numeric: tabular-nums; }
.usage-limit { color: var(--dim); font-size: 12px; font-weight: 600; }
.usage-bar { height: 6px; overflow: hidden; border-radius: 3px; background: var(--surface-3); }
.usage-fill { height: 100%; border-radius: 3px; background: var(--brand); transition: width .3s var(--ease); }
.usage-fill.warn { background: var(--amber); }
.usage-foot { display: flex; align-items: flex-start; gap: var(--sp-2); margin-top: var(--sp-3); }
.usage-note { flex: 1; color: var(--dim); font-size: 12px; line-height: 1.6; }
.side-note { margin: var(--sp-3) 0 0; border-radius: var(--radius-sm); background: var(--surface-2); padding: var(--sp-3); color: var(--dim); font-size: 12px; line-height: 1.7; }

.ms-side :deep(.el-button) { height: var(--ctl-h); border-radius: var(--radius-sm); padding: 0 var(--sp-4); font-size: 14px; font-weight: 600; }
.ms-side :deep(.el-button.is-text) { padding: 0 6px; color: var(--brand-strong); }
.ms-side :deep(.el-button.is-text:hover) { background: var(--brand-soft); color: var(--brand-btn-h); }

@media (max-width: 720px) {
  .brick { padding: var(--sp-4); }
}
</style>
