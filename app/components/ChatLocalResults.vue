<script setup lang="ts">
import { readApiErrorMessage } from "~/utils/api-error";
const props = defineProps<{ characterId: string; conversationId: string; revision: number; disabled?: boolean }>();
const emit = defineEmits<{ continueTask: [task: { id: string; title: string }] }>();
const request = useApiRequest();
type Task = { id: string; title: string; plan: string; status: string; resultNote: string | null;
  writeRequests: { id: string; relativePath: string; status: string; appliedAt: string | null; error: string | null; root: { label: string } }[];
  evidence: { id: string; outcome: string; note: string; createdAt: string }[];
  canContinue: boolean };
const tasks = ref<Task[]>([]);
type BrowserRow = { id: string; url: string; actions: { kind: string; selector?: string; text?: string; y?: number; direction?: string }[];
  reason: string; status: string; error: string | null; createdAt: string; taskId: string | null;
  result: { title?: string; steps?: { action: string; ok: boolean; detail?: string }[]; blockedRequests?: number } | null };
const browserRows = ref<BrowserRow[]>([]);
const browserStatus: Record<string, string> = { PENDING: "等待你批准", APPROVING: "执行中", SUCCEEDED: "已执行", FAILED: "执行失败", REJECTED: "已拒绝" };
function actionLine(action: BrowserRow["actions"][number]) {
  if (action.kind === "click") return `点击 ${action.selector}`;
  if (action.kind === "click_text") return `点击「${action.text}」`;
  if (action.kind === "fill") return `填写 ${action.selector}`;
  return action.direction ? `向${{ down: "下", up: "上", top: "顶部", bottom: "底部" }[action.direction] ?? action.direction}滚动` : `滚动到 ${action.y}px`;
}
const errorText = ref("");
const busy = ref(false);
const labels: Record<string, string> = { PLANNED: "已计划", WAITING_APPROVAL: "等待你审批", RUNNING: "等待你验收", SUCCEEDED: "你已验收通过", FAILED: "验收未通过", CANCELLED: "已取消" };
const writes: Record<string, string> = { PENDING: "待审批", APPROVING: "写入中", APPLIED: "已写入", REJECTED: "已拒绝", FAILED: "写入失败" };
let disposed = false;
let version = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  clearTimeout(timer);
  if (disposed || busy.value) return;
  const current = ++version;
  busy.value = true;
  try {
    const data = await request<{ tasks: Task[]; browserRequests?: BrowserRow[] }>({ url: `/characters/${props.characterId}/chat/local-results`, params: { conversationId: props.conversationId } });
    if (disposed || current !== version) return;
    tasks.value = data.tasks;
    browserRows.value = data.browserRequests ?? [];
    errorText.value = "";
  } catch (error) {
    if (!disposed && current === version) {
      tasks.value = [];
      browserRows.value = [];
      errorText.value = readApiErrorMessage(error, "任务结果暂时无法更新。");
    }
  } finally {
    if (!disposed && current === version) {
      busy.value = false;
      timer = setTimeout(() => { if (document.visibilityState === "visible") void refresh(); else timer = setTimeout(refresh, 5000); }, 5000);
    }
  }
}
function onVisibility() { if (document.visibilityState === "visible") void refresh(); }
watch(() => props.revision, () => { void refresh(); });
onMounted(() => { void refresh(); document.addEventListener("visibilitychange", onVisibility); });
onBeforeUnmount(() => { disposed = true; version++; clearTimeout(timer); document.removeEventListener("visibilitychange", onVisibility); });
</script>

<template>
  <section
    v-if="tasks.length || browserRows.length || errorText"
    class="local-results"
    aria-label="本地任务结果"
  >
    <div class="result-heading">
      <b>本次会话的本地任务</b>
      <el-button
        text
        :loading="busy"
        @click="refresh"
      >
        刷新结果
      </el-button>
    </div>
    <el-alert
      v-if="errorText"
      type="warning"
      :closable="false"
      :title="errorText"
    />
    <article
      v-for="row in browserRows"
      :key="row.id"
      class="result-task"
    >
      <div class="result-heading">
        <strong>网页操作 · {{ row.result?.title || row.url }}</strong>
        <el-tag
          size="small"
          :type="row.status === 'FAILED' ? 'danger' : 'info'"
        >
          {{ browserStatus[row.status] ?? row.status }}
        </el-tag>
      </div>
      <p>{{ row.url }}</p>
      <p>{{ row.actions.map(actionLine).join("；") }}</p>
      <p v-if="row.status === 'PENDING'">
        还没有操作网页，请到「本地观察 → 网页操作」核对并批准。
      </p>
      <p v-if="row.error">
        失败原因：{{ row.error }}
      </p>
      <p v-if="row.result?.steps?.length">
        已执行 {{ row.result.steps.filter(step => step.ok).length }} 步；阻止 {{ row.result.blockedRequests ?? 0 }} 个请求。
      </p>
    </article>
    <article
      v-for="task in tasks"
      :key="task.id"
      class="result-task"
    >
      <div class="result-heading">
        <strong>{{ task.title }}</strong><el-tag
          size="small"
          type="info"
        >
          {{ labels[task.status] ?? task.status }}
        </el-tag>
      </div>
      <p
        v-for="write in task.writeRequests"
        :key="write.id"
      >
        {{ write.root.label }} / {{ write.relativePath }} · {{ writes[write.status] ?? write.status }}
        <span v-if="write.error"> · {{ write.error }}</span>
      </p>
      <details><summary>计划与验收标准</summary><pre>{{ task.plan }}</pre></details>
      <div
        v-for="item in task.evidence"
        :key="item.id"
        class="result-evidence"
      >
        <b>{{ item.outcome === 'PASS' ? '磁盘读回核对一致' : '磁盘读回未能确认' }}</b>
        <pre>{{ item.note }}</pre>
      </div>
      <p v-if="task.status === 'WAITING_APPROVAL'">
        文件还没有写入，请到「本地观察 → 写审批」核对并批准。
      </p>
      <p v-if="task.status === 'RUNNING'">
        读回核对不是最终验收；请确认内容符合你的需求后，在任务档案里验收。
      </p>
      <el-button
        v-if="task.canContinue"
        :disabled="disabled || busy || Boolean(errorText)"
        @click="emit('continueTask', { id: task.id, title: task.title })"
      >
        继续下一步
      </el-button>
      <NuxtLink to="/local-observe">
        查看审批和任务档案
      </NuxtLink>
    </article>
  </section>
</template>

<style scoped>
.local-results { margin: 16px 0; padding: 14px; border: 1px solid var(--border, #e4e9f2); border-radius: 12px; font-size: 12px; }
.result-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.result-task { padding: 12px 0; border-top: 1px solid var(--border, #e4e9f2); }
.result-task pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; font-size: 12px; }
.result-task p { overflow-wrap: anywhere; }
.result-evidence { margin-top: 12px; }
summary { cursor: pointer; }
</style>
