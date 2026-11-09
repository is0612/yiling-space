<script setup lang="ts">
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "知识系统" } });

type KnowledgeResult = {
  isKnowledge: boolean;
  recommendation: "CREATE" | "DUPLICATE" | "CONFLICT" | "DISCARD";
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number;
  reason: string;
  relatedItemIds: string[];
  confirmedRelatedItemIds?: string[];
};
type KnowledgeRelatedItem = { id: string; title: string; content: string; category: string; tags: string[]; revision: number };
type KnowledgeRelationView = {
  id: string; sourceItemId: string; targetItemId: string; relationType: string; status: string; resolution: string | null; metadata: unknown; updatedAt: string;
  relatedItem: { id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null; status: string; revision: number; sourceType: string; sourceRef: unknown };
};
type KnowledgeMergeDraft = {
  sourceItemId: string; targetItemId: string; expectedSourceRevision: number; expectedTargetRevision: number;
  sourceTitle: string; sourceContent: string; sourceCategory: string; sourceConfidence: number | null; sourceTags: string[];
  sourceType: string; sourceRef: unknown;
  targetTitle: string; targetContent: string; targetCategory: string; targetConfidence: number | null; targetTags: string[];
  targetSourceType: string; targetSourceRef: unknown;
  title: string; content: string; category: string; tagsText: string; confidence: string;
};
type Candidate = {
  id: string; sourceType: string; sourceRef: unknown; rawContent: string; status: string;
  processedResult: KnowledgeResult | null; processingError: string | null; processedAt: string | null; createdAt: string;
  relatedItems: KnowledgeRelatedItem[];
};
type KnowledgeItem = {
  id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null;
  status: string; sourceType: string; sourceRef: unknown; revision: number; createdAt: string; updatedAt: string;
  relations: KnowledgeRelationView[];
};
type KnowledgeItemRevision = {
  id: string; revision: number; title: string; content: string; category: string; tags: string[];
  confidence: number | null; status: string; sourceType: string; sourceRef: unknown; createdAt: string;
};
type KnowledgeItemDraft = { title: string; content: string; category: string; tagsText: string; confidence: string };
type WorkspaceData = { candidates: Candidate[]; items: KnowledgeItem[]; candidateCount: number; itemCount: number };
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const loading = ref(false);
const savingCandidate = ref(false);
const rawContent = ref("");
const keyword = ref("");
const data = ref<WorkspaceData>({ candidates: [], items: [], candidateCount: 0, itemCount: 0 });
const busyIds = ref<string[]>([]);
const editingItemId = ref("");
const editDraft = ref<KnowledgeItemDraft>({ title: "", content: "", category: "", tagsText: "", confidence: "" });
const savingItem = ref(false);
const historyItemId = ref("");
const historyLoading = ref(false);
const historyItems = ref<KnowledgeItemRevision[]>([]);
const mergeDraft = ref<KnowledgeMergeDraft | null>(null);
const mergingKnowledge = ref(false);
const resolvingRelationIds = ref<string[]>([]);
let historyRequestVersion = 0;

let loadVersion = 0;
let roleVersion = 0;
let pageDisposed = false;

function emptyWorkspaceData(): WorkspaceData {
  return { candidates: [], items: [], candidateCount: 0, itemCount: 0 };
}

function isCurrentRole(targetCharacterId: string, expectedRoleVersion: number): boolean {
  return !pageDisposed
    && characterId.value === targetCharacterId
    && roleVersion === expectedRoleVersion;
}

async function load(
  requestedCharacterId: string = characterId.value,
  requestedKeyword: string = keyword.value.trim(),
) {
  const requestVersion = ++loadVersion;
  const requestedRoleVersion = roleVersion;
  if (pageDisposed || requestedCharacterId !== characterId.value) return;
  if (!requestedCharacterId) {
    data.value = emptyWorkspaceData();
    loading.value = false;
    return;
  }

  loading.value = true;
  try {
    const result = await $fetch<WorkspaceData>(
      `/api/characters/${encodeURIComponent(requestedCharacterId)}/growth/knowledge`,
      { query: requestedKeyword ? { q: requestedKeyword } : {} },
    );
    if (requestVersion !== loadVersion || !isCurrentRole(requestedCharacterId, requestedRoleVersion)) return;
    data.value = result;
  } catch (error) {
    if (requestVersion !== loadVersion || !isCurrentRole(requestedCharacterId, requestedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "读取知识系统失败。");
  } finally {
    if (requestVersion === loadVersion && isCurrentRole(requestedCharacterId, requestedRoleVersion)) {
      loading.value = false;
    }
  }
}

watch(characterId, (nextCharacterId: string) => {
  // 切换角色立即作废旧请求，并清空旧角色内容，避免旧资料短暂显示在新角色名下。
  roleVersion += 1;
  loadVersion += 1;
  data.value = emptyWorkspaceData();
  rawContent.value = "";
  busyIds.value = [];
  savingCandidate.value = false;
  editingItemId.value = "";
  editDraft.value = { title: "", content: "", category: "", tagsText: "", confidence: "" };
  savingItem.value = false;
  historyItemId.value = "";
  historyLoading.value = false;
  historyItems.value = [];
  historyRequestVersion += 1;
  mergeDraft.value = null;
  mergingKnowledge.value = false;
  resolvingRelationIds.value = [];
  loading.value = false;
  if (nextCharacterId) void load(nextCharacterId);
}, { immediate: true, flush: "sync" });
watch(keyword, () => { void load(); });

onBeforeUnmount(() => {
  pageDisposed = true;
  roleVersion += 1;
  loadVersion += 1;
  historyRequestVersion += 1;
});

async function addCandidate() {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  const content = rawContent.value.trim();
  if (!targetCharacterId || savingCandidate.value || !content || pageDisposed) return;
  savingCandidate.value = true;
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates`,
      { method: "POST", body: { rawContent: content, sourceType: "MANUAL" } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    rawContent.value = "";
    ElMessage.success("已加入知识候选。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "添加候选失败。");
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) savingCandidate.value = false;
  }
}

async function runCandidate(candidate: Candidate) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || busyIds.value.includes(candidate.id)) return;
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/process`,
      { method: "POST" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("知识处理完成，请检查结果后决定是否入库。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "知识处理失败。");
    await load(targetCharacterId);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      busyIds.value = busyIds.value.filter(id => id !== candidate.id);
    }
  }
}

async function acceptCandidate(candidate: Candidate) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed || busyIds.value.includes(candidate.id)) return;
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/accept`,
      { method: "POST" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("已正式加入知识库。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "入库失败。");
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      busyIds.value = busyIds.value.filter(id => id !== candidate.id);
    }
  }
}

async function toggleCandidateRelation(candidate: Candidate, target: KnowledgeRelatedItem) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || !isCurrentRole(targetCharacterId, expectedRoleVersion) || busyIds.value.includes(candidate.id)) return;
  const current = candidate.processedResult?.confirmedRelatedItemIds ?? [];
  const confirmed = !current.includes(target.id);
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/relations`,
      { method: "POST", body: { targetItemId: target.id, confirmed } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success(confirmed ? "已确认这条关联。" : "已取消这条关联。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "调整关联失败。");
    await load(targetCharacterId);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      busyIds.value = busyIds.value.filter(id => id !== candidate.id);
    }
  }
}

async function dismissCandidate(candidate: Candidate) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || pageDisposed) return;
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/dismiss`,
      { method: "POST" },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("已忽略这条候选。");
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "操作失败。");
  }
}
function startEdit(item: KnowledgeItem) {
  editingItemId.value = item.id;
  editDraft.value = {
    title: item.title,
    content: item.content,
    category: item.category,
    tagsText: item.tags.join(", "),
    confidence: item.confidence === null ? "" : String(item.confidence),
  };
}

function cancelEdit() {
  editingItemId.value = "";
  editDraft.value = { title: "", content: "", category: "", tagsText: "", confidence: "" };
}

async function saveEdit(item: KnowledgeItem) {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || savingItem.value || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const draft = { ...editDraft.value };
  const rawConfidence = draft.confidence.trim();
  const confidence = rawConfidence ? Number(rawConfidence) : null;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    ElMessage.error("可信度必须是 0 到 1 之间的数字，留空表示未标注。");
    return;
  }
  const tags = draft.tagsText.split(/[，,]/).map(tag => tag.trim()).filter(Boolean);
  savingItem.value = true;
  try {
    const result = await $fetch<{ item: KnowledgeItem; unchanged: boolean }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/items/${encodeURIComponent(item.id)}`,
      {
        method: "PATCH",
        body: {
          revision: item.revision,
          title: draft.title,
          content: draft.content,
          category: draft.category,
          tags,
          confidence,
        },
      },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success(result.unchanged ? "内容没有变化。" : `已保存为第 ${result.item.revision} 版。`);
    cancelEdit();
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string; statusCode?: number } };
    ElMessage.error(e.data?.statusMessage || (e.data?.statusCode === 409 ? "知识已更新，请检查最新版本后重新编辑。" : "保存知识失败。"));
    if (e.data?.statusCode === 409) {
      cancelEdit();
      await load(targetCharacterId);
    }
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) savingItem.value = false;
  }
}

async function toggleHistory(item: KnowledgeItem) {
  if (historyItemId.value === item.id) {
    historyRequestVersion += 1;
    historyItemId.value = "";
    historyItems.value = [];
    historyLoading.value = false;
    return;
  }
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const requestVersion = ++historyRequestVersion;
  historyItemId.value = item.id;
  historyItems.value = [];
  historyLoading.value = true;
  try {
    const result = await $fetch<{ revisions: KnowledgeItemRevision[] }>(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/items/${encodeURIComponent(item.id)}/history`,
    );
    if (requestVersion !== historyRequestVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    historyItems.value = result.revisions;
  } catch (error) {
    if (requestVersion !== historyRequestVersion || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "读取知识版本历史失败。");
  } finally {
    if (requestVersion === historyRequestVersion && isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      historyLoading.value = false;
    }
  }
}

function startMerge(
  source: { id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null; revision: number; status?: string; sourceType: string; sourceRef: unknown },
  target: { id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null; revision: number; status?: string; sourceType: string; sourceRef: unknown },
) {
  if (source.id === target.id || source.status === "MERGED" || target.status === "MERGED") return;
  mergeDraft.value = {
    sourceItemId: source.id,
    targetItemId: target.id,
    expectedSourceRevision: source.revision,
    expectedTargetRevision: target.revision,
    sourceTitle: source.title,
    sourceContent: source.content,
    sourceCategory: source.category,
    sourceConfidence: source.confidence,
    sourceTags: source.tags,
    sourceType: source.sourceType,
    sourceRef: source.sourceRef,
    targetTitle: target.title,
    targetContent: target.content,
    targetCategory: target.category,
    targetConfidence: target.confidence,
    targetTags: target.tags,
    targetSourceType: target.sourceType,
    targetSourceRef: target.sourceRef,
    title: target.title,
    content: target.content,
    category: target.category,
    tagsText: target.tags.join(", "),
    confidence: target.confidence === null ? "" : String(target.confidence),
  };
}

function cancelMerge() {
  if (mergingKnowledge.value) return;
  mergeDraft.value = null;
}

async function submitMerge() {
  const draft = mergeDraft.value;
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!draft || !targetCharacterId || mergingKnowledge.value || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const rawConfidence = draft.confidence.trim();
  const confidence = rawConfidence ? Number(rawConfidence) : null;
  if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    ElMessage.error("可信度必须是 0 到 1 之间的数字，留空表示未标注。");
    return;
  }
  const tags = draft.tagsText.split(/[，,]/).map(tag => tag.trim()).filter(Boolean);
  mergingKnowledge.value = true;
  busyIds.value = [...new Set([...busyIds.value, draft.sourceItemId, draft.targetItemId])];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/items/${encodeURIComponent(draft.sourceItemId)}/merge`,
      {
        method: "POST",
        body: {
          targetItemId: draft.targetItemId,
          expectedSourceRevision: draft.expectedSourceRevision,
          expectedTargetRevision: draft.expectedTargetRevision,
          title: draft.title,
          content: draft.content,
          category: draft.category,
          tags,
          confidence,
        },
      },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    ElMessage.success("重复知识已合并，源条目和双方历史均已保留。");
    mergeDraft.value = null;
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string; statusCode?: number } };
    ElMessage.error(e.data?.statusMessage || "合并知识失败。");
    if (e.data?.statusCode === 409) {
      mergeDraft.value = null;
      await load(targetCharacterId);
    }
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      mergingKnowledge.value = false;
      busyIds.value = busyIds.value.filter(id => id !== draft.sourceItemId && id !== draft.targetItemId);
    }
  }
}

async function resolveRelation(item: KnowledgeItem, relation: KnowledgeRelationView, action: "CONFIRM_CONFLICT" | "NEEDS_VERIFICATION" | "KEEP_SEPARATE" | "DISMISS") {
  const targetCharacterId = characterId.value;
  const expectedRoleVersion = roleVersion;
  if (!targetCharacterId || relation.status !== "OPEN" || resolvingRelationIds.value.includes(relation.id)
    || !isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
  const sourceRevision = relation.sourceItemId === item.id ? item.revision : relation.relatedItem.revision;
  const targetRevision = relation.targetItemId === item.id ? item.revision : relation.relatedItem.revision;
  resolvingRelationIds.value = [...resolvingRelationIds.value, relation.id];
  try {
    await $fetch(
      `/api/characters/${encodeURIComponent(targetCharacterId)}/growth/knowledge/relations/${encodeURIComponent(relation.id)}/resolve`,
      { method: "POST", body: { action, expectedSourceRevision: sourceRevision, expectedTargetRevision: targetRevision } },
    );
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const messages: Record<typeof action, string> = {
      CONFIRM_CONFLICT: "已确认冲突，双方知识均予以保留。",
      NEEDS_VERIFICATION: "已标记待核实。",
      KEEP_SEPARATE: "已保留为两条独立知识。",
      DISMISS: "已忽略这条关联建议。",
    };
    ElMessage.success(messages[action]);
    await load(targetCharacterId);
  } catch (error) {
    if (!isCurrentRole(targetCharacterId, expectedRoleVersion)) return;
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "处置知识关联失败。");
    await load(targetCharacterId);
  } finally {
    if (isCurrentRole(targetCharacterId, expectedRoleVersion)) {
      resolvingRelationIds.value = resolvingRelationIds.value.filter(id => id !== relation.id);
    }
  }
}

function relationStatusLabel(relation: KnowledgeRelationView) {
  if (relation.resolution === "NEEDS_VERIFICATION") return "待核实";
  if (relation.resolution === "MERGED") return "已合并";
  if (relation.resolution === "SOURCE_MERGED") return "源知识已合并";
  return relation.status === "OPEN" ? "待处理" : relation.status === "RESOLVED" ? "已处理" : "已忽略";
}

function sourceLabel(sourceType: string) { return ({ MANUAL: "手动录入", CHAT: "聊天来源", IMPORT: "资料导入" } as Record<string,string>)[sourceType] ?? sourceType; }
function sourceDetails(value: unknown) { return value ? JSON.stringify(value) : ""; }
function statusLabel(status: string) {
  return ({ PENDING: "待处理", PROCESSING: "处理中", REVIEW: "待确认", FAILED: "处理失败", ACCEPTED: "已入库", DISMISSED: "已忽略" } as Record<string,string>)[status] ?? status;
}
function recommendationLabel(value?: string) {
  return ({ CREATE: "建议新建", DUPLICATE: "疑似重复", CONFLICT: "发现冲突", DISCARD: "不建议保存" } as Record<string,string>)[value ?? ""] ?? "待判断";
}
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<template>
  <div class="page-wrap knowledge-page">
    <PageHeader eyebrow="成长系统 / 知识系统" description="收集值得学习的内容，经过整理和判断后再入库。正式知识与原始候选分开保存。">
      <template #actions>
        <NuxtLink class="settings-link" :to="`/growth/knowledge/settings?c=${characterId}`">知识助手设置 ↗</NuxtLink>
      </template>
    </PageHeader>

    <section v-if="activeCharacter" class="knowledge-context">
      <div class="knowledge-context-copy"><span>当前角色</span><strong>{{ activeCharacter.name }}</strong></div>
      <span class="knowledge-context-note">知识按角色独立积累</span>
      <span class="knowledge-count">待整理 {{ data.candidateCount }} 条</span>
      <span class="knowledge-count">正式知识 {{ data.itemCount }} 条</span>
    </section>
    <p v-else class="knowledge-empty">当前没有可用角色，请先创建角色或从左下角选择角色。</p>

    <section class="knowledge-flow" aria-label="知识处理流程">
      <article v-for="stage in [{n:'01',t:'收集',d:'从交流、资料或手动录入发现知识线索。'},{n:'02',t:'处理',d:'提炼内容，检查重复、冲突和不确定性。'},{n:'03',t:'确认入库',d:'检查处理结果，由你决定是否正式保存。'},{n:'04',t:'检索',d:'需要时按问题召回相关知识。'}]" :key="stage.n" class="knowledge-stage">
        <span class="stage-number">{{ stage.n }}</span><h2>{{ stage.t }}</h2><p>{{ stage.d }}</p>
      </article>
    </section>

    <section v-if="characterId" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">COLLECT</span><h2>添加知识候选</h2></div></div>
      <textarea v-model="rawContent" rows="4" maxlength="20000" placeholder="把她接触到、值得整理的知识放在这里。可以是一段解释、资料摘录或一个概念……" />
      <div class="section-actions"><span class="muted">{{ rawContent.length }} / 20000</span><button class="primary" :disabled="savingCandidate || !rawContent.trim()" @click="addCandidate">{{ savingCandidate ? "添加中…" : "加入候选" }}</button></div>
    </section>

    <section v-if="characterId" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">INBOX</span><h2>知识候选</h2></div><span class="muted">{{ data.candidates.length }} 条</span></div>
      <div v-if="!data.candidates.length" class="empty-state">暂时没有知识候选。你可以手动添加一条知识线索。</div>
      <article v-for="candidate in data.candidates" :key="candidate.id" class="candidate-card">
        <div class="candidate-top"><span class="status">{{ statusLabel(candidate.status) }} · {{ sourceLabel(candidate.sourceType) }}</span><span class="muted">{{ formatDate(candidate.createdAt) }}</span></div>
        <p class="candidate-raw">{{ candidate.rawContent }}</p>
        <p v-if="candidate.processingError" class="error-text">{{ candidate.processingError }}</p>
        <template v-if="candidate.processedResult">
          <div class="processing-result">
            <div class="result-top"><strong>{{ candidate.processedResult.title || "未形成标题" }}</strong><span class="recommendation">{{ recommendationLabel(candidate.processedResult.recommendation) }}</span></div>
            <p>{{ candidate.processedResult.content }}</p>
            <div class="tag-row"><span v-for="tag in candidate.processedResult.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ Math.round(candidate.processedResult.confidence * 100) }}%</span></div>
            <p class="reason">{{ candidate.processedResult.reason }}</p>
            <div v-if="candidate.processedResult.recommendation === 'DUPLICATE' || candidate.processedResult.recommendation === 'CONFLICT'" class="suggested-relations">
              <div class="relation-heading">
                <strong>{{ candidate.processedResult.recommendation === 'DUPLICATE' ? '疑似重复知识' : '可能存在冲突的知识' }}</strong>
                <span class="muted">由助手提出，需你逐条确认</span>
              </div>
              <div v-if="!candidate.processedResult.relatedItemIds.length" class="muted">助手没有找到可核验的关联知识条目。</div>
              <div v-for="target in candidate.relatedItems" :key="target.id" class="suggested-relation">
                <div class="relation-copy">
                  <strong>{{ target.title }}</strong>
                  <p>{{ target.content }}</p>
                  <span class="muted">{{ target.category }} · 修订 {{ target.revision }}</span>
                </div>
                <button
                  :class="candidate.processedResult.confirmedRelatedItemIds?.includes(target.id) ? 'primary' : ''"
                  :disabled="busyIds.includes(candidate.id)"
                  @click="toggleCandidateRelation(candidate, target)"
                >{{ candidate.processedResult.confirmedRelatedItemIds?.includes(target.id) ? '已确认 · 取消' : '确认关联' }}</button>
              </div>
              <div v-if="candidate.processedResult.relatedItemIds.length && !candidate.relatedItems.length" class="muted">建议的知识条目已不存在或不再处于正式状态，请重新处理候选。</div>
            </div>
          </div>
        </template>
        <div class="candidate-actions">
          <button v-if="candidate.status === 'PENDING' || candidate.status === 'FAILED' || candidate.status === 'REVIEW'" :disabled="busyIds.includes(candidate.id)" @click="runCandidate(candidate)">{{ busyIds.includes(candidate.id) ? "处理中…" : candidate.status === "REVIEW" ? "重新处理" : "交给助手整理" }}</button>
          <button v-if="candidate.status === 'REVIEW' && candidate.processedResult?.isKnowledge" class="primary" :disabled="busyIds.includes(candidate.id)" @click="acceptCandidate(candidate)">确认入库</button>
          <button v-if="candidate.status !== 'ACCEPTED' && candidate.status !== 'DISMISSED' && candidate.status !== 'PROCESSING'" class="quiet" @click="dismissCandidate(candidate)">忽略</button>
        </div>
      </article>
    </section>

    <section v-if="characterId" class="knowledge-section">
      <div class="section-heading"><div><span class="eyebrow">LIBRARY</span><h2>正式知识库</h2></div><span class="muted">{{ data.itemCount }} 条</span></div>
      <input v-model="keyword" class="search-input" placeholder="搜索标题、内容或标签">
      <div v-if="!data.items.length" class="empty-state">还没有正式知识。候选经过处理并由你确认后，才会出现在这里。</div>
      <article v-for="item in data.items" :key="item.id" class="item-card">
        <div class="item-heading"><h3>{{ item.title }}</h3><span class="category">{{ item.category }}</span></div>
        <p>{{ item.content }}</p>
        <div class="tag-row"><span v-for="tag in item.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ item.confidence === null ? "未标注" : Math.round(item.confidence * 100) + "%" }}</span><span class="muted">修订 {{ item.revision }}</span></div>
        <div class="item-date">来源：{{ sourceLabel(item.sourceType) }}<span v-if="sourceDetails(item.sourceRef)"> · {{ sourceDetails(item.sourceRef) }}</span><br>更新于 {{ formatDate(item.updatedAt) }}</div>
        <div v-if="item.relations.length" class="saved-relations">
          <strong>关联知识</strong>
          <div v-for="relation in item.relations" :key="relation.id" class="saved-relation">
            <div class="relation-copy">
              <span class="relation-kind">{{ relation.relationType === 'DUPLICATE' ? '重复' : relation.relationType === 'CONFLICT' ? '冲突' : '合并关系' }} · {{ relationStatusLabel(relation) }}</span>
              <strong>{{ relation.relatedItem.title }}</strong>
              <p>{{ relation.relatedItem.content }}</p>
              <span class="muted">{{ relation.relatedItem.category }} · 可信度 {{ relation.relatedItem.confidence === null ? "未标注" : Math.round(relation.relatedItem.confidence * 100) + "%" }} · {{ sourceLabel(relation.relatedItem.sourceType) }} · 修订 {{ relation.relatedItem.revision }}</span>
              <span v-if="sourceDetails(relation.relatedItem.sourceRef)" class="muted">来源：{{ sourceDetails(relation.relatedItem.sourceRef) }}</span>
              <div v-if="relation.status === 'OPEN' && relation.relationType === 'DUPLICATE'" class="relation-actions">
                <button :disabled="resolvingRelationIds.includes(relation.id) || mergingKnowledge" @click="startMerge(item, relation.relatedItem)">将当前条目合并到关联知识</button>
                <button :disabled="resolvingRelationIds.includes(relation.id) || mergingKnowledge" @click="startMerge(relation.relatedItem, item)">将关联条目合并到当前知识</button>
                <button :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'KEEP_SEPARATE')">保留为独立知识</button>
                <button class="quiet" :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'DISMISS')">忽略</button>
              </div>
              <div v-if="relation.status === 'OPEN' && relation.relationType === 'CONFLICT'" class="relation-actions">
                <button :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'CONFIRM_CONFLICT')">确认冲突并保留双方</button>
                <button :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'NEEDS_VERIFICATION')">标记待核实</button>
                <button class="quiet" :disabled="resolvingRelationIds.includes(relation.id)" @click="resolveRelation(item, relation, 'DISMISS')">忽略</button>
              </div>
            </div>
          </div>
        </div>
        <div class="item-actions">
          <button :disabled="savingItem" @click="editingItemId === item.id ? cancelEdit() : startEdit(item)">{{ editingItemId === item.id ? "取消编辑" : "编辑知识" }}</button>
          <button @click="toggleHistory(item)">{{ historyItemId === item.id ? "收起历史" : "版本历史" }}</button>
        </div>
        <div v-if="editingItemId === item.id" class="item-editor">
          <label>标题<input v-model="editDraft.title" maxlength="240"></label>
          <label>正文<textarea v-model="editDraft.content" rows="5" maxlength="12000"></textarea></label>
          <div class="editor-grid">
            <label>分类<input v-model="editDraft.category" maxlength="40"></label>
            <label>可信度（0–1，留空表示未标注）<input v-model="editDraft.confidence" type="number" min="0" max="1" step="0.01"></label>
          </div>
          <label>标签（用逗号分隔）<input v-model="editDraft.tagsText" maxlength="1000"></label>
          <p class="muted">来源类型和来源引用保持不变，确保知识仍可追溯。</p>
          <div class="item-actions"><button @click="cancelEdit()">取消</button><button class="primary" :disabled="savingItem" @click="saveEdit(item)">{{ savingItem ? "保存中…" : "保存为新版本" }}</button></div>
        </div>
        <div v-if="historyItemId === item.id" class="history-panel">
          <div class="history-heading"><strong>历史版本</strong><span class="muted">当前版本 V{{ item.revision }}</span></div>
          <p v-if="historyLoading" class="muted">正在读取历史…</p>
          <p v-else-if="!historyItems.length" class="muted">暂无旧版本；每次成功修改后都会在这里保留被替换的版本。</p>
          <article v-for="revision in historyItems" :key="revision.id" class="revision-card">
            <div class="history-heading"><strong>版本 V{{ revision.revision }}</strong><span class="muted">{{ formatDate(revision.createdAt) }}</span></div>
            <h4>{{ revision.title }}</h4>
            <p>{{ revision.content }}</p>
            <div class="tag-row"><span class="category">{{ revision.category }}</span><span v-for="tag in revision.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ revision.confidence === null ? "未标注" : Math.round(revision.confidence * 100) + "%" }}</span></div>
          </article>
        </div>
      </article>
    </section>
    <div v-if="mergeDraft" class="merge-overlay" role="dialog" aria-modal="true" aria-label="合并重复知识">
      <section class="merge-dialog">
        <div class="history-heading"><strong>确认合并重复知识</strong><button class="quiet" :disabled="mergingKnowledge" @click="cancelMerge">关闭</button></div>
        <p class="muted">源条目将标记为已合并并保留历史；目标条目会保存为新版本。请检查双方内容、来源、可信度和版本，再确认最终内容。</p>
        <div class="merge-comparison">
          <article>
            <strong>源知识 · 将标记为 MERGED · V{{ mergeDraft.expectedSourceRevision }}</strong>
            <h4>{{ mergeDraft.sourceTitle }}</h4>
            <p>{{ mergeDraft.sourceContent }}</p>
            <span>{{ mergeDraft.sourceCategory }} · 可信度 {{ mergeDraft.sourceConfidence === null ? "未标注" : Math.round(mergeDraft.sourceConfidence * 100) + "%" }} · {{ sourceLabel(mergeDraft.sourceType) }}</span>
            <span v-if="sourceDetails(mergeDraft.sourceRef)">来源：{{ sourceDetails(mergeDraft.sourceRef) }}</span>
          </article>
          <article>
            <strong>目标知识 · 将保留为 ACTIVE · V{{ mergeDraft.expectedTargetRevision }}</strong>
            <h4>{{ mergeDraft.targetTitle }}</h4>
            <p>{{ mergeDraft.targetContent }}</p>
            <span>{{ mergeDraft.targetCategory }} · 可信度 {{ mergeDraft.targetConfidence === null ? "未标注" : Math.round(mergeDraft.targetConfidence * 100) + "%" }} · {{ sourceLabel(mergeDraft.targetSourceType) }}</span>
            <span v-if="sourceDetails(mergeDraft.targetSourceRef)">来源：{{ sourceDetails(mergeDraft.targetSourceRef) }}</span>
          </article>
        </div>
        <label>合并后的标题<input v-model="mergeDraft.title" maxlength="240"></label>
        <label>合并后的正文<textarea v-model="mergeDraft.content" rows="7" maxlength="12000"></textarea></label>
        <div class="editor-grid">
          <label>分类<input v-model="mergeDraft.category" maxlength="40"></label>
          <label>可信度（0–1，留空表示未标注）<input v-model="mergeDraft.confidence" type="number" min="0" max="1" step="0.01"></label>
        </div>
        <label>标签（用逗号分隔）<input v-model="mergeDraft.tagsText" maxlength="1000"></label>
        <div class="item-actions">
          <button :disabled="mergingKnowledge" @click="cancelMerge">取消</button>
          <button class="primary" :disabled="mergingKnowledge || !mergeDraft.title.trim() || !mergeDraft.content.trim() || !mergeDraft.category.trim()" @click="submitMerge">{{ mergingKnowledge ? "合并中…" : "确认合并并保存新版本" }}</button>
        </div>
      </section>
    </div>
    <div v-if="loading" class="loading-note">正在同步知识数据…</div>
  </div>
</template>

<style scoped>
.knowledge-page{display:flex;flex-direction:column;gap:16px}
.settings-link{color:var(--accent);font-size:13px;text-decoration:none}
.knowledge-context{display:flex;align-items:center;gap:14px;flex-wrap:wrap;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:12px 16px}
.knowledge-context-copy{display:flex;flex-direction:column;gap:3px}.knowledge-context-copy span,.eyebrow,.stage-number{color:var(--dim);font-size:11px}.knowledge-context-copy strong{color:var(--ink);font-size:14px}
.knowledge-context-note{margin-left:auto;color:var(--dim);font-size:12px}.knowledge-count{font-size:12px;color:var(--dim);background:var(--surface-2);padding:5px 9px;border-radius:20px}
.knowledge-flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.knowledge-stage{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:15px;min-width:0}.knowledge-stage h2{font-size:15px;margin:7px 0;color:var(--ink)}.knowledge-stage p{font-size:12px;line-height:1.7;color:var(--dim);margin:0}
.knowledge-section{border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:18px;display:flex;flex-direction:column;gap:12px}
.section-heading,.candidate-top,.result-top,.item-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.section-heading h2{font-size:17px;margin:3px 0 0;color:var(--ink)}.muted{font-size:12px;color:var(--dim)}
textarea,.search-input{width:100%;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);color:var(--ink);padding:11px 12px;font:inherit;resize:vertical}
.section-actions{display:flex;align-items:center;justify-content:space-between}
button{border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:8px 12px;font:inherit;font-size:12px;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button.primary{background:var(--accent);color:white;border-color:var(--accent)}button.quiet{border-color:transparent;background:transparent;color:var(--dim)}
.relation-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.merge-overlay{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.52);display:flex;align-items:center;justify-content:center;padding:20px}
.merge-dialog{width:min(720px,100%);max-height:min(90vh,900px);overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 18px 60px rgba(0,0,0,.25)}
.merge-dialog label{display:flex;flex-direction:column;gap:5px;color:var(--dim);font-size:12px}
.merge-comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.merge-comparison article{min-width:0;border:1px solid var(--line);border-radius:9px;padding:11px;background:var(--surface-2);display:flex;flex-direction:column;gap:7px}
.merge-comparison strong{font-size:12px;color:var(--ink)}
.merge-comparison h4{margin:0;font-size:13px;color:var(--ink)}
.merge-comparison p{margin:0;font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
.merge-comparison span{font-size:11px;color:var(--dim);overflow-wrap:anywhere}
.merge-dialog input,.merge-dialog textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface-2);color:var(--ink);padding:9px;font:inherit;font-size:13px}
@media(max-width:600px){.merge-comparison{grid-template-columns:1fr}}
.candidate-card,.item-card{border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.candidate-raw,.item-card p,.processing-result p{margin:0;color:var(--ink);font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.status,.recommendation,.category{font-size:11px;padding:4px 8px;border-radius:20px;background:var(--surface-2);color:var(--dim)}
.processing-result{border-left:2px solid var(--accent);padding:10px 12px;background:var(--surface-2);border-radius:0 8px 8px 0;display:flex;flex-direction:column;gap:8px}
.result-top strong,.item-heading h3{color:var(--ink);font-size:14px}.reason,.error-text{font-size:12px;color:var(--dim);margin:0;line-height:1.6}.error-text{color:var(--danger,#c65b5b)}
.tag-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:3px 8px}
.candidate-actions{display:flex;justify-content:flex-end;gap:8px}.item-heading h3{margin:0}.item-card p{white-space:pre-wrap}.item-date{font-size:11px;color:var(--dim);text-align:right}
.suggested-relations,.saved-relations{display:flex;flex-direction:column;gap:9px;padding:11px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}
.relation-heading,.suggested-relation{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.relation-heading strong,.saved-relations>strong{font-size:12px;color:var(--ink)}
.suggested-relation,.saved-relation{padding-top:9px;border-top:1px solid var(--line)}.relation-copy{min-width:0;display:flex;flex:1;flex-direction:column;gap:5px}.relation-copy strong{font-size:13px;color:var(--ink)}.relation-copy p{margin:0;color:var(--dim);font-size:12px;line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}.relation-kind{font-size:11px;color:var(--dim)}
.item-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.item-editor,.history-panel{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2)}
.item-editor label{display:flex;flex-direction:column;gap:5px;color:var(--dim);font-size:12px}
.item-editor input,.item-editor textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--ink);padding:9px;font:inherit;font-size:13px}
.editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.history-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.revision-card{display:flex;flex-direction:column;gap:7px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.revision-card h4{margin:0;color:var(--ink);font-size:13px}
.revision-card p{font-size:12px;line-height:1.7;white-space:pre-wrap}

.empty-state,.loading-note,.knowledge-empty{color:var(--dim);font-size:13px;padding:10px 0}.loading-note{text-align:center}
@media(max-width:850px){.knowledge-flow{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.knowledge-flow{grid-template-columns:1fr}.knowledge-context-note{margin-left:0}.knowledge-section{padding:13px}.candidate-actions{flex-wrap:wrap}.editor-grid{grid-template-columns:1fr}}
</style>
