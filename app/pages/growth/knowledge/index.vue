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
};
type Candidate = {
  id: string; sourceType: string; sourceRef: unknown; rawContent: string; status: string;
  processedResult: KnowledgeResult | null; processingError: string | null; processedAt: string | null; createdAt: string;
};
type KnowledgeItem = {
  id: string; title: string; content: string; category: string; tags: string[]; confidence: number | null;
  status: string; sourceType: string; sourceRef: unknown; revision: number; createdAt: string; updatedAt: string;
};
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

async function load() {
  if (!characterId.value) { data.value = { candidates: [], items: [], candidateCount: 0, itemCount: 0 }; return; }
  loading.value = true;
  try {
    data.value = await $fetch<WorkspaceData>(`/api/characters/${encodeURIComponent(characterId.value)}/growth/knowledge`, {
      query: keyword.value.trim() ? { q: keyword.value.trim() } : {},
    });
  } catch (error) {
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "读取知识系统失败。");
  } finally { loading.value = false; }
}
watch(characterId, () => { void load(); }, { immediate: true });
watch(keyword, () => { void load(); });

async function addCandidate() {
  if (!characterId.value || savingCandidate.value || !rawContent.value.trim()) return;
  savingCandidate.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(characterId.value)}/growth/knowledge/candidates`, {
      method: "POST", body: { rawContent: rawContent.value.trim(), sourceType: "MANUAL" },
    });
    rawContent.value = "";
    ElMessage.success("已加入知识候选。");
    await load();
  } catch (error) {
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "添加候选失败。");
  } finally { savingCandidate.value = false; }
}

async function runCandidate(candidate: Candidate) {
  if (busyIds.value.includes(candidate.id)) return;
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(`/api/characters/${encodeURIComponent(characterId.value)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/process`, { method: "POST" });
    ElMessage.success("知识处理完成，请检查结果后决定是否入库。");
    await load();
  } catch (error) {
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "知识处理失败。");
    await load();
  } finally { busyIds.value = busyIds.value.filter(id => id !== candidate.id); }
}

async function acceptCandidate(candidate: Candidate) {
  if (busyIds.value.includes(candidate.id)) return;
  busyIds.value = [...busyIds.value, candidate.id];
  try {
    await $fetch(`/api/characters/${encodeURIComponent(characterId.value)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/accept`, { method: "POST" });
    ElMessage.success("已正式加入知识库。");
    await load();
  } catch (error) {
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "入库失败。");
  } finally { busyIds.value = busyIds.value.filter(id => id !== candidate.id); }
}

async function dismissCandidate(candidate: Candidate) {
  try {
    await $fetch(`/api/characters/${encodeURIComponent(characterId.value)}/growth/knowledge/candidates/${encodeURIComponent(candidate.id)}/dismiss`, { method: "POST" });
    ElMessage.success("已忽略这条候选。");
    await load();
  } catch (error) {
    const e = error as { data?: { statusMessage?: string } };
    ElMessage.error(e.data?.statusMessage || "操作失败。");
  }
}
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
        <div class="candidate-top"><span class="status">{{ statusLabel(candidate.status) }}</span><span class="muted">{{ formatDate(candidate.createdAt) }}</span></div>
        <p class="candidate-raw">{{ candidate.rawContent }}</p>
        <p v-if="candidate.processingError" class="error-text">{{ candidate.processingError }}</p>
        <template v-if="candidate.processedResult">
          <div class="processing-result">
            <div class="result-top"><strong>{{ candidate.processedResult.title || "未形成标题" }}</strong><span class="recommendation">{{ recommendationLabel(candidate.processedResult.recommendation) }}</span></div>
            <p>{{ candidate.processedResult.content }}</p>
            <div class="tag-row"><span v-for="tag in candidate.processedResult.tags" :key="tag" class="tag">{{ tag }}</span><span class="muted">可信度 {{ Math.round(candidate.processedResult.confidence * 100) }}%</span></div>
            <p class="reason">{{ candidate.processedResult.reason }}</p>
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
        <div class="item-date">更新于 {{ formatDate(item.updatedAt) }}</div>
      </article>
    </section>
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
.candidate-card,.item-card{border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.candidate-raw,.item-card p,.processing-result p{margin:0;color:var(--ink);font-size:13px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.status,.recommendation,.category{font-size:11px;padding:4px 8px;border-radius:20px;background:var(--surface-2);color:var(--dim)}
.processing-result{border-left:2px solid var(--accent);padding:10px 12px;background:var(--surface-2);border-radius:0 8px 8px 0;display:flex;flex-direction:column;gap:8px}
.result-top strong,.item-heading h3{color:var(--ink);font-size:14px}.reason,.error-text{font-size:12px;color:var(--dim);margin:0;line-height:1.6}.error-text{color:var(--danger,#c65b5b)}
.tag-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:20px;padding:3px 8px}
.candidate-actions{display:flex;justify-content:flex-end;gap:8px}.item-heading h3{margin:0}.item-card p{white-space:pre-wrap}.item-date{font-size:11px;color:var(--dim);text-align:right}
.empty-state,.loading-note,.knowledge-empty{color:var(--dim);font-size:13px;padding:10px 0}.loading-note{text-align:center}
@media(max-width:850px){.knowledge-flow{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){.knowledge-flow{grid-template-columns:1fr}.knowledge-context-note{margin-left:0}.knowledge-section{padding:13px}.candidate-actions{flex-wrap:wrap}}
</style>
