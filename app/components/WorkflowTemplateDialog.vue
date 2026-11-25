<script setup lang="ts">
import { Document, Download } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, ref, shallowRef, watch } from "vue";
import { readApiErrorMessage } from "~/utils/api-error";

/**
 * 本机 ComfyUI 工作流模板的查看 / 替换 / 删除。
 *
 * 模板是**本地数据**：里面写的是这台机器 `models/loras` 下的真实文件名、LoRA 配比、
 * 采样器和分辨率。所以它不跟着仓库走，也不跟着角色卡走 —— 只在这个页面里读写，
 * 存进数据目录（服务端 `comfy-workflow-template.ts`，接口见 `/image/workflow-template`）。
 *
 * 这一层只做「编辑 + 提交」，**不重复实现校验规则**：能注入提示词这类结构判断留
 * 在服务端，否则两套判据打架时没人说得清哪套在起作用。客户端只做一件事 ——
 * 提交前先 `JSON.parse` 一次，把「少了个逗号」这种手滑当场指出来。
 */
const open = defineModel<boolean>({ required: true });

type TemplateStatus = {
  exists: boolean;
  fileName: string;
  source: "env" | "data";
  path: string;
  updatedAt: string | null;
  bytes: number;
  template: Record<string, unknown> | null;
};

const api = useApiRequest();
const loading = shallowRef(false);
const saving = shallowRef(false);
const removing = shallowRef(false);
const loadError = shallowRef<string | null>(null);
const status = ref<TemplateStatus | null>(null);
/** 编辑器里的原文。`{text}` 原样提交，所以用户自己排的缩进会被保留。 */
const text = shallowRef("");
/** 上一次读回来的原文，用来判断有没有未保存的改动。 */
const loadedText = shallowRef("");
let requestSeq = 0;

const dirty = computed(() => text.value.trim() !== loadedText.value.trim());
const byteCount = computed(() => new TextEncoder().encode(text.value).length);
const nodeCount = computed(() => {
  const raw = text.value.trim();
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? Object.keys(parsed).length : 0;
  } catch {
    return 0;
  }
});
const jsonBroken = computed(() => text.value.trim().length > 0 && nodeCount.value === 0);
const statusLine = computed(() => {
  const current = status.value;
  if (!current) return "还没读到模板";
  const parts = [`${nodeCount.value} 个节点`, formatBytes(byteCount.value)];
  if (current.updatedAt) parts.push(`更新于 ${formatTime(current.updatedAt)}`);
  return parts.join(" · ");
});
const sourceHint = computed(() => status.value?.source === "env"
  ? "位置由环境变量 COMFYUI_TEMPLATE_PATH 指定"
  : "存在数据目录里，不进仓库");

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}
function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function load() {
  const seq = ++requestSeq;
  loading.value = true;
  loadError.value = null;
  try {
    const data = await api<TemplateStatus>({ url: "/image/workflow-template" });
    // 关掉再打开、或连着点两次刷新：只认最后一次请求的结果。
    if (seq !== requestSeq) return;
    status.value = data;
    const value = data.template ? JSON.stringify(data.template, null, 2) : "";
    text.value = value;
    loadedText.value = value;
  } catch (error) {
    if (seq !== requestSeq) return;
    status.value = null;
    loadError.value = readApiErrorMessage(error, "读取模板失败，看看服务端有没有起来。");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

async function save() {
  if (!text.value.trim()) {
    ElMessage.warning("先贴一份工作流 JSON 进来。");
    return;
  }
  try {
    JSON.parse(text.value);
  } catch (error) {
    ElMessage.error(`不是合法 JSON：${error instanceof Error ? error.message : "解析失败"}`);
    return;
  }
  saving.value = true;
  try {
    await api({ url: "/image/workflow-template", method: "put", data: { text: text.value } });
    ElMessage.success("模板已保存，下一次出图就生效。");
    await load();
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "保存失败。"));
  } finally {
    saving.value = false;
  }
}

async function remove() {
  try {
    await ElMessageBox.confirm(
      "删掉后她会回到代码里现拼的工作流：步数、采样器和画风 LoRA 都不再套用。",
      "删掉工作流模板？",
      { type: "warning", confirmButtonText: "删掉", cancelButtonText: "留着", confirmButtonClass: "el-button--danger" },
    );
  } catch {
    return;
  }
  removing.value = true;
  try {
    const result = await api<{ removed: boolean }>({ url: "/image/workflow-template", method: "delete" });
    ElMessage.success(result.removed ? "模板已删除，下一次出图回到现拼。" : "本来就没有模板。");
    await load();
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "删除失败。"));
  } finally {
    removing.value = false;
  }
}

watch(open, (value) => {
  if (value) void load();
  // 关闭时让在飞的读取作废：再打开必须是新请求说了算。
  else requestSeq++;
});
</script>

<template>
  <el-dialog
    v-model="open"
    title="本机工作流模板"
    width="min(880px, calc(100vw - 32px))"
    class="ms-a workflow-template-dialog"
    append-to-body
  >
    <div class="wt-body">
      <div class="wt-head">
        <div class="wt-head-text">
          <div class="wt-badges">
            <el-tag
              :type="status?.exists ? 'success' : 'info'"
              effect="plain"
              size="small"
            >
              {{ status?.exists ? "已启用" : "未启用" }}
            </el-tag>
            <span class="wt-meta">{{ statusLine }}</span>
          </div>
          <p class="wt-note">
            {{ sourceHint }}。改完保存，下一次出图就生效，不用重启服务。
          </p>
        </div>
        <div class="wt-head-actions">
          <el-button
            :loading="loading"
            :disabled="saving || removing"
            @click="load"
          >
            <el-icon><Download /></el-icon>重新读取
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="loadError"
        type="error"
        :closable="false"
        show-icon
        :title="loadError"
      />

      <p
        v-if="status?.path"
        class="wt-path"
      >
        {{ status.path }}
      </p>

      <el-input
        v-model="text"
        type="textarea"
        class="wt-editor"
        :rows="16"
        resize="vertical"
        spellcheck="false"
        aria-label="工作流模板 JSON"
        placeholder="把 ComfyUI「导出（API）」得到的工作流 JSON 贴在这里。"
      />

      <div class="wt-hint-row">
        <span class="wt-hint">保存时校验能否注入提示词：要有 KSampler，且它的 positive 连到带 text 的输入节点。</span>
        <span
          v-if="jsonBroken"
          class="wt-dirty wt-broken"
        >不是合法 JSON</span>
        <span
          v-else-if="dirty"
          class="wt-dirty"
        >未保存</span>
      </div>
    </div>

    <template #footer>
      <div class="wt-footer">
        <el-button
          text
          type="danger"
          :disabled="!status?.exists || saving || removing"
          :loading="removing"
          @click="remove"
        >
          <el-icon><Document /></el-icon>删除模板
        </el-button>
        <div class="wt-footer-right">
          <el-button @click="open = false">
            关闭
          </el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="!dirty || loading || jsonBroken"
            @click="save"
          >
            保存
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.wt-body { display: flex; flex-direction: column; gap: var(--sp-3); }
.wt-head { display: flex; align-items: flex-start; gap: var(--sp-4); }
.wt-head-text { min-width: 0; flex: 1; }
.wt-badges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.wt-meta { color: var(--text-2); font-size: 12px; }
.wt-note { margin: var(--sp-1) 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.wt-head-actions { flex: none; }
.wt-path {
  margin: 0;
  color: var(--dim);
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.wt-editor :deep(.el-textarea__inner) {
  font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
}
.wt-hint-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2); }
.wt-hint { color: var(--dim); font-size: 12px; }
.wt-dirty {
  border-radius: 999px;
  padding: 1px 8px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 600;
}
.wt-broken { background: var(--red-soft); color: var(--red-text); }
.wt-footer { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.wt-footer-right { display: flex; align-items: center; gap: var(--sp-2); }
.ms-a :deep(.el-button) {
  height: var(--ctl-h);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-4);
  font-size: 14px;
  font-weight: 600;
}
</style>
