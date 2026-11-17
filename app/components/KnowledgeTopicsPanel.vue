<script setup lang="ts">
import { ElMessage, ElMessageBox } from "element-plus";
import { readApiErrorMessage } from "~/utils/api-error";
import { createKnowledgeTopicsApi, type KnowledgeTopicDetail, type KnowledgeTopicRevision, type KnowledgeTopicSummary } from "~/api/knowledge-topics";
import type { KnowledgeItem } from "~/api/knowledge";

const props = defineProps<{ characterId: string; items: KnowledgeItem[] }>();
const emit = defineEmits<{ changed: [] }>();
const api = createKnowledgeTopicsApi(useApiRequest());
const loading = ref(false);
const saving = ref(false);
const topics = ref<KnowledgeTopicSummary[]>([]);
const status = ref<"ACTIVE" | "ARCHIVED">("ACTIVE");
const selectedId = ref("");
const detail = ref<KnowledgeTopicDetail | null>(null);
const revisions = ref<KnowledgeTopicRevision[]>([]);
const historyOpen = ref(false);
const historyLoading = ref(false);
const formOpen = ref(false);
const formName = ref("");
const formDescription = ref("");
const editing = ref(false);
const selectedItemIds = ref<string[]>([]);
const addingMembers = ref(false);
const detailLoading = ref(false);
let listRequest = 0;
let detailRequest = 0;
let historyRequest = 0;
onBeforeUnmount(() => { listRequest++; detailRequest++; historyRequest++; });
const splitOpen = ref(false);
const splitName = ref("");
const splitDescription = ref("");
const splitMemberItemIds = ref<string[]>([]);
const splitting = ref(false);
const mergeOpen = ref(false);
const mergeTargetId = ref("");
const merging = ref(false);
const splitCandidates = computed(() => detail.value?.members.filter(member => member.valid) ?? []);
const mergeCandidates = computed(() => topics.value.filter(topic => topic.status === "ACTIVE" && topic.id !== detail.value?.id));

const availableItems = computed(() => props.items.filter(item =>
  item.status === "ACTIVE" && !detail.value?.members.some(member => member.itemId === item.id && member.valid),
));

async function loadTopics() {
  const request = ++listRequest;
  const characterId = props.characterId;
  if (!characterId) { loading.value = false; return; }
  loading.value = true;
  try {
    const result = await api.list({ characterId, status: status.value });
    if (request !== listRequest || characterId !== props.characterId) return;
    topics.value = result.topics;
    if (selectedId.value && !result.topics.some(topic => topic.id === selectedId.value)) {
      selectedId.value = "";
      detail.value = null;
    }
    if (!selectedId.value && result.topics.length) selectedId.value = result.topics[0]?.id ?? "";
    else if (selectedId.value) await loadDetail(selectedId.value);
  } catch (error) {
    if (request === listRequest) ElMessage.error(readApiErrorMessage(error, "读取主题失败。"));
  } finally {
    if (request === listRequest) loading.value = false;
  }
}

async function loadDetail(topicId: string) {
  const request = ++detailRequest;
  const characterId = props.characterId;
  if (!topicId) return;
  detailLoading.value = true;
  try {
    const result = await api.get({ characterId, topicId });
    if (request === detailRequest && characterId === props.characterId && selectedId.value === topicId) detail.value = result.topic;
  } catch (error) {
    if (request === detailRequest && characterId === props.characterId) ElMessage.error(readApiErrorMessage(error, "读取主题详情失败。"));
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

watch(() => props.characterId, () => {
  selectedId.value = "";
  detail.value = null;
  topics.value = [];
  void loadTopics();
}, { immediate: true });
watch(status, () => {
  selectedId.value = "";
  detail.value = null;
  void loadTopics();
});
watch(selectedId, id => {
  detailRequest++;
  historyRequest++;
  detail.value = null;
  detailLoading.value = false;
  selectedItemIds.value = [];
  revisions.value = [];
  historyOpen.value = false;
  formOpen.value = false;
  if (id) void loadDetail(id);
}, { flush: "sync" });

function openCreate() {
  editing.value = false;
  formName.value = "";
  formDescription.value = "";
  formOpen.value = true;
}
function openEdit() {
  if (!detail.value) return;
  editing.value = true;
  formName.value = detail.value.name;
  formDescription.value = detail.value.description;
  formOpen.value = true;
}
async function saveTopic() {
  const name = formName.value.trim();
  if (!name || saving.value) return;
  saving.value = true;
  try {
    if (editing.value && detail.value) {
      await api.update({ characterId: props.characterId, topicId: detail.value.id, name, description: formDescription.value.trim(), revision: detail.value.revision });
      ElMessage.success("主题已更新。");
    } else {
      const result = await api.create({ characterId: props.characterId, name, description: formDescription.value.trim() });
      selectedId.value = result.topic.id;
      ElMessage.success("主题已创建。");
    }
    formOpen.value = false;
    await loadTopics();
    emit("changed");
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "保存主题失败。"));
  } finally {
    saving.value = false;
  }
}
async function toggleArchive() {
  if (!detail.value) return;
  const topic = detail.value;
  const characterId = props.characterId;
  const archived = topic.status === "ARCHIVED";
  try {
    await ElMessageBox.confirm(
      archived ? "恢复后主题会重新出现在活动主题列表。" : "归档不会删除主题或知识，只会将主题从活动列表中收起。",
      archived ? "恢复主题" : "归档主题",
      { type: "warning", confirmButtonText: archived ? "恢复" : "归档", cancelButtonText: "取消" },
    );
    if (characterId !== props.characterId || selectedId.value !== topic.id) return;
    await api.update({ characterId, topicId: topic.id, name: topic.name, description: topic.description, revision: topic.revision, status: archived ? "ACTIVE" : "ARCHIVED" });
    if (characterId !== props.characterId || selectedId.value !== topic.id) return;
    ElMessage.success(archived ? "主题已恢复。" : "主题已归档。");
    selectedId.value = "";
    await loadTopics();
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(readApiErrorMessage(error, "主题状态更新失败。"));
  }
}
async function addMembers() {
  if (!detail.value || !selectedItemIds.value.length || addingMembers.value) return;
  addingMembers.value = true;
  try {
    await api.addMembers({ characterId: props.characterId, topicId: detail.value.id, itemIds: selectedItemIds.value, revision: detail.value.revision });
    selectedItemIds.value = [];
    ElMessage.success("知识已加入主题。");
    await loadTopics();
    emit("changed");
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "添加主题成员失败。"));
  } finally {
    addingMembers.value = false;
  }
}
async function removeMember(itemId: string, title: string) {
  if (!detail.value) return;
  const topic = detail.value;
  const characterId = props.characterId;
  try {
    await ElMessageBox.confirm(`确定将「${title}」从主题中移除吗？知识条目本身不会删除。`, "移除主题成员", { type: "warning" });
    if (characterId !== props.characterId || selectedId.value !== topic.id) return;
    await api.removeMember({ characterId, topicId: topic.id, itemId, revision: topic.revision });
    if (characterId !== props.characterId || selectedId.value !== topic.id) return;
    ElMessage.success("已从主题移除。");
    await loadTopics();
    emit("changed");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(readApiErrorMessage(error, "移除成员失败。"));
  }
}
function openSplit() {
  if (!detail.value || detail.value.status !== "ACTIVE" || splitCandidates.value.length < 2) return;
  splitName.value = `${detail.value.name}（拆分）`;
  splitDescription.value = detail.value.description;
  splitMemberItemIds.value = [];
  splitOpen.value = true;
}
async function submitSplit() {
  if (!detail.value || !splitName.value.trim() || !splitMemberItemIds.value.length
    || splitMemberItemIds.value.length >= splitCandidates.value.length || splitting.value) return;
  splitting.value = true;
  try {
    const result = await api.split({
      characterId: props.characterId,
      topicId: detail.value.id,
      name: splitName.value.trim(),
      description: splitDescription.value.trim(),
      memberItemIds: splitMemberItemIds.value,
      revision: detail.value.revision,
    });
    selectedId.value = result.newTopic.id;
    splitOpen.value = false;
    ElMessage.success(`已拆分为新主题「${result.newTopic.name}」，移动 ${result.movedItemIds.length} 条知识，原主题保留 ${result.remainingItemIds.length} 条。`);
    await loadTopics();
    emit("changed");
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "拆分主题失败；如果主题已变化，请刷新后重试。"));
  } finally {
    splitting.value = false;
  }
}
function openMerge() {
  if (!detail.value || detail.value.status !== "ACTIVE" || !mergeCandidates.value.length) return;
  mergeTargetId.value = "";
  mergeOpen.value = true;
}
async function submitMerge() {
  if (!detail.value || !mergeTargetId.value || merging.value) return;
  const target = mergeCandidates.value.find(topic => topic.id === mergeTargetId.value);
  if (!target) return;
  try {
    await ElMessageBox.confirm(
      `将「${detail.value.name}」合并到「${target.name}」？目标主题会保留名称与身份，来源主题会标记为已合并并保留历史。知识条目本身不会被修改或删除。`,
      "确认合并主题",
      { type: "warning", confirmButtonText: "确认合并", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  merging.value = true;
  try {
    const result = await api.merge({
      characterId: props.characterId,
      sourceTopicId: detail.value.id,
      targetTopicId: target.id,
      sourceRevision: detail.value.revision,
      targetRevision: target.revision,
    });
    selectedId.value = target.id;
    mergeOpen.value = false;
    ElMessage.success(`已合并到「${target.name}」；新增 ${result.addedItemIds.length} 条成员，重复成员 ${result.alreadyPresentItemIds.length} 条已去重。`);
    await loadTopics();
    emit("changed");
  } catch (error) {
    ElMessage.error(readApiErrorMessage(error, "合并主题失败；如果任一主题已变化，请刷新后重试。"));
  } finally {
    merging.value = false;
  }
}

async function openHistory() {
  if (!detail.value) return;
  const request = ++historyRequest;
  const characterId = props.characterId;
  const topicId = detail.value.id;
  revisions.value = [];
  historyOpen.value = true;
  historyLoading.value = true;
  try {
    const result = await api.listRevisions({ characterId, topicId });
    if (request === historyRequest && characterId === props.characterId && topicId === selectedId.value) revisions.value = result.revisions;
  } catch (error) {
    if (request === historyRequest) ElMessage.error(readApiErrorMessage(error, "读取主题历史失败。"));
  } finally {
    if (request === historyRequest) historyLoading.value = false;
  }
}
async function restoreRevision(revision: number) {
  if (!detail.value) return;
  const topic = detail.value;
  const characterId = props.characterId;
  try {
    await ElMessageBox.confirm(`将主题恢复到版本 v${revision}？当前版本会先自动保存为历史记录。`, "恢复历史版本", { type: "warning", confirmButtonText: "恢复此版本", cancelButtonText: "取消" });
    if (characterId !== props.characterId || selectedId.value !== topic.id) return;
    await api.restoreRevision({ characterId, topicId: topic.id, revision, expectedRevision: topic.revision });
    if (characterId !== props.characterId || selectedId.value !== topic.id) return;
    ElMessage.success("主题已恢复，恢复操作也生成了新的版本。");
    historyOpen.value = false;
    await loadTopics();
    emit("changed");
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(readApiErrorMessage(error, "恢复主题失败；如果主题已更新，请刷新后重试。"));
  }
}
</script>

<template>
  <section class="knowledge-section topic-manager">
    <div class="section-heading">
      <div><span class="eyebrow">TOPICS</span><h2>知识主题</h2><p class="topic-intro">将相关知识整理到同一主题，保留条目来源与版本记录。</p></div>
      <div class="topic-toolbar">
        <el-radio-group v-model="status" size="small">
          <el-radio-button value="ACTIVE">活动主题</el-radio-button>
          <el-radio-button value="ARCHIVED">已归档</el-radio-button>
        </el-radio-group>
        <el-button type="primary" @click="openCreate">新建主题</el-button>
        <el-button :loading="loading" @click="loadTopics">刷新</el-button>
      </div>
    </div>

    <div v-loading="loading" class="topic-layout">
      <aside class="topic-list">
        <button v-for="topic in topics" :key="topic.id" type="button" class="topic-list-item" :class="{ 'is-active': selectedId === topic.id }" @click="selectedId = topic.id">
          <strong>{{ topic.name }}</strong>
          <span>{{ topic.memberCount }} 条知识 · v{{ topic.revision }}</span>
        </button>
        <el-empty v-if="!loading && !topics.length" :description="status === 'ARCHIVED' ? '暂无已归档主题。' : '还没有主题，点击「新建主题」开始整理。'" />
      </aside>

      <div v-if="detailLoading" v-loading="true" class="topic-detail topic-detail-loading" aria-label="正在加载主题详情" />
      <div v-else-if="detail" class="topic-detail">
        <div class="topic-detail-heading">
          <div><h3>{{ detail.name }}</h3><p>{{ detail.description || "暂无主题说明" }}</p></div>
          <div class="topic-toolbar">
            <el-button @click="openHistory">历史版本</el-button>
            <el-button :disabled="detail.status !== 'ACTIVE' || splitCandidates.length < 2" @click="openSplit">拆分主题</el-button>
            <el-button :disabled="detail.status !== 'ACTIVE' || !mergeCandidates.length" @click="openMerge">合并到…</el-button>
            <el-button :disabled="detail.status === 'MERGED'" @click="openEdit">编辑</el-button>
            <el-button :disabled="detail.status === 'MERGED'" @click="toggleArchive">{{ detail.status === "ARCHIVED" ? "恢复主题" : "归档主题" }}</el-button>
          </div>
        </div>
        <div class="topic-meta">版本 v{{ detail.revision }} · {{ detail.members.filter(member => member.valid).length }} 条有效知识 · {{ detail.members.length }} 条成员记录</div>

        <div v-if="detail.status === 'MERGED'" class="topic-warning">
          此主题已合并<template v-if="detail.mergedInto">至「{{ detail.mergedInto.name }}」</template>，仅保留历史追溯，不可继续编辑。
        </div>
        <div v-if="detail.status !== 'MERGED'" class="topic-add-members">
          <el-select v-model="selectedItemIds" multiple filterable clearable collapse-tags :max-collapse-tags="3" placeholder="搜索并选择可用知识" style="width: 100%">
            <el-option v-for="item in availableItems" :key="item.id" :label="item.title" :value="item.id" />
          </el-select>
          <el-button type="primary" :disabled="!selectedItemIds.length" :loading="addingMembers" @click="addMembers">添加到主题</el-button>
        </div>

        <div class="topic-members">
          <article v-for="member in detail.members" :key="member.id" class="topic-member">
            <div>
              <strong>{{ member.item?.title || '知识条目不可用' }}</strong>
              <p v-if="member.valid">{{ member.item?.category || "未分类" }}<span v-if="member.itemRevisionChanged"> · 加入主题后知识已更新</span></p>
              <p v-else class="topic-invalid">成员不可用：{{ member.invalidReason || "状态异常" }}</p>
              <p v-if="member.valid && member.item?.content" class="topic-member-preview">{{ member.item.content }}</p>
            </div>
            <el-button v-if="detail.status !== 'MERGED'" text type="danger" :disabled="!member.valid" @click="removeMember(member.itemId, member.item?.title || '该知识')">移除</el-button>
          </article>
          <el-empty v-if="!detail.members.length" description="这个主题还没有知识成员。" />
        </div>
      </div>
      <el-empty v-else-if="!loading && topics.length" description="选择一个主题查看详情。" />
    </div>

    <el-dialog v-model="formOpen" :title="editing ? '编辑主题' : '新建主题'" width="min(560px, 92vw)">
      <el-form label-position="top">
        <el-form-item label="主题名称"><el-input v-model="formName" maxlength="80" show-word-limit placeholder="例如：表达习惯与互动偏好" /></el-form-item>
        <el-form-item label="主题说明"><el-input v-model="formDescription" type="textarea" :rows="3" maxlength="500" show-word-limit placeholder="简要说明这个主题包含什么内容" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="formOpen = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!formName.trim()" @click="saveTopic">保存</el-button></template>
    </el-dialog>

    <el-dialog v-model="splitOpen" title="拆分主题" width="min(620px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="新主题名称">
          <el-input v-model="splitName" maxlength="200" show-word-limit placeholder="输入拆分后主题的名称" />
        </el-form-item>
        <el-form-item label="新主题说明">
          <el-input v-model="splitDescription" type="textarea" :rows="3" maxlength="5000" show-word-limit placeholder="可选，说明新主题的范围" />
        </el-form-item>
        <el-form-item label="移动到新主题的知识">
          <el-select v-model="splitMemberItemIds" multiple filterable collapse-tags :max-collapse-tags="4" placeholder="选择要拆分出去的有效知识" style="width: 100%">
            <el-option v-for="member in splitCandidates" :key="member.itemId" :label="member.item?.title || member.itemId" :value="member.itemId" />
          </el-select>
          <small class="topic-dialog-hint">原主题至少保留一条有效知识。已失效成员不会出现在可选列表中。</small>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="splitOpen = false">取消</el-button>
        <el-button type="primary" :loading="splitting" :disabled="!splitName.trim() || !splitMemberItemIds.length || splitMemberItemIds.length >= splitCandidates.length" @click="submitSplit">确认拆分</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeOpen" title="合并主题" width="min(560px, 92vw)">
      <p class="topic-dialog-copy">选择一个活动主题作为保留目标。当前主题将变为“已合并”，不会被物理删除。</p>
      <el-select v-model="mergeTargetId" filterable placeholder="选择目标主题" style="width: 100%">
        <el-option v-for="topic in mergeCandidates" :key="topic.id" :label="`${topic.name} · v${topic.revision} · ${topic.memberCount} 条知识`" :value="topic.id" />
      </el-select>
      <template #footer>
        <el-button @click="mergeOpen = false">取消</el-button>
        <el-button type="danger" :loading="merging" :disabled="!mergeTargetId" @click="submitMerge">确认合并</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="historyOpen" title="主题历史版本" width="min(680px, 94vw)">
      <div v-loading="historyLoading" class="topic-history">
        <article v-for="revision in revisions" :key="revision.id" class="topic-history-item">
          <div><strong>版本 v{{ revision.revision }} · {{ revision.name }}</strong><p>{{ revision.description || "无主题说明" }}</p><small>{{ new Date(revision.createdAt).toLocaleString() }} · {{ revision.status }}</small></div>
          <el-button v-if="detail && revision.revision < detail.revision && revision.status !== 'MERGED' && detail.status !== 'MERGED'" type="primary" plain @click="restoreRevision(revision.revision)">恢复此版本</el-button>
          <el-tag v-else-if="detail?.revision === revision.revision" type="success">当前版本</el-tag>
        </article>
        <el-empty v-if="!historyLoading && !revisions.length" description="暂无历史版本。" />
      </div>
    </el-dialog>

    <KnowledgeTopicDiscoveryPanel :character-id="characterId" :items="items" @changed="emit('changed')" />
  </section>
</template>

<style scoped>
.section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.section-heading h2 { margin: 6px 0; font-size: 22px; }
.eyebrow { font-size: 12px; letter-spacing: 0.12em; color: var(--el-color-primary); }
.topic-intro { margin: 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.topic-detail-loading { min-height: 260px; }
.topic-list-item strong, .topic-detail-heading h3, .topic-detail-heading p, .topic-member strong, .topic-history-item strong { overflow-wrap: anywhere; }
.topic-list-item { font: inherit; }
.topic-list-item:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
.topic-list-item:hover { border-color: var(--el-color-primary-light-5); }
.topic-member > div, .topic-history-item > div { min-width: 0; }
.topic-member .topic-member-preview { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; white-space: pre-line; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); margin-top: 8px; }
.topic-detail { padding: 18px; border: 1px solid var(--el-border-color-lighter); border-radius: 12px; background: var(--el-bg-color); }
.topic-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.topic-layout { display: grid; grid-template-columns: minmax(210px, 0.8fr) minmax(0, 2fr); gap: 18px; min-height: 300px; }
.topic-list { display: flex; flex-direction: column; gap: 6px; }
.topic-list-item { display: flex; flex-direction: column; gap: 5px; text-align: left; padding: 12px; border: 1px solid var(--el-border-color); border-radius: 10px; background: var(--el-bg-color); cursor: pointer; color: inherit; }
.topic-list-item.is-active { border-color: var(--el-color-primary); background: var(--el-color-primary-light-9); }
.topic-list-item span, .topic-meta, .topic-member p, .topic-history-item p, .topic-history-item small { color: var(--el-text-color-secondary); font-size: 12px; }
.topic-detail { min-width: 0; }
.topic-detail-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.topic-detail-heading h3 { margin: 0 0 6px; font-size: 18px; }
.topic-detail-heading p { margin: 0; color: var(--el-text-color-secondary); }
.topic-meta { margin: 12px 0 16px; }
.topic-add-members { display: flex; gap: 8px; margin-bottom: 14px; }
.topic-members { display: flex; flex-direction: column; gap: 8px; }
.topic-member, .topic-history-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--el-border-color-lighter); border-radius: 8px; }
.topic-member p, .topic-history-item p { margin: 5px 0 0; }
.topic-invalid, .topic-warning { color: var(--el-color-warning); }
.topic-warning { padding: 10px; margin: 12px 0; border-radius: 8px; background: var(--el-color-warning-light-9); }
.topic-history { display: flex; flex-direction: column; gap: 8px; }
.topic-dialog-hint, .topic-dialog-copy { color: var(--el-text-color-secondary); font-size: 12px; }
.topic-dialog-hint { display: block; margin-top: 6px; }
@media (max-width: 760px) { .topic-layout { grid-template-columns: 1fr; } .topic-add-members { flex-direction: column; } }
</style>
