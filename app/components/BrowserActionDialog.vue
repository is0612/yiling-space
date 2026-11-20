<script setup lang="ts">
import { readApiErrorMessage } from "~/utils/api-error";
const visible = defineModel<boolean>({ required: true });
const request = useApiRequest();
type Step = { kind: string; selector?: string; text?: string; value?: string; y?: number };
type Row = { id: string; url: string; actions: Step[]; reason: string; status: string; error: string | null;
  createdAt: string; result: { steps?: { action: string; ok: boolean; detail?: string }[]; title?: string; text?: string; blockedRequests?: number } | null };
const rows = ref<Row[]>([]);
const busy = ref(false);
const message = ref("");
const errorText = ref("");
const detail = ref("");

function stepLabel(step: Step) {
  if (step.kind === "click") return `点击 ${step.selector}`;
  if (step.kind === "click_text") return `点击文字「${step.text}」`;
  if (step.kind === "fill") return `填写 ${step.selector}：${step.value}`;
  return `滚动到 ${step.y}px`;
}

async function load() {
  if (!visible.value) return;
  busy.value = true;
  errorText.value = "";
  try { rows.value = (await request<{ requests: Row[] }>({ url: "/local/browser-requests", params: { status: "PENDING" } })).requests; }
  catch (error) { errorText.value = readApiErrorMessage(error, "读取网页操作审批失败。"); }
  finally { busy.value = false; }
}

async function approve(row: Row) {
  try {
    await ElMessageBox.confirm(`批准后在独立浏览器里执行 ${row.actions.length} 个步骤：\n${row.actions.map(stepLabel).join("\n")}`,
      "批准网页操作", { type: "warning", confirmButtonText: "执行", cancelButtonText: "取消" });
    busy.value = true;
    message.value = "";
    const result = await request<{ request: Row }>({ url: `/local/browser-requests/${row.id}/approve`, method: "post" });
    message.value = `已执行 ${result.request.result?.steps?.filter(step => step.ok).length ?? 0} 个步骤；页面标题：${result.request.result?.title || "(无)"}。`;
    detail.value = result.request.result?.steps?.map(step => `${step.ok ? "✓" : "✗"} ${step.action}${step.detail ? `（${step.detail}）` : ""}`).join("\n") ?? "";
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    errorText.value = readApiErrorMessage(error, "执行网页操作失败。");
  } finally { busy.value = false; }
}

async function reject(row: Row) {
  try {
    const reason = await ElMessageBox.prompt("拒绝原因（可留空）", "拒绝网页操作", { confirmButtonText: "拒绝", cancelButtonText: "取消", inputPlaceholder: "例如：这一步不需要" });
    busy.value = true;
    await request({ url: `/local/browser-requests/${row.id}/reject`, method: "post", data: { reason: reason.value ?? "" } });
    await load();
  } catch (error) {
    if (error === "cancel" || error === "close") return;
    errorText.value = readApiErrorMessage(error, "拒绝失败。");
  } finally { busy.value = false; }
}

watch(visible, value => { if (value) void load(); });
</script>

<template>
  <el-dialog v-model="visible" title="网页操作审批" width="min(880px, 94vw)" append-to-body>
    <el-alert type="info" :closable="false"
      title="批准后才会执行，且只作用于这一次独立浏览器会话"
      description="只允许本页点击、按文字点击、填写和滚动；提交表单、上传文件、跳转其他网站都会被阻止。" />
    <el-alert v-if="errorText" type="error" :title="errorText" :closable="false" class="block" />
    <el-alert v-if="message" type="success" :title="message" :closable="false" class="block" />
    <pre v-if="detail" class="steps">{{ detail }}</pre>
    <el-empty v-if="!busy && !rows.length" description="没有待批准的网页操作" />
    <article v-for="row in rows" :key="row.id" class="row">
      <p class="url">{{ row.url }}</p>
      <p class="reason">原因：{{ row.reason }}</p>
      <ol><li v-for="(step, index) in row.actions" :key="index">{{ stepLabel(step) }}</li></ol>
      <div class="actions">
        <el-button type="primary" :loading="busy" @click="approve(row)">批准并执行</el-button>
        <el-button :disabled="busy" @click="reject(row)">拒绝</el-button>
      </div>
      <p v-if="row.error" class="reason">失败原因：{{ row.error }}</p>
    </article>
    <template #footer><el-button @click="visible = false">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.block { margin-top: 12px; }
.row { margin-top: 16px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; }
.url, .reason { font-size: 12px; overflow-wrap: anywhere; margin: 4px 0; }
.actions { margin-top: 10px; display: flex; gap: 8px; }
.steps { white-space: pre-wrap; font-size: 12px; margin-top: 12px; }
ol { margin: 8px 0 0; padding-left: 20px; font-size: 12px; }
</style>
