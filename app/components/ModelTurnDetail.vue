<script lang="ts">
export type TurnMessage = {
  id?: string;
  member?: string;
  speaker?: string;
  content: string;
  occurredAt?: string;
};
export type TurnCollaboration = {
  version: 1;
  elapsedMs: number;
  stages: Array<{
    stage: "context" | "memory" | "knowledge" | "response";
    limit: number; logicalCalls: number; budgetRejections: number;
    skipped: "not_enabled" | "not_needed" | null;
    operations: Array<{
      state: "running" | "success" | "no_sources" | "failed" | "budget_exhausted";
      durationMs: number; reportedAttempts: number; rejectedDiagnostics: number;
      attempts: Array<{
        status: "success" | "failed" | "timeout" | "http_error" | "invalid_response" | "truncated";
        durationMs: number; usageReported: boolean;
        finishReason?: "stop" | "length" | "content_filter" | "unknown";
      }>;
    }>;
  }>;
};
export type ModelTurnDetailResponse = {
  turnId: string;
  createdAt: string;
  detail: {
    version: 1;
    groupChat: boolean;
    collaboration?: TurnCollaboration;
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
const collaboration = computed(() => detail.value.collaboration);
const collaborationStages = { context: "语境分析", memory: "记忆筛选", knowledge: "知识查询", response: "回复生成" };
const operationLabels = { running: "运行中", success: "完成", no_sources: "无相关来源", failed: "失败", budget_exhausted: "逻辑额度已用尽" };
const attemptLabels = { success: "请求成功", failed: "请求失败", timeout: "请求超时", http_error: "HTTP 错误", invalid_response: "响应格式无效", truncated: "输出被截断" };
function duration(value: number) { return value < 1000 ? `${Math.round(value)} 毫秒` : `${(value / 1000).toFixed(2)} 秒`; }
function reportedAttempts(stage: TurnCollaboration["stages"][number]) { return stage.operations.reduce((sum, operation) => sum + operation.reportedAttempts, 0); }
function stageLabel(stage: TurnCollaboration["stages"][number]) {
  if (stage.skipped) return stage.skipped === "not_enabled" ? "未启用" : "本轮无需执行";
  if (!stage.operations.length) return stage.budgetRejections ? "逻辑额度已用尽" : "未记录执行";
  return stage.operations.map(operation => operationLabels[operation.state]).join(" / ");
}
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

    <section class="turn-section collaboration-section">
      <h3>助手协作诊断</h3>
      <template v-if="collaboration">
        <p class="empty-text">
          本轮协作耗时 {{ duration(collaboration.elapsedMs) }}。逻辑执行是一个处理阶段，已报告 HTTP 尝试包含该阶段中的重试；知识查询可以只查数据库。
        </p>
        <el-alert
          title="已报告请求次数不等于供应商账单"
          description="请求诊断可能不完整。用量已返回只表示响应含有效 Token 字段，不代表所有用量分项或费用完整；缺失用量不能当作免费。"
          type="info"
          :closable="false"
          show-icon
        />
        <ol class="record-list">
          <li
            v-for="stage in collaboration.stages"
            :key="stage.stage"
            class="record-card"
          >
            <div class="record-meta">
              <strong>{{ collaborationStages[stage.stage] }}</strong>
              <el-tag type="info">
                {{ stageLabel(stage) }}
              </el-tag>
              <span>逻辑执行 {{ stage.logicalCalls }} / {{ stage.limit }}</span>
              <span>已报告 HTTP 尝试 {{ reportedAttempts(stage) }}</span>
            </div>
            <p
              v-if="stage.budgetRejections"
              class="diagnostic-warning"
            >
              因逻辑额度拒绝 {{ stage.budgetRejections }} 次，不代表模型请求失败。
            </p>
            <div
              v-for="(operation, operationIndex) in stage.operations"
              :key="operationIndex"
              class="collaboration-operation"
            >
              <div class="record-meta">
                <strong>第 {{ operationIndex + 1 }} 次逻辑执行</strong>
                <span>{{ operationLabels[operation.state] }} · {{ duration(operation.durationMs) }}</span>
              </div>
              <p
                v-if="operation.rejectedDiagnostics"
                class="diagnostic-warning"
              >
                有 {{ operation.rejectedDiagnostics }} 条诊断未采纳，请求统计可能不完整。
              </p>
              <ol
                v-if="operation.attempts.length"
                class="attempt-list"
              >
                <li
                  v-for="(attempt, attemptIndex) in operation.attempts"
                  :key="attemptIndex"
                >
                  <div class="record-meta">
                    <span>请求 {{ attemptIndex + 1 }}</span>
                    <el-tag
                      :type="attempt.status === 'success' ? 'success' : 'warning'"
                      size="small"
                    >
                      {{ attemptLabels[attempt.status] }}
                    </el-tag>
                    <span>{{ duration(attempt.durationMs) }}</span>
                    <el-tag
                      :type="attempt.usageReported ? 'info' : 'warning'"
                      size="small"
                    >
                      {{ attempt.usageReported ? '用量字段已返回' : '用量缺失，费用未知' }}
                    </el-tag>
                    <span v-if="attempt.finishReason">结束标记：{{ attempt.finishReason }}</span>
                  </div>
                </li>
              </ol>
              <p
                v-else
                class="empty-text"
              >
                未保存模型 HTTP 尝试诊断，不据此判断实际请求为零。
              </p>
            </div>
          </li>
        </ol>
      </template>
      <p
        v-else
        class="empty-text"
      >
        旧记录未保存协作诊断，或本入口尚未接入；不能据此判断没有助手调用。
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
.collaboration-section .el-alert { margin-top: 12px; }
.collaboration-operation { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--el-border-color-light); }
.attempt-list { display: flex; flex-direction: column; gap: 8px; list-style: none; padding: 0; margin: 10px 0 0; }
.diagnostic-warning { color: var(--el-color-warning-dark-2); font-size: 12px; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .turn-section { padding: 12px; }
}
</style>
