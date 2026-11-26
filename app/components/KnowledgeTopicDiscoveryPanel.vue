<script setup lang="ts">
import { ElMessage } from "element-plus";
import { readApiErrorMessage } from "~/utils/api-error";
import {
  createKnowledgeTopicsApi,
  type KnowledgeTopicRunDetail,
  type KnowledgeTopicRunSummary,
  type KnowledgeTopicSummary,
} from "~/api/knowledge-topics";
import type { KnowledgeItem } from "~/api/knowledge";

const props = defineProps<{ characterId: string; items: KnowledgeItem[] }>();
const emit = defineEmits<{ changed: [] }>();
const api = createKnowledgeTopicsApi(useApiRequest());
const open = ref(false);
const loading = ref(false);
const starting = ref(false);
const reviewingId = ref("");
const selectedInputIds = ref<string[]>([]);
const runs = ref<KnowledgeTopicRunSummary[]>([]);
const selectedRunId = ref("");
const runDetail = ref<KnowledgeTopicRunDetail | null>(null);
const activeTopics = ref<KnowledgeTopicSummary[]>([]);
const selectedMembers = ref<Record<string, string[]>>({});
const applyTopicIds = ref<Record<string, string>>({});
// 切角色后仍在途的批次/主题请求不得覆盖新角色的数据。
let roleGeneration = 0;

const activeItems = computed(() => props.items.filter(item => item.status === "ACTIVE"));
const pendingCount = computed(() => runDetail.value?.suggestions.filter(item => item.status === "PENDING").length ?? 0);
const statusLabels: Record<string, string> = {
  QUEUED: "排队中", PROCESSING: "处理中", READY: "待审核", FAILED: "失败", STALE: "输入已变化",
};

watch(() => props.characterId, () => {
  roleGeneration += 1;
  // 旧请求的 finally 有 current() 守卫，切角色后不会再替新角色清状态；
  // 这几个锁必须在这里主动复位，否则旧角色遗留的 loading/starting/reviewingId
  // 会让新角色的按钮永久处于禁用或「处理中」。
  loading.value = false;
  starting.value = false;
  reviewingId.value = "";
  runs.value = [];
  selectedRunId.value = "";
  runDetail.value = null;
  activeTopics.value = [];
  selectedMembers.value = {};
  applyTopicIds.value = {};
  selectedInputIds.value = [];
  if (open.value) void loadRuns();
});

async function openDiscovery() {
  open.value = true;
  await Promise.all([loadRuns(), loadActiveTopics()]);
}
async function loadActiveTopics() {
  if (!props.characterId) return;
  const characterId = props.characterId;
  const generation = roleGeneration;
  const current = () => characterId === props.characterId && generation === roleGeneration;
  try {
    const result = await api.list({ characterId, status: "ACTIVE" });
    if (current()) activeTopics.value = result.topics;
  } catch (error) {
    if (current()) ElMessage.error(readApiErrorMessage(error, "读取可应用的主题失败。"));
  }
}
async function loadRuns() {
  if (!props.characterId) return;
  const characterId = props.characterId;
  const generation = roleGeneration;
  const current = () => characterId === props.characterId && generation === roleGeneration;
  loading.value = true;
  try {
    const result = await api.listRuns({ characterId });
    if (!current()) return;
    runs.value = result.runs;
    if (selectedRunId.value && !result.runs.some(run => run.id === selectedRunId.value)) {
      selectedRunId.value = "";
      runDetail.value = null;
    }
    if (!selectedRunId.value && result.runs.length) {
      selectedRunId.value = result.runs[0]?.id ?? "";
    }
    if (selectedRunId.value) await loadRun(selectedRunId.value);
  } catch (error) {
    if (current()) ElMessage.error(readApiErrorMessage(error, "读取主题发现批次失败。"));
  } finally {
    if (current()) loading.value = false;
  }
}
async function loadRun(runId: string) {
  if (!runId) return;
  const characterId = props.characterId;
  const generation = roleGeneration;
  const current = () => characterId === props.characterId && generation === roleGeneration && selectedRunId.value === runId;
  try {
    const result = await api.getRun({ characterId, runId });
    if (!current()) return;
    runDetail.value = result.run;
    for (const suggestion of result.run.suggestions) {
      if (!selectedMembers.value[suggestion.id]) {
        selectedMembers.value[suggestion.id] = suggestion.members.map(member => member.itemId);
      }
    }
  } catch (error) {
    if (current()) ElMessage.error(readApiErrorMessage(error, "读取主题发现结果失败。"));
  }
}
async function refresh() {
  await loadRuns();
}
async function startRun() {
  if (!selectedInputIds.value.length || starting.value) return;
  const characterId = props.characterId;
  const generation = roleGeneration;
  const current = () => characterId === props.characterId && generation === roleGeneration;
  starting.value = true;
  try {
    const result = await api.createRun({ characterId, itemIds: selectedInputIds.value });
    if (!current()) return;
    selectedInputIds.value = [];
    selectedRunId.value = result.run.id;
    ElMessage.success("主题发现任务已提交，后台正在处理。");
    await loadRuns();
  } catch (error) {
    if (current()) ElMessage.error(readApiErrorMessage(error, "创建主题发现任务失败。"));
  } finally {
    if (current()) starting.value = false;
  }
}
async function acceptSuggestion(suggestionId: string, mode: "CREATE" | "APPLY") {
  const members = selectedMembers.value[suggestionId] ?? [];
  if (!members.length) {
    ElMessage.warning("至少保留一条建议成员。");
    return;
  }
  const topicId = applyTopicIds.value[suggestionId];
  if (mode === "APPLY" && !topicId) {
    ElMessage.warning("请先选择要应用到的活动主题。");
    return;
  }
  const characterId = props.characterId;
  const generation = roleGeneration;
  const current = () => characterId === props.characterId && generation === roleGeneration;
  reviewingId.value = suggestionId;
  try {
    const result = await api.acceptSuggestion({
      characterId, suggestionId, mode,
      ...(mode === "APPLY" ? { topicId } : {}),
      memberItemIds: members,
    });
    if (!current()) return;
    ElMessage.success(mode === "CREATE" ? `已创建主题「${result.topic.name}」。` : `已将建议成员加入「${result.topic.name}」。`);
    await loadRun(selectedRunId.value);
    await loadRunsListOnly();
    await loadActiveTopics();
    emit("changed");
  } catch (error) {
    if (current()) ElMessage.error(readApiErrorMessage(error, "采纳主题建议失败；如果知识已变化，请重新发现。"));
  } finally {
    if (current()) reviewingId.value = "";
  }
}
async function dismissSuggestion(suggestionId: string) {
  const characterId = props.characterId;
  const generation = roleGeneration;
  const current = () => characterId === props.characterId && generation === roleGeneration;
  reviewingId.value = suggestionId;
  try {
    await api.dismissSuggestion({ characterId, suggestionId });
    if (!current()) return;
    ElMessage.success("已忽略这条主题建议。");
    await loadRun(selectedRunId.value);
    await loadRunsListOnly();
  } catch (error) {
    if (current()) ElMessage.error(readApiErrorMessage(error, "忽略主题建议失败。"));
  } finally {
    if (current()) reviewingId.value = "";
  }
}
async function loadRunsListOnly() {
  const characterId = props.characterId;
  const generation = roleGeneration;
  const result = await api.listRuns({ characterId });
  if (characterId === props.characterId && generation === roleGeneration) runs.value = result.runs;
}
</script>

<template>
  <div class="topic-discovery">
    <div class="discovery-heading">
      <div>
        <h3>自动主题发现</h3>
        <p>选择正式知识，让知识助手寻找它们之间的联系。发现结果只会成为待审核建议，不会自动修改知识库。</p>
      </div>
      <el-button
        type="primary"
        plain
        @click="openDiscovery"
      >
        发现与审核建议
      </el-button>
    </div>

    <el-dialog
      v-model="open"
      title="主题发现与建议审核"
      width="min(1040px, 96vw)"
      top="4vh"
      destroy-on-close
    >
      <div class="discovery-input">
        <div class="discovery-input-copy">
          <strong>发起一次发现</strong>
          <span>选择 1–50 条 ACTIVE 正式知识。任务由后台处理，可先离开页面，稍后回来刷新结果。</span>
        </div>
        <el-select
          v-model="selectedInputIds"
          multiple
          filterable
          clearable
          collapse-tags
          :max-collapse-tags="4"
          :multiple-limit="50"
          placeholder="选择需要整理的正式知识"
          style="width: 100%"
        >
          <el-option
            v-for="item in activeItems"
            :key="item.id"
            :label="item.title"
            :value="item.id"
          >
            <span>{{ item.title }}</span>
            <small class="option-meta">{{ item.category || "未分类" }}</small>
          </el-option>
        </el-select>
        <div class="discovery-input-actions">
          <span>{{ selectedInputIds.length }} / 50 条已选择</span>
          <el-button
            type="primary"
            :disabled="!selectedInputIds.length"
            :loading="starting"
            @click="startRun"
          >
            开始发现
          </el-button>
        </div>
      </div>

      <div class="discovery-workspace">
        <aside
          v-loading="loading"
          class="run-list"
        >
          <div class="run-list-heading">
            <strong>发现批次</strong>
            <el-button
              text
              :loading="loading"
              @click="refresh"
            >
              刷新
            </el-button>
          </div>
          <button
            v-for="run in runs"
            :key="run.id"
            type="button"
            class="run-list-item"
            :class="{ 'is-active': selectedRunId === run.id }"
            @click="selectedRunId = run.id; void loadRun(run.id)"
          >
            <span class="run-status">{{ statusLabels[run.status] || run.status }}</span>
            <strong>{{ run.inputCount }} 条知识 · {{ run.suggestionCount }} 条建议</strong>
            <small>{{ new Date(run.createdAt).toLocaleString() }}</small>
          </button>
          <el-empty
            v-if="!loading && !runs.length"
            description="还没有发现批次。"
            :image-size="64"
          />
        </aside>

        <div
          v-loading="loading && !runDetail"
          class="run-detail"
        >
          <template v-if="runDetail">
            <div class="run-detail-heading">
              <div>
                <strong>本次发现结果</strong>
                <p>{{ runDetail.inputSnapshot.length }} 条输入 · {{ runDetail.suggestions.length }} 条建议 · {{ runDetail.ungroupedItems.length }} 条未归组</p>
              </div>
              <el-tag :type="runDetail.status === 'READY' ? 'success' : runDetail.status === 'FAILED' || runDetail.status === 'STALE' ? 'danger' : 'info'">
                {{ statusLabels[runDetail.status] || runDetail.status }}
              </el-tag>
            </div>

            <div
              v-if="runDetail.status === 'QUEUED' || runDetail.status === 'PROCESSING'"
              class="run-notice"
            >
              后台正在分析。点击左侧刷新按钮可查看最新状态，不需要重复提交同一批知识。
            </div>
            <div
              v-if="runDetail.status === 'FAILED' || runDetail.status === 'STALE'"
              class="run-notice is-warning"
            >
              {{ runDetail.lastError || (runDetail.status === 'STALE' ? "输入知识已变化，请重新发起发现。" : "任务执行失败，请检查知识助手配置后重试。") }}
            </div>

            <template v-if="runDetail.status === 'READY'">
              <div class="review-summary">
                待审核 {{ pendingCount }} 条。你可以按建议采纳，也可以只选其中部分知识；未采纳的知识不会被移动或删除。
              </div>
              <article
                v-for="suggestion in runDetail.suggestions"
                :key="suggestion.id"
                class="suggestion-card"
              >
                <div class="suggestion-title">
                  <div>
                    <strong>{{ suggestion.name }}</strong>
                    <p>{{ suggestion.description || "暂无说明" }}</p>
                  </div>
                  <el-tag :type="suggestion.status === 'PENDING' ? 'warning' : suggestion.status === 'ACCEPTED' ? 'success' : 'info'">
                    {{ suggestion.status === 'PENDING' ? "待审核" : suggestion.status === 'ACCEPTED' ? "已采纳" : "已忽略" }}
                  </el-tag>
                </div>
                <p class="suggestion-reason">
                  整理理由：{{ suggestion.reason }}
                </p>
                <el-checkbox-group
                  v-if="suggestion.status === 'PENDING'"
                  v-model="selectedMembers[suggestion.id]"
                  class="suggestion-members"
                >
                  <el-checkbox
                    v-for="member in suggestion.members"
                    :key="member.itemId"
                    :value="member.itemId"
                    :disabled="!member.item || member.item.status !== 'ACTIVE'"
                  >
                    {{ member.item?.title || "知识已不可用" }}
                    <small v-if="member.item">{{ member.item.category || "未分类" }} · v{{ member.item.revision }}</small>
                  </el-checkbox>
                </el-checkbox-group>
                <div
                  v-else
                  class="suggestion-members accepted-members"
                >
                  <span
                    v-for="member in suggestion.acceptedMembers"
                    :key="member.itemId"
                  >{{ member.item?.title || "知识已不可用" }}</span>
                </div>
                <div
                  v-if="suggestion.status === 'PENDING'"
                  class="suggestion-actions"
                >
                  <el-button
                    type="primary"
                    :loading="reviewingId === suggestion.id"
                    :disabled="!!reviewingId || !(selectedMembers[suggestion.id]?.length)"
                    @click="acceptSuggestion(suggestion.id, 'CREATE')"
                  >
                    采纳并新建主题
                  </el-button>
                  <el-select
                    v-model="applyTopicIds[suggestion.id]"
                    clearable
                    filterable
                    placeholder="选择已有活动主题"
                    style="width: 190px"
                  >
                    <el-option
                      v-for="topic in activeTopics"
                      :key="topic.id"
                      :label="topic.name"
                      :value="topic.id"
                    />
                  </el-select>
                  <el-button
                    :loading="reviewingId === suggestion.id"
                    :disabled="!!reviewingId || !applyTopicIds[suggestion.id] || !(selectedMembers[suggestion.id]?.length)"
                    @click="acceptSuggestion(suggestion.id, 'APPLY')"
                  >
                    加入已有主题
                  </el-button>
                  <el-button
                    text
                    type="danger"
                    :loading="reviewingId === suggestion.id"
                    :disabled="!!reviewingId"
                    @click="dismissSuggestion(suggestion.id)"
                  >
                    忽略
                  </el-button>
                </div>
                <div
                  v-else-if="suggestion.status === 'ACCEPTED'"
                  class="reviewed-note"
                >
                  已审核 · {{ suggestion.acceptedMemberItemIds?.length || 0 }} 条知识实际采纳
                </div>
              </article>
              <div
                v-if="runDetail.ungroupedItems.length"
                class="ungrouped-block"
              >
                <strong>暂未发现明确主题的知识（{{ runDetail.ungroupedItems.length }}）</strong>
                <p
                  v-for="item in runDetail.ungroupedItems"
                  :key="item.id"
                >
                  {{ item.title }}
                </p>
              </div>
              <el-empty
                v-if="!runDetail.suggestions.length"
                description="这批知识没有形成主题建议，未归组内容仍可在上方查看。"
              />
            </template>
          </template>
          <el-empty
            v-else
            description="选择一个发现批次，或先发起新的发现。"
          />
        </div>
      </div>
      <template #footer>
        <el-button @click="open = false">
          关闭
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.topic-discovery { margin-top: 22px; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 12px; }
.discovery-heading, .discovery-input-actions, .run-list-heading, .run-detail-heading, .suggestion-title, .suggestion-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.discovery-heading h3 { margin: 0 0 6px; font-size: 16px; }
.discovery-heading p, .discovery-input-copy span, .run-detail-heading p, .suggestion-title p, .suggestion-reason, .reviewed-note { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
.discovery-input { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--el-fill-color-lighter); border-radius: 10px; }
.discovery-input-copy { display: flex; flex-direction: column; gap: 4px; }
.discovery-input-actions { justify-content: flex-end; color: var(--el-text-color-secondary); font-size: 12px; }
.discovery-workspace { display: grid; grid-template-columns: minmax(210px, 0.75fr) minmax(0, 2fr); gap: 16px; min-height: 300px; margin-top: 16px; }
.run-list { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.run-list-item { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; padding: 10px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; background: var(--el-bg-color); color: inherit; text-align: left; cursor: pointer; }
.run-list-item.is-active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.run-list-item strong { font-size: 12px; }
.run-list-item small, .run-status, .option-meta { color: var(--el-text-color-secondary); font-size: 12px; }
.run-status { color: var(--el-color-primary); }
.run-detail { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.run-detail-heading { padding-bottom: 10px; border-bottom: 1px solid var(--el-border-color-lighter); }
.run-detail-heading p { margin-top: 4px; }
.run-notice, .review-summary, .ungrouped-block { padding: 10px 12px; border-radius: 8px; background: var(--el-fill-color-lighter); font-size: 12px; line-height: 1.6; }
.run-notice.is-warning { color: var(--el-color-warning); }
.suggestion-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--el-border-color); border-radius: 10px; }
.suggestion-title { align-items: flex-start; }
.suggestion-title strong { font-size: 16px; }
.suggestion-reason { padding: 8px 10px; background: var(--el-fill-color-lighter); border-radius: 6px; }
.suggestion-members { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; }
.suggestion-members :deep(.el-checkbox) { height: auto; margin-right: 0; white-space: normal; }
.suggestion-members :deep(.el-checkbox__label) { display: inline-flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.suggestion-members small { color: var(--el-text-color-secondary); font-size: 12px; }
.accepted-members span { font-size: 12px; }
.suggestion-actions { justify-content: flex-start; flex-wrap: wrap; }
.reviewed-note { color: var(--el-color-success); }
.ungrouped-block p { margin: 5px 0 0; color: var(--el-text-color-secondary); }
.option-meta { float: right; }
@media (max-width: 760px) { .discovery-heading { align-items: flex-start; flex-direction: column; } .discovery-workspace { grid-template-columns: 1fr; } .suggestion-actions { align-items: stretch; flex-direction: column; } .suggestion-actions > * { width: 100%; } }
</style>
