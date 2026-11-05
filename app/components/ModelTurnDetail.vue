<script lang="ts">
export type TurnMessage = {
  id?: string;
  member?: string;
  speaker?: string;
  content: string;
  occurredAt?: string;
};
export type ModelTurnDetailResponse = {
  turnId: string;
  createdAt: string;
  detail: {
    version: 1;
    groupChat: boolean;
    messages: TurnMessage[];
    context: {
      status: "not_enabled" | "not_applicable" | "success" | "failed";
      summary?: string;
      participation?: "invited" | "observing" | "uncertain";
      uncertainty?: string;
      evidence?: TurnMessage[];
    };
    memory: {
      status: "not_needed" | "not_enabled" | "no_sources" | "failed" | "success";
      query?: string;
      sources?: Array<{
        id: string;
        type: "memory" | "snapshot" | "event" | "message";
        scope: "character" | "private";
        title?: string;
        content: string;
        occurredAt?: string;
      }>;
    };
    response: {
      status: "success" | "failed";
      action?: "reply" | "silent";
      reply?: string;
      explanation?: string;
    };
  };
};
</script>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
  result: ModelTurnDetailResponse;
}>();
const detail = computed(() => props.result.detail);
const contextLabels = {
  not_enabled: "未启用语境助手",
  not_applicable: "本轮不适用语境助手",
  success: "语境整理完成",
  failed: "语境整理失败",
};
const memoryLabels = {
  not_needed: "本轮无需检索记忆",
  not_enabled: "未启用记忆助手",
  no_sources: "已检索，未找到相关来源",
  failed: "记忆检索失败",
  success: "记忆检索完成",
};
const participationLabels = { invited: "受邀参与", observing: "旁观对话", uncertain: "参与关系不确定" };
const sourceLabels = { memory: "长期记忆", snapshot: "周期快照", event: "忆泡", message: "原始消息" };
const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未记录" : timeFormatter.format(date);
}
function shortId(value: string) {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}
function messageAuthor(message: TurnMessage) {
  return [message.speaker, message.member].filter(Boolean).join(" · ") || "发言人未记录";
}
</script>

<template>
  <div class="turn-detail">
    <el-alert
      title="本轮消息、来源与回应说明"
      description="仅角色所有者可见。这里展示保存的消息、结构化来源和简短回应说明，不是模型内部思考过程。时间为北京时间。"
      type="info"
      :closable="false"
      show-icon
    />
    <p class="turn-meta">
      {{ detail.groupChat ? '群聊' : '对话' }} · {{ formatTime(result.createdAt) }} · 轮次 {{ shortId(result.turnId) }}
    </p>

    <section class="turn-section">
      <h3>本轮消息</h3>
      <ol
        v-if="detail.messages.length"
        class="record-list"
      >
        <li
          v-for="(message, index) in detail.messages"
          :key="index"
          class="record-card"
        >
          <div class="record-meta">
            <strong>{{ messageAuthor(message) }}</strong>
            <span v-if="message.occurredAt">{{ formatTime(message.occurredAt) }}</span>
            <span v-if="message.id">消息 {{ shortId(message.id) }}</span>
          </div>
          <p class="plain-text">
            {{ message.content }}
          </p>
        </li>
      </ol>
      <p
        v-else
        class="empty-text"
      >
        本轮未保存消息内容。
      </p>
    </section>

    <section class="turn-section">
      <h3>语境理解</h3>
      <el-tag :type="detail.context.status === 'failed' ? 'warning' : 'info'">
        {{ contextLabels[detail.context.status] }}
      </el-tag>
      <p v-if="detail.context.participation">
        参与关系：{{ participationLabels[detail.context.participation] }}
      </p>
      <p
        v-if="detail.context.summary"
        class="plain-text"
      >
        {{ detail.context.summary }}
      </p>
      <p
        v-if="detail.context.uncertainty"
        class="plain-text"
      >
        不确定之处：{{ detail.context.uncertainty }}
      </p>
      <template v-if="detail.context.evidence?.length">
        <h4>消息依据</h4>
        <ol class="record-list">
          <li
            v-for="(message, index) in detail.context.evidence"
            :key="index"
            class="record-card"
          >
            <div class="record-meta">
              <strong>{{ messageAuthor(message) }}</strong>
              <span v-if="message.occurredAt">{{ formatTime(message.occurredAt) }}</span>
              <span v-if="message.id">消息 {{ shortId(message.id) }}</span>
            </div>
            <p class="plain-text">
              {{ message.content }}
            </p>
          </li>
        </ol>
      </template>
    </section>

    <section class="turn-section">
      <h3>记忆检索</h3>
      <el-tag :type="detail.memory.status === 'failed' ? 'warning' : 'info'">
        {{ memoryLabels[detail.memory.status] }}
      </el-tag>
      <p
        v-if="detail.memory.query"
        class="plain-text"
      >
        检索问题：{{ detail.memory.query }}
      </p>
      <ol
        v-if="detail.memory.sources?.length"
        class="record-list"
      >
        <li
          v-for="(source, index) in detail.memory.sources"
          :key="index"
          class="record-card"
        >
          <div class="record-meta">
            <el-tag size="small">
              {{ sourceLabels[source.type] }}
            </el-tag>
            <el-tag
              size="small"
              type="info"
            >
              {{ source.scope === 'private' ? '私人记忆' : '角色全局' }}
            </el-tag>
            <span>记录 {{ shortId(source.id) }}</span>
            <span v-if="source.occurredAt">{{ formatTime(source.occurredAt) }}</span>
          </div>
          <h4 v-if="source.title">
            {{ source.title }}
          </h4>
          <p class="plain-text">
            {{ source.content }}
          </p>
        </li>
      </ol>
      <p
        v-else-if="detail.memory.status === 'success'"
        class="empty-text"
      >
        本轮未保存来源内容。
      </p>
    </section>

    <section class="turn-section">
      <h3>回应结果</h3>
      <div class="record-meta">
        <el-tag :type="detail.response.status === 'success' ? 'success' : 'danger'">
          {{ detail.response.status === 'success' ? '生成完成' : '生成失败' }}
        </el-tag>
        <span v-if="detail.response.action">{{ detail.response.action === 'reply' ? '选择回复' : '选择沉默' }}</span>
      </div>
      <template v-if="detail.response.reply">
        <h4>回复内容</h4>
        <p class="plain-text">
          {{ detail.response.reply }}
        </p>
      </template>
      <h4>回应说明</h4>
      <p
        v-if="detail.response.explanation"
        class="plain-text"
      >
        {{ detail.response.explanation }}
      </p>
      <p
        v-else
        class="empty-text"
      >
        历史/本轮未提供回应说明，不代表没有判断。
      </p>
    </section>
  </div>
</template>

<style scoped>
.turn-detail { display: flex; flex-direction: column; gap: 18px; color: var(--text-2); font-size: 14px; line-height: 1.7; }
.turn-meta, .empty-text { margin: 0; color: var(--dim); font-size: 12px; }
.turn-section { min-width: 0; border: 1px solid var(--el-border-color-light); border-radius: 8px; padding: 16px; }
.turn-section h3 { margin: 0 0 12px; color: var(--text); font-size: 16px; }
.turn-section h4 { margin: 12px 0 6px; color: var(--text-2); font-size: 14px; overflow-wrap: anywhere; }
.turn-section p { margin: 10px 0 0; }
.record-list { display: flex; flex-direction: column; gap: 10px; list-style: none; margin: 12px 0 0; padding: 0; }
.record-card { min-width: 0; border-radius: 6px; background: var(--surface-2, #f7f8fa); padding: 12px; }
.record-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; color: var(--dim); font-size: 12px; overflow-wrap: anywhere; }
.record-meta strong { color: var(--text-2); }
.plain-text { white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .turn-section { padding: 12px; }
}
</style>
