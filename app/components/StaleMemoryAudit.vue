<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { createMemoryApi } from "~/api/memory";
import type { StaleMemoryItem, StaleMemoryVerdict } from "#shared/types/memory";

/**
 * 「失效体检」入口：长期记忆页与忆泡日历页共用。
 *
 * 分工写死：模型只提名，人负责决定。所以这里没有「一键全清」——
 * 勾选是唯一的清理入口，且每条都带着模型给的理由和把握度。
 *
 * 记忆标失效、忆泡归档，两者都能在各自页面恢复，不是删除。
 */
const api = createMemoryApi(useApiRequest());

const props = defineProps<{
  characterId: string;
  scope: "memory" | "events";
  /** 忆泡页传入当前选中日期，用于「只查这一天」。 */
  dayKey?: string;
}>();
const emit = defineEmits<{ applied: [] }>();

const open = ref(false);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const items = ref<StaleMemoryItem[]>([]);
const selected = ref<string[]>([]);
const counts = ref<{ memory: { active: number; scanned: number }; event: { active: number; scanned: number } }>({
  memory: { active: 0, scanned: 0 },
  event: { active: 0, scanned: 0 },
});
/** 忆泡默认查最近 7 天：一天几十条，单日很难看出「状态已经被后来推翻」。 */
const range = ref<"day" | "7" | "30">("7");

const isEvents = computed(() => props.scope === "events");
const rangeOptions = computed(() => [
  ...(props.dayKey ? [{ value: "day" as const, label: `只看 ${props.dayKey}` }] : []),
  { value: "7" as const, label: "最近 7 天" },
  { value: "30" as const, label: "最近 30 天" },
]);

const VERDICT_LABEL: Record<StaleMemoryVerdict, string> = {
  CONTRADICTED: "已被推翻",
  OBSOLETE: "已经过时",
};
const VERDICT_TONE: Record<StaleMemoryVerdict, string> = {
  CONTRADICTED: "tone-red",
  OBSOLETE: "tone-amber",
};

const allSelected = computed(() => items.value.length > 0 && selected.value.length === items.value.length);
const selectedCount = computed(() => selected.value.length);

/** 记忆的 title 存的是分类枚举，展示前换成中文；忆泡的 title 本来就是标题。 */
const MEMORY_CATEGORY_LABELS: Record<string, string> = {
  FACT: "事实记忆", PREFERENCE: "偏好记忆", RELATIONSHIP: "关系记忆", COMMITMENT: "承诺与约定",
  GOAL: "目标记忆", EVENT: "事件记忆", SUMMARY: "记忆摘要", OTHER: "其他",
};
function itemTitle(item: StaleMemoryItem) {
  return item.kind === "MEMORY" ? (MEMORY_CATEGORY_LABELS[item.title] ?? item.title) : item.title;
}

let sequence = 0;
function reset() {
  items.value = [];
  selected.value = [];
  error.value = "";
  counts.value = { memory: { active: 0, scanned: 0 }, event: { active: 0, scanned: 0 } };
}
watch(() => [props.characterId, props.dayKey], () => {
  sequence += 1;
  open.value = false;
  loading.value = false;
  saving.value = false;
  reset();
});
onBeforeUnmount(() => { sequence += 1; });

async function scan() {
  const seq = ++sequence;
  const characterId = props.characterId;
  if (!characterId) return;
  open.value = true;
  loading.value = true;
  error.value = "";
  items.value = [];
  selected.value = [];
  try {
    const result = await api.auditStaleMemories({
      characterId,
      scopes: isEvents.value ? ["EVENT"] : ["MEMORY"],
      ...(isEvents.value && range.value === "day" && props.dayKey
        ? { dayKey: props.dayKey }
        : isEvents.value
          ? { rangeDays: Number(range.value) }
          : {}),
    });
    if (seq !== sequence) return;
    counts.value = result.counts;
    items.value = result.items;
    // 默认一条都不勾：模型只是提名，误判的代价是她的记忆被误清，宁可让人多点几下。
    selected.value = [];
  } catch (cause) {
    if (seq !== sequence) return;
    const message = cause && typeof cause === "object" && "statusMessage" in cause
      ? String(cause.statusMessage)
      : "体检没有完成，请稍后重试。";
    error.value = message;
  } finally {
    if (seq === sequence) loading.value = false;
  }
}

function toggleAll(value: boolean) {
  selected.value = value ? items.value.map(item => `${item.kind}:${item.id}`) : [];
}

function toggleItem(key: string, value: boolean) {
  selected.value = value
    ? (selected.value.includes(key) ? selected.value : [...selected.value, key])
    : selected.value.filter(entry => entry !== key);
}

async function apply() {
  if (saving.value) return;
  const picked = items.value.filter(item => selected.value.includes(`${item.kind}:${item.id}`));
  if (!picked.length) { ElMessage.warning("先勾选要清理的条目。"); return; }
  try {
    await ElMessageBox.confirm(
      `选中的 ${picked.length} 条会被标记为${isEvents.value ? "已归档" : "已失效"}，不再参与检索。它们不会被删除，仍可在${isEvents.value ? "当天「已隐藏」" : "「已失效」筛选"}里恢复。`,
      "确认清理",
      { confirmButtonText: "确认清理", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  const seq = ++sequence;
  saving.value = true;
  try {
    const result = await api.applyStaleMemories({
      characterId: props.characterId,
      items: picked.map(item => ({ kind: item.kind, id: item.id, fingerprint: item.fingerprint, reason: item.reason })),
    });
    if (seq !== sequence) return;
    const cleared = new Set(picked.map(item => `${item.kind}:${item.id}`));
    items.value = items.value.filter(item => !cleared.has(`${item.kind}:${item.id}`));
    selected.value = selected.value.filter(key => !cleared.has(key));
    ElMessage.success(`已清理 ${result.memory + result.event} 条，可随时恢复。`);
    emit("applied");
  } catch (cause) {
    if (seq !== sequence) return;
    const message = cause && typeof cause === "object" && "statusMessage" in cause
      ? String(cause.statusMessage)
      : "清理没有完成，请重试。";
    ElMessage.error(message);
  } finally {
    if (seq === sequence) saving.value = false;
  }
}
</script>

<template>
  <!-- loading 也要禁用：sequence 只能丢弃过期结果，挡不住连点发出的重复模型调用（每次都会烧当日额度）。 -->
  <el-button
    :disabled="!characterId || loading || saving"
    @click="scan"
  >
    {{ isEvents ? "检查失效忆泡" : "检查失效记忆" }}
  </el-button>
  <el-dialog
    v-model="open"
    append-to-body
    :title="isEvents ? '失效忆泡体检' : '失效记忆体检'"
    width="min(820px, 94vw)"
    :close-on-click-modal="!saving"
    :show-close="!saving"
  >
    <p class="audit-intro">
      模型只负责提名，清不清理由你决定。它会看时间、分类和条目之间的矛盾，
      主观偏好、性格和关系类记忆不会被判失效。
    </p>
    <div
      v-if="isEvents"
      class="audit-range"
    >
      <span>检查范围</span>
      <el-radio-group
        v-model="range"
        size="small"
        :disabled="loading || saving"
        @change="scan"
      >
        <el-radio-button
          v-for="option in rangeOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <div
      v-else-if="loading"
      class="audit-loading"
    >
      正在体检，通常需要 10~30 秒……
    </div>
    <template v-else>
      <p class="audit-summary">
        <span v-if="counts.memory.scanned">长期记忆 {{ counts.memory.scanned }} / {{ counts.memory.active }} 条</span>
        <span v-if="counts.memory.scanned && counts.event.scanned"> · </span>
        <span v-if="counts.event.scanned">忆泡 {{ counts.event.scanned }} / {{ counts.event.active }} 条</span>
        <span v-if="!counts.memory.scanned && !counts.event.scanned">没有可检查的条目</span>
      </p>
      <p
        v-if="(isEvents ? counts.event : counts.memory).active > (isEvents ? counts.event : counts.memory).scanned"
        class="audit-note"
      >
        只检查了最近 {{ (isEvents ? counts.event : counts.memory).scanned }} 条；缩小范围可以查得更全。
      </p>

      <el-empty
        v-if="!items.length"
        description="这次没有发现明显失效的条目。"
      />
      <template v-else>
        <div class="audit-toolbar">
          <el-checkbox
            :model-value="allSelected"
            @change="(value: boolean | string | number) => toggleAll(Boolean(value))"
          >
            全选 {{ items.length }} 条
          </el-checkbox>
        </div>
        <div class="audit-list">
          <label
            v-for="item in items"
            :key="`${item.kind}:${item.id}`"
            class="audit-item"
            :class="{ on: selected.includes(`${item.kind}:${item.id}`) }"
          >
            <el-checkbox
              :model-value="selected.includes(`${item.kind}:${item.id}`)"
              @change="(value: boolean | string | number) => toggleItem(`${item.kind}:${item.id}`, Boolean(value))"
            />
            <div class="audit-body">
              <div class="audit-head">
                <span class="audit-kind">{{ item.kind === "MEMORY" ? "长期记忆" : "忆泡" }}</span>
                <strong class="audit-title">{{ itemTitle(item) }}</strong>
                <span
                  class="audit-verdict"
                  :class="VERDICT_TONE[item.verdict]"
                >{{ VERDICT_LABEL[item.verdict] }}</span>
                <span class="audit-confidence">把握 {{ Math.round(item.confidence * 100) }}%</span>
              </div>
              <p class="audit-content">
                {{ item.content }}
              </p>
              <p class="audit-reason">
                {{ item.reason }}
              </p>
              <p class="audit-meta">
                {{ item.meta }}
              </p>
            </div>
          </label>
        </div>
      </template>
    </template>

    <template #footer>
      <div class="audit-footer">
        <span class="audit-picked">已选 {{ selectedCount }} 条</span>
        <div class="audit-actions">
          <el-button
            :disabled="loading || saving"
            @click="scan"
          >
            重新体检
          </el-button>
          <el-button
            :disabled="saving"
            @click="open = false"
          >
            关闭
          </el-button>
          <el-button
            type="warning"
            :loading="saving"
            :disabled="loading || !selectedCount"
            @click="apply"
          >
            清理选中
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.audit-intro { margin: 0 0 14px; color: var(--dim); font-size: 12px; line-height: 1.8; }
.audit-range { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; color: var(--dim); font-size: 12px; }
.audit-loading { padding: 36px 0; color: var(--dim); font-size: 12px; text-align: center; }
.audit-summary { margin: 0 0 4px; color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.audit-note { margin: 0 0 10px; color: var(--dim); font-size: 12px; line-height: 1.7; }
.audit-toolbar { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding: 6px 0 10px; }
.audit-list { display: flex; flex-direction: column; gap: 8px; max-height: 52vh; overflow: auto; padding-top: 10px; }
.audit-item { display: flex; align-items: flex-start; gap: 10px; border: 1px solid transparent; border-radius: 10px; background: var(--surface-2); padding: 12px 14px; cursor: pointer; }
.audit-item.on { border-color: var(--brand-line); background: var(--brand-soft); }
.audit-item :deep(.el-checkbox) { margin-top: 1px; }
.audit-body { min-width: 0; flex: 1; }
.audit-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.audit-kind { color: var(--dim); font-size: 11px; font-weight: 600; }
.audit-title { color: var(--text); font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.audit-verdict { border-radius: 999px; padding: 1px 8px; font-size: 11px; font-weight: 600; }
.audit-verdict.tone-red { background: var(--red-soft); color: var(--red); }
.audit-verdict.tone-amber { background: var(--amber-soft); color: var(--amber); }
.audit-verdict.tone-gray { background: var(--surface-3); color: var(--text-2); }
.audit-confidence { color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
.audit-content { margin: 6px 0 0; color: var(--text-2); font-size: 14px; line-height: 1.75; white-space: pre-wrap; overflow-wrap: anywhere; }
.audit-reason { margin: 6px 0 0; border-left: 2px solid var(--line); padding-left: 8px; color: var(--dim); font-size: 12px; line-height: 1.7; }
.audit-meta { margin: 6px 0 0; color: var(--faint); font-size: 11px; }
.audit-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.audit-picked { color: var(--dim); font-size: 12px; }
.audit-actions { display: flex; gap: 8px; }
.audit-actions .el-button + .el-button { margin-left: 0; }
@media (max-width: 640px) { .audit-list { max-height: 46vh; } }
</style>
