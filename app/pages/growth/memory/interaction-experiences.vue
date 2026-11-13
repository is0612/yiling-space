<script setup lang="ts">
import { ElMessage } from "element-plus";
import { Refresh } from "@element-plus/icons-vue";

definePageMeta({ topbar: { title: "互动经验" } });
type LearningKind = "UNDERSTANDING" | "REFERENCE" | "SITUATION" | "STRATEGY" | "EXPRESSION";
type Learning = { kind: LearningKind; situation: string; misunderstanding: string; correction: string; nextJudgment: string };
type Item = { id: string; content: string; context: string; feedbackQuote: string; status: string; revision: number; conversationId: string; weight: number; learning?: unknown };
const learningKinds: Array<{ value: LearningKind; label: string }> = [
  { value: "UNDERSTANDING", label: "理解纠正" }, { value: "REFERENCE", label: "指代识别" },
  { value: "SITUATION", label: "场合判断" }, { value: "STRATEGY", label: "应对策略" },
  { value: "EXPRESSION", label: "表达经验" },
];
function readLearning(value: unknown): Learning | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!learningKinds.some(kind => kind.value === row.kind)) return null;
  for (const key of ["situation", "misunderstanding", "correction", "nextJudgment"] as const) {
    if (typeof row[key] !== "string" || row[key].length > 400) return null;
  }
  return { kind: row.kind as LearningKind, situation: String(row.situation), misunderstanding: String(row.misunderstanding), correction: String(row.correction), nextJudgment: String(row.nextJudgment) };
}
function learningLabel(value: unknown) { return learningKinds.find(kind => kind.value === readLearning(value)?.kind)?.label ?? "旧版经验"; }
await useCharacterListData();
const route = useRoute();
const { character } = useCharacterSelection(route.path);
const characterId = computed(() => character.value?.id ?? "");
const items = ref<Item[]>([]);
type Automation = { enabled: boolean; status: string; lastError: string | null; nextRunAt?: string | null; lastCompletedAt?: string | null };
const automation = ref<Automation | null>(null);
const automationLabel = computed(() => {
  if (!automation.value) return "正在读取自动收尾状态";
  if (!automation.value.enabled) return "互动经验自动整理已关闭";
  return ({ WAITING: "等待对话收尾", IDLE: "等待对话收尾", QUEUED: "等待后台收尾", RUNNING: "正在整理互动经验", RETRY_WAIT: "等待重试", FAILED: "自动收尾失败", SUCCEEDED: "最近收尾已完成", SKIPPED: "本次没有形成经验", CANCELLED: "收尾任务已取消" } as Record<string, string>)[automation.value.status.toUpperCase()] ?? "自动收尾已开启";
});
const automationError = computed(() => ({ MODEL_UNAVAILABLE: "模型暂不可用，请检查角色模型配置。", LEASE_LOST: "处理已交由新的后台任务继续。", SOURCE_CHANGED: "对话依据已变化，后台将重新检查。", MODEL_FAILED: "模型整理失败，等待后台重试。" } as Record<string, string>)[automation.value?.lastError ?? ""] ?? (automation.value?.lastError ? "自动整理暂未完成，请稍后刷新。" : ""));
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const editorError = ref("");
const editing = ref<Item | null>(null);
const legacyOpen = ref<string[]>([]);
const draft = reactive({ content: "", context: "", structured: false, kind: "UNDERSTANDING" as LearningKind, situation: "", misunderstanding: "", correction: "", nextJudgment: "" });
const currentItems = computed(() => items.value.filter(item => item.status !== "PENDING"));
const legacyItems = computed(() => items.value.filter(item => item.status === "PENDING"));
let generation = 0;
let actionGeneration = 0;
let disposed = false;
const api = (id: string) => `/api/characters/${encodeURIComponent(id)}/growth/interaction-experiences`;
function fail(e: unknown) {
  const value = e as { data?: { statusMessage?: string; message?: string } };
  return value?.data?.statusMessage ?? value?.data?.message ?? "操作失败，请刷新后重试。";
}
async function load() {
  const id = characterId.value;
  const request = ++generation;
  error.value = "";
  loading.value = Boolean(id);
  if (!id) { items.value = []; return; }
  try {
    const result = await $fetch<{ items: Item[]; automation?: Automation }>(api(id));
    if (!disposed && request === generation && id === characterId.value) {
      items.value = result.items;
      automation.value = result.automation ?? null;
    }
  } catch (e) {
    if (!disposed && request === generation && id === characterId.value) error.value = fail(e);
  } finally {
    if (!disposed && request === generation) loading.value = false;
  }
}
function closeEditor() { editing.value = null; editorError.value = ""; }
watch(characterId, () => {
  actionGeneration += 1;
  busy.value = false;
  items.value = [];
  automation.value = null;
  legacyOpen.value = [];
  closeEditor();
  void load();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation += 1; actionGeneration += 1; });
async function operate(item: Item, operation: "EDIT" | "DISABLE" | "ACCEPT" | "REJECT") {
  if (busy.value || disposed) return;
  if (operation === "EDIT") {
    const fields = draft.structured ? [draft.situation, draft.misunderstanding, draft.correction, draft.nextJudgment] : [draft.content, draft.context];
    const required = draft.structured ? [draft.situation, draft.correction, draft.nextJudgment] : [draft.content, draft.context];
    if (required.some(value => !value.trim()) || fields.some(value => value.length > 400) || (draft.structured && !learningKinds.some(kind => kind.value === draft.kind))) {
      editorError.value = draft.structured ? "请填写当时情境、纠正和下次判断，每项最多 400 字；没有原误解可以留空。" : "请填写经验和适用场景，每项最多 400 字。";
      return;
    }
  }
  const learning = draft.structured ? { kind: draft.kind, situation: draft.situation.trim(), misunderstanding: draft.misunderstanding.trim(), correction: draft.correction.trim(), nextJudgment: draft.nextJudgment.trim() } : null;
  const id = characterId.value;
  const action = ++actionGeneration;
  busy.value = true;
  editorError.value = "";
  error.value = "";
  const isCurrent = () => !disposed && action === actionGeneration && id === characterId.value;
  try {
    await $fetch(`${api(id)}/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: { revision: item.revision, operation, ...(operation === "EDIT" ? { content: learning?.nextJudgment ?? draft.content.trim(), context: learning?.situation ?? draft.context.trim(), learning } : {}) },
    });
    if (isCurrent()) {
      closeEditor();
      ElMessage.success(operation === "DISABLE" ? "经验已停用" : operation === "EDIT" ? "经验已纠正" : "旧候选已处理");
      await load();
    }
  } catch (e) {
    if (isCurrent()) {
      if (operation === "EDIT") editorError.value = fail(e);
      else error.value = fail(e);
    }
  } finally { if (isCurrent()) busy.value = false; }
}
async function toggleAutomation() {
  if (busy.value || loading.value || !automation.value || disposed) return;
  const id = characterId.value;
  const action = ++actionGeneration;
  const enabled = !automation.value.enabled;
  busy.value = true;
  error.value = "";
  const isCurrent = () => !disposed && action === actionGeneration && id === characterId.value;
  try {
    await $fetch(`${api(id)}/settings`, { method: "PATCH", body: { enabled } });
    if (isCurrent()) {
      ElMessage.success(enabled ? "互动经验自动整理已开启" : "已停止新整理，已生效经验仍可使用");
      await load();
    }
  } catch (e) { if (isCurrent()) error.value = fail(e); }
  finally { if (isCurrent()) busy.value = false; }
}
function edit(item: Item) {
  if (busy.value) return;
  editing.value = { ...item };
  draft.content = item.content;
  draft.context = item.context;
  const learning = readLearning(item.learning);
  draft.structured = Boolean(learning);
  draft.kind = learning?.kind ?? "UNDERSTANDING";
  draft.situation = learning?.situation ?? "";
  draft.misunderstanding = learning?.misunderstanding ?? "";
  draft.correction = learning?.correction ?? "";
  draft.nextJudgment = learning?.nextJudgment ?? "";
  editorError.value = "";
}
function weight(value: number) { return Number.isFinite(value) ? value.toFixed(2) : "—"; }
function statusLabel(status: string) { return ({ ACTIVE: "已生效", DISABLED: "已停用", REJECTED: "已驳回" } as Record<string, string>)[status] ?? status; }
</script>

<template>
  <div class="page-wrap experience-page">
    <MemorySectionNavigation active="interaction-experiences" />
    <div class="experience-heading">
      <div>
        <h2>互动经验</h2>
        <p>她从相处中的反馈里，记住理解、指代、场合与应对上的经验。</p>
      </div>
      <el-button
        :icon="Refresh"
        :loading="loading"
        :disabled="busy || !characterId"
        @click="load"
      >
        刷新
      </el-button>
    </div>
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="对话空闲 30 分钟后，后台自动收尾；有依据才形成经验，并自动生效。"
    >
      <p>没有明确反馈，不对回应效果下结论。这是供类似情境参考的经验记忆，不是必须照做的语言规则。经验只在原私聊会话使用，随时间降低召回权重；隐私和明确底线不作为会衰减的临时经验。</p>
    </el-alert>
    <el-alert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      show-icon
    />
    <el-card
      v-if="characterId"
      class="automation-status"
    >
      <div class="card-heading">
        <strong>{{ automationLabel }}</strong>
        <el-button
          :disabled="busy || loading || !automation"
          :loading="busy"
          @click="toggleAutomation"
        >
          {{ automation?.enabled ? "关闭自动整理" : "开启自动整理" }}
        </el-button>
      </div>
      <p>开启后会调用角色模型整理互动经验；关闭只停止新整理，已生效经验仍可读取。此开关不改变忆泡和阶段总结设置。</p>
      <p
        v-if="automationError"
        role="status"
      >
        最近处理提示：{{ automationError }}
      </p>
      <p
        v-if="automation?.nextRunAt"
        class="experience-meta"
      >
        计划收尾时间：{{ automation.nextRunAt }}
      </p>
    </el-card>
    <el-skeleton
      v-if="loading && !items.length"
      :rows="5"
      animated
    />
    <el-empty
      v-else-if="!characterId"
      description="请先选择角色"
    />
    <el-empty
      v-else-if="!currentItems.length && !error"
      description="暂时没有自动形成的经验；无需手动选择消息。"
    />
    <el-card
      v-for="item in currentItems"
      :key="item.id"
      class="experience-card"
    >
      <div class="card-heading">
        <el-tag :type="item.status === 'ACTIVE' ? 'success' : 'info'">
          {{ statusLabel(item.status) }}
        </el-tag>
        <span class="experience-meta">召回权重 {{ weight(item.weight) }} · 仅原会话</span>
      </div>
      <el-tag
        type="info"
        class="learning-kind"
      >
        {{ learningLabel(item.learning) }}
      </el-tag>
      <dl
        v-if="readLearning(item.learning)"
        class="learning-details"
      >
        <dt>当时情境</dt><dd>{{ readLearning(item.learning)?.situation || "未记录" }}</dd>
        <dt>原误解</dt><dd>{{ readLearning(item.learning)?.misunderstanding || "未记录明确误解" }}</dd>
        <dt>纠正</dt><dd>{{ readLearning(item.learning)?.correction || "未记录" }}</dd>
        <dt>下次判断</dt><dd>{{ readLearning(item.learning)?.nextJudgment || "未记录" }}</dd>
      </dl>
      <template v-else>
        <p class="experience-content">
          {{ item.content }}
        </p>
        <p><strong>适用场景：</strong>{{ item.context }}</p>
      </template>
      <blockquote><strong>反馈依据：</strong>{{ item.feedbackQuote }}</blockquote>
      <div class="card-actions">
        <el-button
          v-if="item.status !== 'REJECTED'"
          :disabled="busy || loading"
          @click="edit(item)"
        >
          纠正
        </el-button>
        <el-button
          v-if="item.status === 'ACTIVE'"
          :disabled="busy || loading"
          @click="operate(item, 'DISABLE')"
        >
          停用
        </el-button>
      </div>
    </el-card>
    <el-collapse
      v-if="legacyItems.length"
      v-model="legacyOpen"
    >
      <el-collapse-item
        name="legacy"
        :title="`旧版待审核候选（${legacyItems.length}）`"
      >
        <p>这些是旧版手动生成的候选，尚未生效；新经验会由后台自动形成，无需在这里采纳。</p>
        <el-card
          v-for="item in legacyItems"
          :key="item.id"
          class="legacy-card"
        >
          <el-tag type="info">
            {{ learningLabel(item.learning) }}
          </el-tag>
          <dl
            v-if="readLearning(item.learning)"
            class="learning-details"
          >
            <dt>当时情境</dt><dd>{{ readLearning(item.learning)?.situation || "未记录" }}</dd>
            <dt>原误解</dt><dd>{{ readLearning(item.learning)?.misunderstanding || "未记录明确误解" }}</dd>
            <dt>纠正</dt><dd>{{ readLearning(item.learning)?.correction || "未记录" }}</dd>
            <dt>下次判断</dt><dd>{{ readLearning(item.learning)?.nextJudgment || "未记录" }}</dd>
          </dl>
          <template v-else>
            <p class="experience-content">
              {{ item.content }}
            </p>
            <p>适用场景：{{ item.context }}</p>
          </template>
          <blockquote>反馈依据：{{ item.feedbackQuote }}</blockquote>
          <el-button
            :disabled="busy || loading"
            @click="operate(item, 'ACCEPT')"
          >
            使旧候选生效
          </el-button>
          <el-button
            :disabled="busy || loading"
            @click="operate(item, 'REJECT')"
          >
            驳回
          </el-button>
          <el-button
            :disabled="busy || loading"
            @click="edit(item)"
          >
            纠正
          </el-button>
        </el-card>
      </el-collapse-item>
    </el-collapse>
    <p class="experience-meta">
      权重下降不会删除经验。你可以纠正不准确的内容，或停用不再适合的经验。页面显示最近 100 条记录。
    </p>
    <el-dialog
      :model-value="!!editing"
      title="纠正互动经验"
      :close-on-click-modal="!busy"
      :close-on-press-escape="!busy"
      :show-close="!busy"
      @close="closeEditor"
    >
      <el-alert
        v-if="editorError"
        :title="editorError"
        type="error"
        :closable="false"
        show-icon
      />
      <p v-if="draft.structured">
        纠正整条经验记忆；下次判断和当时情境会同步保存为摘要，不会留下两份冲突内容。
      </p>
      <el-form label-position="top">
        <template v-if="draft.structured">
          <el-form-item label="经验类别">
            <el-select
              v-model="draft.kind"
              :disabled="busy"
            >
              <el-option
                v-for="kind in learningKinds"
                :key="kind.value"
                :label="kind.label"
                :value="kind.value"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="当时情境">
            <el-input
              v-model="draft.situation"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="原误解（没有明确误解可留空）">
            <el-input
              v-model="draft.misunderstanding"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="纠正">
            <el-input
              v-model="draft.correction"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="下次判断">
            <el-input
              v-model="draft.nextJudgment"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="经验记忆（旧版）">
            <el-input
              v-model="draft.content"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
          <el-form-item label="适用场景">
            <el-input
              v-model="draft.context"
              type="textarea"
              maxlength="400"
              show-word-limit
              :rows="3"
              :disabled="busy"
            />
          </el-form-item>
        </template>
      </el-form>
      <template #footer>
        <el-button
          :disabled="busy"
          @click="closeEditor"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="busy"
          @click="editing && operate(editing, 'EDIT')"
        >
          保存纠正
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.experience-page { display: grid; gap: 16px; font-size: 14px; }
.experience-heading, .card-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
h2 { margin: 0; font-size: 22px; }
p { line-height: 1.6; margin: 10px 0; }
.experience-heading p { color: var(--dim); }
.experience-meta { color: var(--dim); font-size: 13px; }
.experience-content { font-weight: 600; white-space: pre-wrap; }
blockquote { margin: 12px 0; padding: 12px; background: var(--el-fill-color-light); border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.learning-kind { margin-top: 12px; }
.learning-details { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 10px 14px; line-height: 1.6; }
.learning-details dt { color: var(--dim); }
.learning-details dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.el-select { width: 100%; }
.legacy-card + .legacy-card { margin-top: 12px; }
@media (max-width: 640px) { .card-heading { align-items: flex-start; flex-direction: column; } }
</style>
