<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

definePageMeta({ topbar: { title: "关系评估历史" } });

type Evidence = {
  id: string;
  kind: "NEW" | "CONTEXT";
  occurredAt: string;
  title: string;
  detail: string;
  participants: string[];
  confidence: number | null;
  eventStatus: string;
};
type Assessment = {
  id: string;
  scopeId: string;
  friend: { displayName: string; platform: string; platformUid: string; kind: string };
  currentRelationship: { stage: string; status: string; version: number };
  generation: number;
  triggerReasons: string[];
  evaluatedStage: string;
  evaluatedStatus: string;
  relationshipVersion: number;
  outcome: string | null;
  suggestedStage: string | null;
  suggestedStatus: string | null;
  reason: string | null;
  observations: unknown;
  confidence: number | null;
  modelName: string | null;
  promptVersion: string | null;
  status: string;
  reviewStatus: string;
  reviewedAt: string | null;
  reviews: { decision: string; note: string | null; createdAt: string }[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  evidence: Evidence[];
};
type PageResult = { items: Assessment[]; total: number; page: number; pageSize: number; totalPages: number; hasMore: boolean };

const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const rows = ref<Assessment[]>([]);
const loading = ref(false);
const pageNumber = ref(1);
const total = ref(0);
const totalPages = ref(1);
const expanded = ref<string[]>([]);
const reviewingIds = ref<string[]>([]);
let requestVersion = 0;
let roleVersion = 0;
let disposed = false;

const STAGE_LABELS: Record<string, string> = {
  STRANGER: "陌生", ACQUAINTANCE: "认识", FRIEND: "朋友", CLOSE_FRIEND: "好朋友",
};
const STATUS_LABELS: Record<string, string> = {
  NORMAL: "正常", DISTANT: "疏远", CONFLICT: "冲突", REPAIRING: "修复中", UNOBSERVED: "尚未观察",
};
const OUTCOME_LABELS: Record<string, string> = {
  CHANGE: "建议调整", MAINTAIN: "维持现状", INSUFFICIENT: "证据不足", REVIEW: "需要复核",
};
const REVIEW_STATUS_LABELS: Record<string, string> = {
  NOT_REQUIRED: "无需处置", PENDING: "待人工确认", DEFERRED: "已暂缓",
  ACCEPTED: "已采纳", REJECTED: "已驳回", STALE: "建议已过期",
};
const REVIEW_DECISION_LABELS: Record<string, string> = {
  ACCEPTED: "人工采纳", REJECTED: "人工驳回", DEFERRED: "暂缓处理", STALE: "系统标记过期",
};
const TRIGGER_LABELS: Record<string, string> = {
  NEW_EXPERIENCE: "新经历", PERIODIC_REVIEW: "定期回顾", EXISTING_EXPERIENCE_RECOVERY: "历史经历补评",
};

function dateTime(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
function stage(value: string | null) { return value ? STAGE_LABELS[value] ?? value : "未提出"; }
function status(value: string | null) { return value ? STATUS_LABELS[value] ?? value : "未提出"; }
function outcome(value: string | null) { return value ? OUTCOME_LABELS[value] ?? value : "无结论"; }
function observations(value: unknown): { observations?: string[]; needsMoreEvidence?: boolean; cautionFlags?: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as { observations?: string[]; needsMoreEvidence?: boolean; cautionFlags?: string[] };
}
function isCurrent(target: string, expectedRoleVersion: number, version: number) {
  return !disposed && characterId.value === target && roleVersion === expectedRoleVersion && requestVersion === version;
}
async function load(target = characterId.value, requestedPage = pageNumber.value) {
  if (!target || disposed) { rows.value = []; total.value = 0; totalPages.value = 1; return; }
  const version = ++requestVersion;
  const expectedRoleVersion = roleVersion;
  loading.value = true;
  try {
    const result = await $fetch<PageResult>(`/api/characters/${encodeURIComponent(target)}/growth/social/assessments`, {
      query: { page: requestedPage, pageSize: 12 },
    });
    if (!isCurrent(target, expectedRoleVersion, version)) return;
    rows.value = result.items;
    total.value = result.total;
    pageNumber.value = result.page;
    totalPages.value = result.totalPages;
    expanded.value = expanded.value.filter(id => result.items.some(item => item.id === id));
  } catch (error) {
    if (!isCurrent(target, expectedRoleVersion, version)) return;
    const e = error as { data?: { statusMessage?: string }; message?: string };
    ElMessage.error(e.data?.statusMessage || e.message || "读取关系评估历史失败。");
  } finally {
    if (isCurrent(target, expectedRoleVersion, version)) loading.value = false;
  }
}
function toggle(id: string) {
  expanded.value = expanded.value.includes(id) ? expanded.value.filter(value => value !== id) : [...expanded.value, id];
}

async function review(item: Assessment, decision: "ACCEPTED" | "REJECTED" | "DEFERRED") {
  if (reviewingIds.value.includes(item.id)) return;
  const title = decision === "ACCEPTED" ? "采纳这条关系建议？" : decision === "REJECTED" ? "驳回这条关系建议？" : "暂缓处理这条建议？";
  const message = decision === "ACCEPTED"
    ? `关系将从「${stage(item.currentRelationship.stage)} / ${status(item.currentRelationship.status)}」调整为「${stage(item.suggestedStage)} / ${status(item.suggestedStatus)}」。这会立即写入关系并留下变更记录。`
    : decision === "REJECTED"
      ? "驳回后不会修改好友关系，这条建议会保留在历史中。"
      : "暂缓后不会修改好友关系，你可以之后再回来处理。";
  try {
    await ElMessageBox.confirm(message, title, { type: decision === "ACCEPTED" ? "warning" : "info", confirmButtonText: title.replace("？", ""), cancelButtonText: "取消" });
  } catch { return; }
  reviewingIds.value = [...reviewingIds.value, item.id];
  try {
    const result = await $fetch<{ applied: boolean; stale?: boolean }>(
      `/api/characters/${encodeURIComponent(characterId.value)}/growth/social/assessments/${encodeURIComponent(item.id)}/review`,
      { method: "POST", body: { decision } },
    );
    if (result.stale) ElMessage.warning("关系已经变化，这条建议已过期，没有修改关系。");
    else if (decision === "ACCEPTED" && result.applied) ElMessage.success("已采纳建议并更新关系。");
    else if (decision === "REJECTED") ElMessage.success("已驳回建议，关系保持不变。");
    else ElMessage.success("已暂缓建议，之后仍可继续处理。");
    await load();
  } catch (error) {
    const e = error as { data?: { statusMessage?: string }; message?: string };
    ElMessage.error(e.data?.statusMessage || e.message || "处理关系建议失败。");
    await load();
  } finally {
    reviewingIds.value = reviewingIds.value.filter(id => id !== item.id);
  }
}
watch(characterId, target => {
  roleVersion += 1;
  requestVersion += 1;
  pageNumber.value = 1;
  rows.value = [];
  expanded.value = [];
  if (target) void load(target, 1);
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { disposed = true; roleVersion += 1; requestVersion += 1; });
</script>

<template>
  <div class="page-wrap assessment-history">
    <PageHeader eyebrow="成长系统 / 社交关系系统" description="查看每次关系评估的结论、判断理由，以及 AI 实际引用的社交经历。这里只展示建议，不会自动改变关系。" />
    <div class="history-toolbar">
      <NuxtLink to="/growth/social">← 返回社交关系系统</NuxtLink>
      <div class="toolbar-actions">
        <span>共 {{ total }} 次评估</span>
        <el-button :icon="Refresh" :loading="loading" @click="load()">刷新</el-button>
      </div>
    </div>

    <section v-if="!characterId" class="empty-state">请先在侧栏选择一个角色。</section>
    <section v-else-if="loading && !rows.length" class="empty-state">正在读取评估历史…</section>
    <section v-else-if="!rows.length" class="empty-state">
      <strong>还没有关系评估记录</strong>
      <p>当本地 Worker 完成一次关系评估后，记录会出现在这里。</p>
      <NuxtLink to="/growth/social/assessment-settings">检查关系评估 AI 设置</NuxtLink>
    </section>
    <section v-else class="assessment-list">
      <article v-for="item in rows" :key="item.id" class="assessment-card">
        <div class="assessment-top">
          <div class="friend-heading">
            <strong>{{ item.friend.displayName }}</strong>
            <span>{{ item.friend.platform || "未知平台" }} · {{ item.friend.platformUid }}</span>
          </div>
          <span class="outcome-pill" :class="'outcome-' + (item.outcome || item.status).toLowerCase()">{{ outcome(item.outcome) }}</span>
        </div>
        <div class="meta-line">
          <span>{{ dateTime(item.createdAt) }}</span>
          <span>第 {{ item.generation }} 代</span>
          <span>{{ item.triggerReasons.map(reason => TRIGGER_LABELS[reason] || reason).join("、") || "未注明触发原因" }}</span>
        </div>
        <div class="relationship-grid">
          <div><small>评估时阶段</small><strong>{{ stage(item.evaluatedStage) }}</strong></div>
          <div><small>评估时状态</small><strong>{{ status(item.evaluatedStatus) }}</strong></div>
          <div><small>建议阶段</small><strong>{{ stage(item.suggestedStage) }}</strong></div>
          <div><small>建议状态</small><strong>{{ status(item.suggestedStatus) }}</strong></div>
        </div>
        <p v-if="item.reason" class="reason">{{ item.reason }}</p>
        <p v-if="item.error" class="error-text">执行失败：{{ item.error }}</p>
        <div class="review-row">
          <span class="review-status" :class="'review-' + item.reviewStatus.toLowerCase()">{{ REVIEW_STATUS_LABELS[item.reviewStatus] || item.reviewStatus }}</span>
          <div v-if="item.status === 'SUCCEEDED' && item.outcome === 'CHANGE' && ['PENDING', 'DEFERRED'].includes(item.reviewStatus)" class="review-actions">
            <el-button size="small" type="primary" :loading="reviewingIds.includes(item.id)" :disabled="reviewingIds.includes(item.id)" @click="review(item, 'ACCEPTED')">采纳并更新关系</el-button>
            <el-button size="small" :disabled="reviewingIds.includes(item.id)" @click="review(item, 'DEFERRED')">暂缓</el-button>
            <el-button size="small" text type="danger" :disabled="reviewingIds.includes(item.id)" @click="review(item, 'REJECTED')">驳回</el-button>
          </div>
        </div>
        <div v-if="item.reviews.length" class="review-history">
          <strong>人工处理记录</strong>
          <div v-for="(entry, index) in item.reviews" :key="index" class="review-history-item">
            <span>{{ REVIEW_DECISION_LABELS[entry.decision] || entry.decision }} · {{ dateTime(entry.createdAt) }}</span>
            <p v-if="entry.note">{{ entry.note }}</p>
          </div>
        </div>
        <div v-if="observations(item.observations).observations?.length" class="observations">
          <strong>观察要点</strong>
          <ul><li v-for="(note, index) in observations(item.observations).observations" :key="index">{{ note }}</li></ul>
        </div>
        <div class="card-footer">
          <span>{{ item.evidence.length }} 条引用经历 · {{ item.modelName || "未记录模型" }}</span>
          <button type="button" @click="toggle(item.id)">{{ expanded.includes(item.id) ? "收起证据" : "查看判断证据" }}</button>
        </div>
        <div v-if="expanded.includes(item.id)" class="evidence-list">
          <div v-if="!item.evidence.length" class="no-evidence">本次没有可用经历引用。</div>
          <article v-for="evidence in item.evidence" :key="evidence.id" class="evidence-item">
            <div class="evidence-heading">
              <strong>{{ evidence.title }}</strong>
              <span :class="evidence.kind === 'NEW' ? 'evidence-new' : 'evidence-context'">{{ evidence.kind === "NEW" ? "NEW · 本轮新经历" : "CONTEXT · 背景经历" }}</span>
            </div>
            <time>{{ dateTime(evidence.occurredAt) }}</time>
            <p>{{ evidence.detail }}</p>
            <small v-if="evidence.participants.length">参与者：{{ evidence.participants.join("、") }}</small>
            <small v-if="evidence.eventStatus !== 'ACTIVE'">该忆泡当前状态：{{ evidence.eventStatus }}</small>
          </article>
        </div>
      </article>
    </section>

    <div v-if="totalPages > 1" class="pagination">
      <el-button :disabled="pageNumber <= 1 || loading" @click="load(characterId, pageNumber - 1)">上一页</el-button>
      <span>第 {{ pageNumber }} / {{ totalPages }} 页</span>
      <el-button :disabled="pageNumber >= totalPages || loading" @click="load(characterId, pageNumber + 1)">下一页</el-button>
    </div>
  </div>
</template>

<style scoped>
.assessment-history{display:flex;flex-direction:column;gap:14px}
.history-toolbar,.toolbar-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}
.history-toolbar>a{color:var(--accent);font-size:13px;text-decoration:none}
.toolbar-actions{color:var(--dim);font-size:12px}
.empty-state{padding:34px 20px;border:1px dashed var(--line);border-radius:var(--radius);color:var(--dim);text-align:center;background:var(--surface)}
.empty-state strong{display:block;color:var(--ink);font-size:15px}
.empty-state p{font-size:13px}
.empty-state a{color:var(--accent);font-size:13px}
.assessment-list{display:grid;gap:12px}
.assessment-card{min-width:0;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface);padding:18px}
.assessment-top,.friend-heading,.meta-line,.relationship-grid,.card-footer,.evidence-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}
.friend-heading{justify-content:flex-start;flex-wrap:wrap}
.friend-heading strong{color:var(--ink);font-size:15px}
.friend-heading span,.meta-line,.card-footer,.evidence-item time,.evidence-item small{color:var(--dim);font-size:11px}
.outcome-pill{border-radius:99px;background:var(--surface-2);padding:5px 10px;color:var(--ink);font-size:11px;white-space:nowrap}
.outcome-change{color:var(--accent)}.outcome-failed{color:var(--danger,#dc2626)}
.meta-line{justify-content:flex-start;flex-wrap:wrap;margin-top:8px}
.relationship-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:16px}
.relationship-grid>div{display:grid;gap:5px;padding:10px;border-radius:8px;background:var(--surface-2)}
.relationship-grid small{color:var(--dim);font-size:10px}
.relationship-grid strong{color:var(--ink);font-size:13px}
.review-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px}
.review-status{font-size:11px;color:var(--dim)}
.review-pending{color:var(--warning,#b7791f)}.review-deferred{color:var(--dim)}.review-accepted{color:var(--success,#0d9488)}.review-rejected,.review-stale{color:var(--dim)}
.review-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.review-history{display:grid;gap:6px;margin-top:10px;padding:10px;border-radius:8px;background:var(--surface-2);font-size:11px;color:var(--dim)}
.review-history-item p{margin:3px 0 0;color:var(--text-2,var(--ink));white-space:pre-wrap}
.reason{margin:14px 0 0;color:var(--text-2,var(--ink));font-size:13px;line-height:1.8;white-space:pre-wrap}
.error-text{color:var(--danger,#dc2626);font-size:12px}
.observations{margin-top:12px;color:var(--text-2,var(--ink));font-size:12px}
.observations ul{margin:6px 0 0;padding-left:18px;line-height:1.8}
.card-footer{margin-top:14px;padding-top:12px;border-top:1px solid var(--line)}
.card-footer button{border:0;background:transparent;color:var(--accent);font:inherit;cursor:pointer}
.evidence-list{display:grid;gap:8px;margin-top:12px}
.evidence-item{padding:12px;border:1px solid var(--line);border-radius:8px}
.evidence-heading{align-items:flex-start;flex-wrap:wrap}
.evidence-heading strong{color:var(--ink);font-size:12px}
.evidence-heading span{font-size:10px}
.evidence-new{color:var(--success,#0d9488)}.evidence-context{color:var(--dim)}
.evidence-item time{display:block;margin-top:5px}
.evidence-item p{margin:8px 0;color:var(--text-2,var(--ink));font-size:12px;line-height:1.8;white-space:pre-wrap}
.evidence-item small{display:block;margin-top:5px}
.no-evidence{padding:12px;color:var(--dim);font-size:12px}
.pagination{display:flex;align-items:center;justify-content:center;gap:14px;color:var(--dim);font-size:12px}
@media(max-width:650px){.assessment-card{padding:13px}.relationship-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.assessment-top{align-items:flex-start}.history-toolbar{align-items:flex-start}.friend-heading{display:grid;gap:4px}}
</style>
