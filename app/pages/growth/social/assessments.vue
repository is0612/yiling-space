<script setup lang="ts">
import { Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

definePageMeta({ topbar: { title: "社交系统 · 评估历史" } });
type Filter = "ALL" | "ACTIONABLE" | "ACCEPTED" | "REJECTED" | "STALE" | "FAILED" | "RUNNING";
type Decision = "ACCEPTED" | "REJECTED" | "DEFERRED";
type Evidence = { id: string; kind: "NEW" | "CONTEXT"; occurredAt: string; title: string; detail: string; participants: string[]; confidence: number | null; eventStatus: string };
type Assessment = {
  id: string; scopeId: string; friend: { displayName: string; platform: string; platformUid: string; kind: string };
  currentRelationship: { stage: string; status: string; version: number };
  generation: number; triggerReasons: string[]; evaluatedStage: string; evaluatedStatus: string; relationshipVersion: number;
  outcome: string | null; suggestedStage: string | null; suggestedStatus: string | null; reason: string | null; observations: unknown;
  confidence: number | null; modelName: string | null; promptVersion: string | null; status: string; reviewStatus: string;
  reviewedAt: string | null; reviews: { decision: string; note: string | null; createdAt: string }[];
  error: string | null; startedAt: string; completedAt: string | null; createdAt: string; evidence: Evidence[];
  canReview: boolean; staleReason: string | null;
};
type Summary = { all: number; actionable: number; accepted: number; failed: number; running: number };
type PageResult = { items: Assessment[]; total: number; page: number; pageSize: number; totalPages: number; hasMore: boolean; summary: Summary };
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const rows = ref<Assessment[]>([]);
const loading = ref(false);
const loadError = ref("");
const pageNumber = ref(1);
const total = ref(0);
const totalPages = ref(1);
const summary = ref<Summary | null>(null);
const filter = ref<Filter>("ALL");
const expanded = ref<string[]>([]);
const reviewingIds = ref<string[]>([]);
const reviewOpen = ref(false);
const reviewTarget = ref<{ characterId: string; roleVersion: number; assessmentId: string; decision: Decision; title: string; current: string; proposed: string } | null>(null);
const reviewNote = ref("");
const reviewError = ref("");
let requestVersion = 0;
let roleVersion = 0;
let confirmationVersion = 0;
let disposed = false;
const filters: Array<{ value: Filter; label: string; count?: keyof Summary }> = [
  { value: "ALL", label: "全部", count: "all" }, { value: "ACTIONABLE", label: "待处理", count: "actionable" },
  { value: "ACCEPTED", label: "已采纳", count: "accepted" }, { value: "REJECTED", label: "已驳回" },
  { value: "STALE", label: "已过期" }, { value: "FAILED", label: "执行失败", count: "failed" }, { value: "RUNNING", label: "运行中", count: "running" },
];
const STAGES: Record<string, string> = { STRANGER: "陌生", ACQUAINTANCE: "认识", FRIEND: "朋友", CLOSE_FRIEND: "好朋友" };
const STATUSES: Record<string, string> = { NORMAL: "正常", DISTANT: "疏远", CONFLICT: "冲突", REPAIRING: "修复中", UNOBSERVED: "尚未观察" };
const OUTCOMES: Record<string, string> = { CHANGE: "建议调整关系", MAINTAIN: "维持现状", INSUFFICIENT: "证据不足", REVIEW: "需要复核" };
const REVIEWS: Record<string, string> = { NOT_REQUIRED: "无需处置", PENDING: "待确认", DEFERRED: "已暂缓", ACCEPTED: "已采纳", REJECTED: "已驳回", STALE: "建议已过期" };
const DECISIONS: Record<string, string> = { ACCEPTED: "人工采纳", REJECTED: "人工驳回", DEFERRED: "暂缓处理", STALE: "系统标记过期" };
const TRIGGERS: Record<string, string> = { NEW_EXPERIENCE: "新经历", PERIODIC_REVIEW: "定期回顾", EXISTING_EXPERIENCE_RECOVERY: "历史经历补评", LEASE_RECOVERY: "执行恢复" };
function stage(value: string | null) { return value ? STAGES[value] ?? value : "未提出"; }
function status(value: string | null) { return value ? STATUSES[value] ?? value : "未提出"; }
function relation(stageValue: string | null, statusValue: string | null) { return `${stage(stageValue)} / ${status(statusValue)}`; }
function dateTime(value: string | null) { if (!value) return "—"; const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "—"; }
function resultLabel(item: Assessment) {
  if (item.status === "FAILED") return "执行失败，未形成有效评估";
  if (item.status === "RUNNING") return "正在评估，结果尚未生成";
  return item.outcome ? OUTCOMES[item.outcome] ?? item.outcome : "本次未形成评估结论";
}
function observationNotes(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const notes = (value as { observations?: unknown }).observations;
  return Array.isArray(notes) ? notes.filter((item): item is string => typeof item === "string") : [];
}
function roleHref(path: string) { return `${path}?c=${encodeURIComponent(characterId.value)}`; }
function api(role: string) { return `/api/characters/${encodeURIComponent(role)}/growth/social/assessments`; }
function current(role: string, generation: number) { return !disposed && characterId.value === role && roleVersion === generation; }
function canAct(item: Assessment) { return item.status === "SUCCEEDED" && item.outcome === "CHANGE" && ["PENDING", "DEFERRED"].includes(item.reviewStatus); }
function staleReason(item: Assessment) {
  if (item.currentRelationship.version !== item.relationshipVersion) return "当前关系已变化，这条建议不能直接采纳，请重新评估。";
  return item.staleReason || (item.canReview === false && canAct(item) ? "来源状态或版本已变化，请重新评估后再采纳。" : "");
}
function canAccept(item: Assessment) { return canAct(item) && item.canReview === true && !staleReason(item); }
function errorText(error: unknown, fallback: string) {
  const value = error as { data?: { statusMessage?: string }; statusCode?: number; response?: { status?: number } };
  const code = value.statusCode ?? value.response?.status;
  if (code === 404) return "角色或评估记录已不存在，请刷新后重试。";
  if (code === 409) return value.data?.statusMessage || "评估状态、关系版本或来源已变化，请刷新后重新检查。";
  return value.data?.statusMessage || fallback;
}
async function load(requestedPage = pageNumber.value, corrected = false) {
  const role = characterId.value;
  const generation = roleVersion;
  const version = ++requestVersion;
  rows.value = []; summary.value = null; total.value = 0; totalPages.value = 1; expanded.value = []; loadError.value = "";
  loading.value = Boolean(role) && !disposed;
  if (!role || disposed) return;
  const isCurrent = () => current(role, generation) && requestVersion === version;
  try {
    const result = await $fetch<PageResult>(api(role), { query: { page: requestedPage, pageSize: 12, filter: filter.value } });
    if (!isCurrent()) return;
    if (!corrected && requestedPage > Math.max(1, result.totalPages)) {
      pageNumber.value = Math.max(1, result.totalPages);
      await load(pageNumber.value, true);
      return;
    }
    rows.value = result.items; summary.value = result.summary; total.value = result.total;
    pageNumber.value = result.page; totalPages.value = Math.max(1, result.totalPages);
  } catch (error) {
    if (isCurrent()) loadError.value = errorText(error, "读取评估历史失败，请重试。当前不能确认历史记录和计数。");
  } finally { if (isCurrent()) loading.value = false; }
}
function closeReview() { confirmationVersion += 1; reviewOpen.value = false; reviewTarget.value = null; reviewError.value = ""; reviewNote.value = ""; reviewingIds.value = []; }
function review(item: Assessment, decision: Decision) {
  if (!canAct(item) || reviewingIds.value.length || !rows.value.some(row => row.id === item.id) || (decision === "ACCEPTED" && !canAccept(item))) return;
  closeReview();
  reviewTarget.value = { characterId: characterId.value, roleVersion, assessmentId: item.id, decision, title: item.friend.displayName, current: relation(item.currentRelationship.stage, item.currentRelationship.status), proposed: relation(item.suggestedStage, item.suggestedStatus) };
  reviewOpen.value = true;
}
async function confirmReview() {
  const target = reviewTarget.value;
  if (!target || !reviewOpen.value || !current(target.characterId, target.roleVersion) || reviewingIds.value.length) return;
  const item = rows.value.find(row => row.id === target.assessmentId);
  if (!item || !canAct(item) || (target.decision === "ACCEPTED" && !canAccept(item))) { reviewError.value = "建议已变化，请关闭并刷新。"; return; }
  const note = reviewNote.value.trim();
  if (note.length > 500) { reviewError.value = "处理说明最多500字。"; return; }
  const version = confirmationVersion;
  const isCurrent = () => current(target.characterId, target.roleVersion) && confirmationVersion === version && reviewOpen.value && reviewTarget.value?.assessmentId === target.assessmentId;
  reviewingIds.value = [target.assessmentId]; reviewError.value = "";
  try {
    const result = await $fetch<{ applied: boolean; stale?: boolean }>(`${api(target.characterId)}/${encodeURIComponent(target.assessmentId)}/review`, { method: "POST", body: { decision: target.decision, note } });
    if (!isCurrent()) return;
    if (result.stale) ElMessage.warning("关系或来源已变化，本次没有修改关系。请查看最新历史。");
    else if (target.decision === "ACCEPTED" && result.applied) ElMessage.success("已采纳建议并更新关系。");
    else if (target.decision === "REJECTED") ElMessage.success("已驳回建议，关系保持不变。");
    else if (target.decision === "DEFERRED") ElMessage.success("已暂缓建议，之后仍可继续处理。");
    else ElMessage.info("处理结果已保存，请查看最新状态。");
    closeReview(); await load();
  } catch (error) {
    if (!isCurrent()) return;
    reviewError.value = errorText(error, "处理关系建议失败，请重试。");
    await load();
  } finally { if (isCurrent()) reviewingIds.value = []; }
}
function changeFilter(value: Filter) { if (filter.value === value) return; filter.value = value; pageNumber.value = 1; closeReview(); void load(1); }
function changePage(value: number) { closeReview(); pageNumber.value = value; void load(value); }
function toggle(id: string) { expanded.value = expanded.value.includes(id) ? expanded.value.filter(value => value !== id) : [...expanded.value, id]; }
watch(characterId, () => {
  roleVersion += 1; requestVersion += 1; closeReview(); pageNumber.value = 1; filter.value = "ALL";
  rows.value = []; summary.value = null; total.value = 0; totalPages.value = 1; expanded.value = []; loading.value = false; loadError.value = "";
  void load(1);
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { disposed = true; roleVersion += 1; requestVersion += 1; closeReview(); });
</script>

<template>
  <div class="page-wrap assessment-history">
    <nav
      class="social-nav"
      aria-label="社交系统导航"
    >
      <NuxtLink :to="roleHref('/growth/social')">
        总览
      </NuxtLink>
      <NuxtLink :to="roleHref('/growth/social/friends')">
        好友档案
      </NuxtLink>
      <NuxtLink
        :to="roleHref('/growth/social/assessments')"
        class="active"
        aria-current="page"
      >
        评估历史
      </NuxtLink>
      <NuxtLink :to="roleHref('/growth/social/assessment-settings')">
        评估设置
      </NuxtLink>
    </nav>
    <PageHeader
      description="回看每次关系评估的结果与依据，由你决定是否采纳。执行失败、建议结论和人工处置分别保留。"
    />
    <el-empty
      v-if="!characterId"
      description="请先选择一个角色，再查看社交评估历史。"
    />
    <template v-else>
      <section class="card history-overview">
        <div class="history-heading">
          <div><h2>{{ activeCharacter?.name }}的评估历史</h2><p>建议不会自动改变关系；采纳时服务端会再次核对版本与来源。</p></div><el-button
            :icon="Refresh"
            :loading="loading"
            @click="load()"
          >
            刷新
          </el-button>
        </div>
        <div
          class="history-filters"
          aria-label="筛选评估历史"
        >
          <el-button
            v-for="item in filters"
            :key="item.value"
            :type="filter === item.value ? 'primary' : 'default'"
            :plain="filter !== item.value"
            :aria-pressed="filter === item.value"
            @click="changeFilter(item.value)"
          >
            {{ item.label }}<span v-if="item.count"> · {{ summary ? summary[item.count] : '—' }}</span>
          </el-button>
        </div>
      </section>
      <el-alert
        v-if="loadError"
        type="error"
        :title="loadError"
        :closable="false"
        show-icon
      >
        <template #default>
          <el-button
            size="small"
            @click="load()"
          >
            重新读取
          </el-button>
        </template>
      </el-alert>
      <section
        v-if="loading"
        class="card loading-state"
        role="status"
      >
        <el-skeleton
          :rows="4"
          animated
        /><p>正在读取当前角色的评估历史…</p>
      </section>
      <el-empty
        v-else-if="!loadError && !rows.length"
        :description="filter === 'ALL' ? '当前角色还没有评估历史。Worker完成评估后会出现在这里。' : '当前筛选下没有评估记录，可切换筛选查看。'"
      />
      <section
        v-else-if="!loadError"
        class="assessment-list"
      >
        <article
          v-for="item in rows"
          :key="item.id"
          class="card assessment-card"
        >
          <header class="assessment-top">
            <div>
              <h2>{{ item.friend.displayName || '未命名好友' }}</h2><p class="muted">
                {{ item.friend.platform || '未知平台' }} · {{ item.friend.platformUid }}
              </p>
            </div><div class="status-stack">
              <el-tag :type="item.status === 'FAILED' ? 'danger' : item.status === 'RUNNING' ? 'warning' : 'success'">
                {{ item.status === 'FAILED' ? '执行失败' : item.status === 'RUNNING' ? '评估中' : '执行成功' }}
              </el-tag><el-tag
                v-if="item.status === 'SUCCEEDED'"
                type="info"
              >
                {{ REVIEWS[item.reviewStatus] || item.reviewStatus }}
              </el-tag>
            </div>
          </header>
          <div class="result-heading">
            <h3>{{ resultLabel(item) }}</h3><time>{{ dateTime(item.createdAt) }}</time>
          </div>
          <el-alert
            v-if="item.status === 'FAILED'"
            :title="item.error || '本次执行失败，未形成有效评估。请检查模型与后台任务，历史会保留这次失败。'"
            type="error"
            :closable="false"
            show-icon
          />
          <p
            v-else-if="item.status === 'RUNNING'"
            class="muted"
          >
            后台正在整理证据，尚无可采纳的建议。可稍后手动刷新。
          </p>
          <template v-else>
            <div class="relationship-comparison">
              <div><span>评估时关系</span><strong>{{ relation(item.evaluatedStage, item.evaluatedStatus) }}</strong></div><span
                class="comparison-arrow"
                aria-hidden="true"
              >→</span><div><span>本次建议</span><strong>{{ item.suggestedStage || item.suggestedStatus ? relation(item.suggestedStage, item.suggestedStatus) : '未提出关系调整' }}</strong></div>
            </div>
            <p
              v-if="item.reason"
              class="reason"
            >
              {{ item.reason }}
            </p>
            <el-alert
              v-if="canAct(item) && staleReason(item)"
              :title="staleReason(item)"
              type="warning"
              :closable="false"
              show-icon
            />
            <div
              v-if="canAct(item)"
              class="review-actions"
            >
              <el-button
                type="primary"
                :disabled="!canAccept(item) || reviewingIds.length > 0"
                @click="review(item, 'ACCEPTED')"
              >
                采纳并更新关系
              </el-button><el-button
                :disabled="reviewingIds.length > 0"
                @click="review(item, 'DEFERRED')"
              >
                暂缓
              </el-button><el-button
                type="danger"
                text
                :disabled="reviewingIds.length > 0"
                @click="review(item, 'REJECTED')"
              >
                驳回
              </el-button>
            </div>
          </template>
          <div class="card-footer">
            <span>{{ item.evidence.length }} 条判断依据</span><el-button
              link
              type="primary"
              @click="toggle(item.id)"
            >
              {{ expanded.includes(item.id) ? '收起依据与记录' : '查看依据与处理记录' }}
            </el-button>
          </div>
          <div
            v-if="expanded.includes(item.id)"
            class="expanded-details"
          >
            <section v-if="observationNotes(item.observations).length">
              <h4>观察要点</h4><ul>
                <li
                  v-for="(note, index) in observationNotes(item.observations)"
                  :key="index"
                >
                  {{ note }}
                </li>
              </ul>
            </section>
            <section>
              <h4>判断依据</h4><p
                v-if="!item.evidence.length"
                class="muted"
              >
                本次没有保留可展示的经历引用。
              </p><article
                v-for="evidence in item.evidence"
                :key="evidence.id"
                class="evidence-item"
              >
                <div class="evidence-heading">
                  <strong>{{ evidence.title }}</strong><el-tag
                    size="small"
                    :type="evidence.kind === 'NEW' ? 'success' : 'info'"
                  >
                    {{ evidence.kind === 'NEW' ? '本轮新经历' : '历史背景' }}
                  </el-tag>
                </div><time>{{ dateTime(evidence.occurredAt) }}</time><p>{{ evidence.detail }}</p><p
                  v-if="evidence.participants.length"
                  class="muted"
                >
                  参与者：{{ evidence.participants.join('、') }}
                </p><p
                  v-if="evidence.eventStatus !== 'ACTIVE'"
                  class="source-warning"
                >
                  来源已归档或失效，不能作为有效的新证据。
                </p>
              </article>
            </section>
            <section v-if="item.reviews.length">
              <h4>人工处理记录</h4><div
                v-for="(entry, index) in item.reviews"
                :key="index"
                class="review-history-item"
              >
                <strong>{{ DECISIONS[entry.decision] || entry.decision }}</strong><time>{{ dateTime(entry.createdAt) }}</time><p v-if="entry.note">
                  {{ entry.note }}
                </p>
              </div>
            </section>
            <details class="technical">
              <summary>评估信息</summary><p>评估时关系：{{ relation(item.evaluatedStage, item.evaluatedStatus) }} · 版本 {{ item.relationshipVersion }}</p><p>第 {{ item.generation }} 代 · {{ item.triggerReasons.map(value => TRIGGERS[value] || value).join('、') || '未注明触发原因' }}</p><p>{{ item.modelName || '未记录模型' }} · {{ item.promptVersion || '未记录提示词版本' }}</p>
            </details>
          </div>
        </article>
        <div class="pagination">
          <span>共 {{ total }} 条 · 第 {{ pageNumber }} / {{ totalPages }} 页</span><el-pagination
            :current-page="pageNumber"
            :page-size="12"
            :total="total"
            layout="prev, pager, next"
            :disabled="loading"
            @current-change="changePage"
          />
        </div>
      </section>
    </template>
    <el-dialog
      :model-value="reviewOpen"
      :title="reviewTarget?.decision === 'ACCEPTED' ? '采纳这条关系建议？' : reviewTarget?.decision === 'REJECTED' ? '驳回这条关系建议？' : '暂缓处理这条建议？'"
      width="min(580px, 94vw)"
      @update:model-value="value => { if (!value) closeReview(); }"
    >
      <template v-if="reviewTarget">
        <p><strong>{{ reviewTarget.title }}</strong></p><p v-if="reviewTarget.decision === 'ACCEPTED'">
          关系将从「{{ reviewTarget.current }}」调整为「{{ reviewTarget.proposed }}」，这会写入当前角色的关系并留下审计。
        </p><p v-else>
          本次不会修改好友关系。{{ reviewTarget.decision === 'DEFERRED' ? '暂缓后可以继续处理。' : '驳回结果会保留在历史中。' }}
        </p><el-input
          v-model="reviewNote"
          type="textarea"
          :rows="3"
          :maxlength="500"
          show-word-limit
          placeholder="可选：记录处理依据，最多500字"
        /><el-alert
          v-if="reviewError"
          :title="reviewError"
          type="error"
          :closable="false"
        />
      </template>
      <template #footer>
        <el-button @click="closeReview">
          取消
        </el-button><el-button
          type="primary"
          :loading="reviewingIds.length > 0"
          @click="confirmReview"
        >
          确认{{ reviewTarget?.decision === 'ACCEPTED' ? '采纳' : reviewTarget?.decision === 'REJECTED' ? '驳回' : '暂缓' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.assessment-history{display:flex;flex-direction:column;gap:20px}.social-nav{display:flex;gap:8px;flex-wrap:wrap}.social-nav a{padding:8px 14px;border-radius:8px;color:var(--dim);text-decoration:none;font-size:14px}.social-nav .active{background:var(--brand-soft);color:var(--brand-strong);font-weight:600}.assessment-history .card{border:0;border-radius:12px;background:var(--surface);box-shadow:none;padding:22px}.history-heading,.assessment-top,.result-heading,.card-footer,.evidence-heading,.pagination{display:flex;align-items:center;justify-content:space-between;gap:16px}.history-heading h2,.assessment-top h2{font-size:18px;margin:0}.history-heading p,.assessment-top p{margin:6px 0 0;color:var(--dim);font-size:12px}.history-filters{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}.history-filters .el-button{margin:0}.assessment-list{display:grid;gap:16px}.status-stack,.review-actions{display:flex;gap:8px;flex-wrap:wrap}.result-heading{margin:20px 0 14px}.result-heading h3{font-size:16px;margin:0}.result-heading time,.card-footer,.technical,.evidence-item time,.review-history-item time{font-size:12px;color:var(--dim)}.relationship-comparison{display:grid;grid-template-columns:1fr 24px 1fr;align-items:center;gap:14px;background:var(--surface-2);border-radius:8px;padding:16px}.relationship-comparison>div{display:grid;gap:7px}.relationship-comparison span{color:var(--dim);font-size:12px}.relationship-comparison strong{font-size:14px;font-weight:600}.comparison-arrow{text-align:center}.reason{color:var(--text-2);font-size:14px;line-height:1.85;white-space:pre-wrap}.muted{color:var(--dim);font-size:12px}.review-actions{margin-top:18px}.card-footer{padding-top:16px;margin-top:20px;border-top:1px solid var(--line)}.expanded-details{display:grid;gap:20px;margin-top:16px}.expanded-details h4{font-size:14px;margin:0 0 10px}.expanded-details ul{margin:0;padding-left:20px;font-size:14px;line-height:1.8}.evidence-item{border:0;border-radius:12px;background:var(--surface-2);box-shadow:none;padding:16px;margin-top:10px}.evidence-heading strong{font-size:14px}.evidence-item time{display:block;margin-top:6px}.evidence-item p,.review-history-item p{font-size:14px;line-height:1.8;white-space:pre-wrap;margin:9px 0 0}.source-warning{color:var(--amber);font-size:12px!important}.review-history-item{border-left:2px solid var(--line);padding:10px 14px;margin-top:8px}.review-history-item strong{font-size:12px;margin-right:12px}.technical{background:var(--surface-2);padding:12px 16px;border-radius:8px}.technical summary{cursor:pointer}.technical p{margin:8px 0}.pagination{padding:8px 0;font-size:12px;color:var(--dim)}.loading-state{padding:24px}.loading-state p{font-size:12px;color:var(--dim)}
@media(max-width:650px){.assessment-history .card{padding:16px}.history-heading,.assessment-top,.result-heading,.pagination{align-items:flex-start;flex-direction:column;gap:10px}.relationship-comparison{grid-template-columns:1fr}.comparison-arrow{transform:rotate(90deg)}.evidence-heading{align-items:flex-start;flex-wrap:wrap}.social-nav a{padding:7px 10px}.review-actions .el-button{margin:0}}
.assessment-history .review-history-item{border:0;border-radius:12px;background:var(--surface-2);box-shadow:none;padding:16px;margin-top:10px}
</style>
