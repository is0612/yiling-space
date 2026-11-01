<script setup lang="ts">
import { ArrowDown, Calendar, Files, MagicStick, Refresh, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { Character, Snapshot, SnapshotAnalysis, SnapshotSourceMessage } from "~/utils/mock-data";

const characters = useCharacterList();
await useCharacterListData();

/** 菜单页：当前角色由 ?c= 决定，选择和 /memory、/chat 共用一份 cookie */
const { id } = useCharacterSelection("/snapshots");

/** 头像 / 状态 / 归档周期都在角色列表里，不必再单独拉一次角色档案 */
const current = computed<Character | null>(
  () => characters.value.find((item) => item.id === id.value) ?? null,
);

const items = ref<Snapshot[]>([]);
const loading = ref(true);
const query = ref("");
const statusFilter = ref("全部版本状态");
const detail = ref<Snapshot | null>(null);
/** 来源消息默认收起：这是一页要读总结的页面，6 条原文常驻会把提炼结果挤到看不见 */
const sourcesOpen = ref(false);
/**
 * 来源消息分页：跨度大的总结会挂上百条原文，全量渲染会把页脚和「重新提炼」
 * 顶到很远的位置，展开一次就得滚半天。这里只渲染当前一页，编号仍走全量序号。
 */
const sourcePage = ref(1);
const sourcePageSize = ref(10);
const sourceListEl = ref<HTMLElement | null>(null);
const creating = ref(false);
const regeneratingId = ref<string | null>(null);
const aiRegeneratingId = ref<string | null>(null);

const statusOptions = ["全部版本状态", "当前版本", "已被替代"];
const filtered = computed(() => items.value.filter((item) => {
  const queryMatches = !query.value || `${item.summary} ${item.range} 第 ${item.number} 份`.toLowerCase().includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "全部版本状态" || item.status === statusFilter.value;
  return queryMatches && statusMatches;
}));
const totalMessages = computed(() => items.value.reduce((sum, item) => sum + item.messages, 0));
const hasFilters = computed(() => Boolean(query.value) || statusFilter.value !== "全部版本状态");

const sourceTotal = computed(() => detail.value?.sourceMessages?.length || 0);
const pagedSources = computed(() => {
  const start = (sourcePage.value - 1) * sourcePageSize.value;
  return (detail.value?.sourceMessages || []).slice(start, start + sourcePageSize.value);
});
/** 分页后仍按全量位置编号，「依据 #3」和列表里的 #3 才是同一条 */
const sourceRange = computed(() => {
  if (!sourceTotal.value) return "";
  const start = (sourcePage.value - 1) * sourcePageSize.value + 1;
  const end = Math.min(sourcePage.value * sourcePageSize.value, sourceTotal.value);
  return `${start}–${end}`;
});

function countFor(status: string) {
  return status === "全部版本状态" ? items.value.length : items.value.filter((item) => item.status === status).length;
}
function resetFilters() {
  query.value = "";
  statusFilter.value = "全部版本状态";
}
function statusTone(status: Snapshot["status"]) {
  return status === "当前版本" ? "pill-green" : "pill-gray";
}

/**
 * 选中一份总结。来源消息的默认开合按内容决定：
 * 有 AI 提炼结果时它是「依据」，收起；只有结构化记录时原文就是内容本身，摊开 ——
 * 否则整张详情卡只剩两行字，右边空一大片。
 */
function applyDetail(next: Snapshot | null) {
  detail.value = next;
  sourcesOpen.value = Boolean(next) && !next?.analysis;
  sourcePage.value = 1;
}

/** 换页后回到列表顶部：一页 10 条也有近千像素，停在原地会以为没翻动 */
watch(sourcePage, (next) => {
  if (next > 1) sourceListEl.value?.scrollIntoView({ block: "start", behavior: "smooth" });
});

/** 换页大小、或重新拉取后条数变少时，别停在已经不存在的页码上 */
watch([sourceTotal, sourcePageSize], () => {
  const maxPage = Math.max(1, Math.ceil(sourceTotal.value / sourcePageSize.value));
  if (sourcePage.value > maxPage) sourcePage.value = maxPage;
});

async function loadSnapshots(selectedId?: string) {
  if (!id.value) {
    items.value = [];
    detail.value = null;
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await $fetch<Snapshot[]>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`);
    items.value = result;
    applyDetail((selectedId ? result.find((item) => item.id === selectedId) : undefined) || result[0] || null);
  } catch {
    items.value = [];
    detail.value = null;
    ElMessage.error("阶段总结加载失败，请确认本地数据库已迁移。");
  } finally {
    loading.value = false;
  }
}

function selectDetail(snapshot: Snapshot) {
  applyDetail(snapshot);
}

function errorMessage(error: unknown) {
  return error && typeof error === "object" && "statusMessage" in error
    ? String(error.statusMessage)
    : "操作失败，请检查数据库连接。";
}

/**
 * 依据消息不再直接甩 8 位内部 id：按它在来源列表里的序号显示成 #2、#4，
 * 和下面的「来源消息」逐条编号对得上，人也不用去数哈希。
 */
function evidenceLabel(ids: string[]) {
  const sources = detail.value?.sourceMessages || [];
  return ids.map((sourceId) => {
    const index = sources.findIndex((source) => source.id === sourceId);
    return index >= 0 ? `#${index + 1}` : sourceId.slice(0, 8);
  }).join("、");
}
function sourceIndex(sourceId: string) {
  const sources = detail.value?.sourceMessages || [];
  const index = sources.findIndex((source) => source.id === sourceId);
  return index >= 0 ? index + 1 : null;
}
function sourceRoleLabel(source: SnapshotSourceMessage) {
  if (source.eventType !== "message") return "平台事件";
  return source.role === "USER" ? "用户" : source.role === "ASSISTANT" ? "角色" : source.role === "TOOL" ? "工具" : "系统";
}
function sourceTone(source: SnapshotSourceMessage) {
  if (source.eventType !== "message") return "pill-gray";
  return source.role === "USER" ? "pill-green" : source.role === "ASSISTANT" ? "pill-purple" : "pill-gray";
}
function sourceTime(source: SnapshotSourceMessage) {
  const date = new Date(source.occurredAt);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date)
    : source.occurredAt;
}
function showSourceMessage(source: SnapshotSourceMessage) {
  return ElMessageBox.alert(
    source.content,
    `${sourceRoleLabel(source)} · ${sourceTime(source)}`,
    { confirmButtonText: "关闭", type: "info", customClass: "source-message-dialog" },
  );
}
function memoryChangeLabel(action: string, result: string, reviewDecision?: "ACCEPTED" | "IGNORED", reviewOutcome?: string) {
  const actionLabel = action === "ADD" ? "新增" : action === "UPDATE" ? "更新" : action === "INVALIDATE" ? "标记失效" : action;
  // 处置过之后，结论就该写在标题上 —— 否则标题说「未应用」、右边说「已采纳」，自相矛盾。
  if (reviewDecision === "ACCEPTED") {
    return actionLabel + " · " + (reviewOutcome === "DUPLICATE_IGNORED" ? "已采纳（内容重复）" : "已采纳");
  }
  if (reviewDecision === "IGNORED") return actionLabel + " · 已忽略";
  const resultLabel = result === "CREATED" ? "已创建" : result === "REPLACED" ? "已替换旧记忆" : result === "INVALIDATED" ? "已失效" : result === "DUPLICATE_IGNORED" ? "忽略重复项" : result === "NOT_APPLIED_REGENERATION" ? "仅供审核（未应用）" : result;
  return actionLabel + " · " + resultLabel;
}

/**
 * 重新提炼写出的是「建议」，不会自动落库。列表页得先说一句，
 * 否则跑完之后唯一的线索只有 v2，人不会点进去翻到最后一块。
 */
function pendingReviewCount(snapshot: Snapshot) {
  const changes = snapshot.analysis?.memoryChangesApplied || [];
  return changes.filter((item) => item.result === "NOT_APPLIED_REGENERATION" && !item.reviewDecision).length;
}

type MemoryChangeRow = SnapshotAnalysis["memoryChangesApplied"][number];

/** 只有重新提炼留下、且还没人处理过的条目才给操作按钮 */
function reviewPending(item: MemoryChangeRow) {
  return item.result === "NOT_APPLIED_REGENERATION" && !item.reviewDecision;
}

function reviewResultMessage(decision: "ACCEPT" | "IGNORE", outcome: string | null) {
  if (decision === "IGNORE") return "已忽略这条建议，不会改动任何记忆。";
  if (outcome === "DUPLICATE_IGNORED") return "内容与已有记忆相同，没有重复新建。";
  if (outcome === "REPLACED") return "已采纳：原记忆标记为已被替代，新内容已写入。";
  if (outcome === "INVALIDATED") return "已采纳：目标记忆已标记失效。";
  return "已采纳，已写入长期记忆。";
}

/** 采纳会真的写库，先按变更类型说清楚会发生什么 */
function confirmAccept(item: MemoryChangeRow) {
  const detail = item.action === "ADD"
    ? "会把这条作为新的长期记忆写入，角色之后就可能提到它。"
    : item.action === "UPDATE"
      ? "会新建这条记忆，并把下面那条「当前记忆」标记为已被替代。"
      : "会把下面那条「当前记忆」标记为失效，之后不再参与检索。";
  return ElMessageBox.confirm(detail, "采纳这条建议", {
    confirmButtonText: "采纳",
    cancelButtonText: "取消",
    type: "warning",
  }).then(() => true).catch(() => false);
}

const reviewingKey = ref("");

async function reviewChange(changeIndex: number, decision: "ACCEPT" | "IGNORE", item: MemoryChangeRow) {
  if (!detail.value || reviewingKey.value) return;
  if (decision === "ACCEPT" && !(await confirmAccept(item))) return;

  const snapshotId = detail.value.id;
  const key = changeIndex + ":" + decision;
  reviewingKey.value = key;
  try {
    const result = await $fetch<{ outcome: string | null }>(
      `/api/characters/${encodeURIComponent(id.value)}/snapshots/${encodeURIComponent(snapshotId)}/review`,
      { method: "POST", body: { changeIndex, decision } },
    );
    ElMessage.success(reviewResultMessage(decision, result.outcome));
    // 刷新后保持原来选中哪一份、以及来源消息是开还是收。
    const keepSources = sourcesOpen.value;
    await loadSnapshots(snapshotId);
    sourcesOpen.value = keepSources;
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    reviewingKey.value = "";
  }
}

async function switchCharacter(nextId: string) {
  if (!nextId || nextId === id.value) return;
  items.value = [];
  detail.value = null;
}

async function createSnapshot() {
  try {
    await ElMessageBox.confirm(
      "生成一份手动归档，保存当前时间范围内的消息来源与长期记忆。手动归档不会调用模型；自动周期任务会在配置模型后执行 AI 提炼。是否继续？",
      "生成阶段总结",
      { confirmButtonText: "确认归档", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  creating.value = true;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, { method: "POST" });
    await loadSnapshots(result.id);
    ElMessage.success("手动已归档到 PostgreSQL，并关联周期内可用的消息来源。");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function regenerateWithAi(snapshot: Snapshot) {
  try {
    await ElMessageBox.confirm(
      "系统会对这份自动归档覆盖的历史周期重新调用模型，并创建同一阶段总结档案的新版本。旧版本会保留；为避免历史重放改写当前长期记忆，本次提出的长期记忆变化只展示供审核，不会自动应用。",
      "AI 重新提炼",
      { confirmButtonText: "排入重新提炼任务", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  aiRegeneratingId.value = snapshot.id;
  try {
    const result = await $fetch<{ jobId: string; status: string; duplicate: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/snapshots`,
      { method: "POST", body: { snapshotId: snapshot.id, mode: "ai" } },
    );
    ElMessage.success(
      result.duplicate
        ? "这份阶段总结已有等待中的 AI 重新提炼任务，无需重复排队。"
        : "AI 重新提炼任务已排队。请到“后台任务”运行 Worker，并查看新生成的总结版本。",
    );
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    aiRegeneratingId.value = null;
  }
}

async function regenerate(snapshot: Snapshot) {
  try {
    await ElMessageBox.confirm(
      "为第 " + snapshot.number + " 份阶段总结创建新版本？旧版本会保留，并标记为已被替代。",
      "重新生成阶段总结",
      { confirmButtonText: "创建新版本", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  regeneratingId.value = snapshot.id;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, {
      method: "POST",
      body: { snapshotId: snapshot.id },
    });
    await loadSnapshots(result.id);
    ElMessage.success("新版本已写入数据库，旧版本仍保留。");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    regeneratingId.value = null;
  }
}

onMounted(() => void loadSnapshots());
watch(id, () => void loadSnapshots());
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="工作空间 / 阶段总结"
      title="阶段总结"
      description="自动归档会调用模型提炼对话、事实与偏好；手动归档只保留当下记录。每份总结都能追溯到原始消息。"
    >
      <template #actions>
        <button
          type="button"
          class="btn primary"
          :disabled="creating || !id"
          @click="createSnapshot"
        >
          <el-icon><MagicStick /></el-icon>{{ creating ? "生成中…" : "生成阶段总结" }}
        </button>
      </template>
    </PageHeader>

    <!-- 角色切换：和角色记忆、AI 对话同一个位置、同一套控件 -->
    <CharacterBar
      path="/snapshots"
      :disabled="creating"
      empty-text="还没有角色。先创建一个角色，归档任务才有对象。"
      @change="switchCharacter"
    />

    <template v-if="characters.length">
      <!-- 一条静音统计带：原来三张 KPI 卡和正文一样重，其中两个数几乎不变 -->
      <div class="card stat-band">
        <div class="sb-cell">
          <span class="sb-k">历史归档</span>
          <span class="sb-v">{{ items.length }}<small>份</small></span>
          <span class="sb-f">历史版本都保留，不会被覆盖</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">覆盖消息</span>
          <span class="sb-v">{{ totalMessages }}<small>条</small></span>
          <span class="sb-f">来自已归档周期的原始对话</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">归档周期</span>
          <span class="sb-v">{{ current?.intervalDays ?? "—" }}<small>天</small></span>
          <span class="sb-f">下一次 {{ current?.nextSnapshot || "尚未计划" }}</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">最近生成</span>
          <span class="sb-v">{{ items[0] ? items[0].date.slice(5, 10) : "—" }}</span>
          <span class="sb-f">{{ items[0] ? items[0].date.slice(0, 4) + " 年归档" : "还没有归档过" }}</span>
        </div>
      </div>

      <div class="snap-grid">
        <section>
          <div class="sec-h">
            <h2>归档时间线</h2>
            <span class="sub">{{ filtered.length }}/{{ items.length }} 份</span>
          </div>
          <div class="card list-card">
            <div class="filters">
              <button
                v-for="option in statusOptions"
                :key="option"
                type="button"
                class="chip"
                :class="{ on: statusFilter === option }"
                @click="statusFilter = option"
              >
                {{ option === "全部版本状态" ? "全部" : option }}<span class="n">{{ countFor(option) }}</span>
              </button>
            </div>
            <div class="list-tools">
              <el-input
                v-model="query"
                clearable
                placeholder="搜索总结、时间段或编号……"
                class="list-search"
              >
                <template #prefix>
                  <el-icon><Search /></el-icon>
                </template>
              </el-input>
              <button
                v-if="hasFilters"
                type="button"
                class="reset-link"
                @click="resetFilters"
              >
                重置
              </button>
            </div>

            <div class="snap-list">
              <template v-if="loading">
                <div
                  v-for="n in 4"
                  :key="n"
                  class="sk sk-row"
                />
              </template>
              <template v-else>
                <button
                  v-for="snapshot in filtered"
                  :key="snapshot.id"
                  type="button"
                  class="snap-row"
                  :class="{ on: detail?.id === snapshot.id }"
                  @click="selectDetail(snapshot)"
                >
                  <span class="snap-row-top">
                    <span class="snap-row-title">第 {{ snapshot.number }} 份 <span class="snap-row-ver">v{{ snapshot.version }}</span></span>
                    <span class="snap-row-tags">
                      <span
                        v-if="pendingReviewCount(snapshot)"
                        class="pill pill-amber"
                      >待审核 {{ pendingReviewCount(snapshot) }}</span>
                      <span
                        class="pill"
                        :class="statusTone(snapshot.status)"
                      >{{ snapshot.status }}</span>
                    </span>
                  </span>
                  <span class="snap-row-sum">{{ snapshot.summary }}</span>
                  <span class="snap-row-meta">
                    <el-icon><Calendar /></el-icon>{{ snapshot.date.slice(5, 16) }} · {{ snapshot.messages }} 条消息 · {{ snapshot.events }} 个事件
                  </span>
                </button>
                <p
                  v-if="!filtered.length"
                  class="list-empty"
                >
                  {{ hasFilters ? "没有符合条件的阶段总结，换个词或把筛选切回全部。" : "还没有归档过。点右上角「生成阶段总结」可以手动归档当前周期。" }}
                </p>
              </template>
            </div>
          </div>
        </section>

        <section>
          <div class="sec-h">
            <h2>阶段总结详情</h2>
            <span class="sub">{{ detail ? "v" + detail.version : "未选择" }}</span>
          </div>
          <div class="card detail-card">
            <template v-if="detail">
              <header class="d-head">
                <h2>第 {{ detail.number }} 份阶段总结</h2>
                <span
                  class="pill"
                  :class="statusTone(detail.status)"
                >{{ detail.status }}</span>
              </header>
              <!-- 四个数字收成一行：原来四行「标签 …… 值」各带一条分隔线，占了 120px -->
              <p class="d-meta">
                {{ detail.range }} · 生成于 {{ detail.date }} · 覆盖 {{ detail.messages }} 条消息 · {{ detail.events }} 个事件
              </p>
              <p class="d-summary">
                {{ detail.summary }}
              </p>

              <section
                v-if="detail.analysis"
                class="d-sec"
              >
                <div class="d-sec-h">
                  <h3>AI 提炼结果</h3>
                  <span
                    v-if="detail.model?.name"
                    class="pill pill-purple"
                  >{{ detail.model.name }}</span>
                </div>

                <div
                  v-if="detail.analysis.importantEvents.length"
                  class="a-block"
                >
                  <h4>重要事件</h4>
                  <article
                    v-for="(item, index) in detail.analysis.importantEvents"
                    :key="'event-' + index"
                    class="a-item"
                  >
                    <strong>{{ item.title }}</strong>
                    <p>{{ item.detail }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.factAndPreferenceChanges.length"
                  class="a-block"
                >
                  <h4>事实与偏好变化</h4>
                  <article
                    v-for="(item, index) in detail.analysis.factAndPreferenceChanges"
                    :key="'fact-' + index"
                    class="a-item"
                  >
                    <strong>{{ item.changeType }}</strong>
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.relationshipChanges.length"
                  class="a-block"
                >
                  <h4>关系变化</h4>
                  <article
                    v-for="(item, index) in detail.analysis.relationshipChanges"
                    :key="'relation-' + index"
                    class="a-item"
                  >
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.goalsAndCommitments.length"
                  class="a-block"
                >
                  <h4>目标与承诺</h4>
                  <article
                    v-for="(item, index) in detail.analysis.goalsAndCommitments"
                    :key="'goal-' + index"
                    class="a-item"
                  >
                    <strong>{{ item.status }}</strong>
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.unresolvedTopics.length"
                  class="a-block"
                >
                  <h4>待跟进话题</h4>
                  <article
                    v-for="(item, index) in detail.analysis.unresolvedTopics"
                    :key="'topic-' + index"
                    class="a-item"
                  >
                    <p>{{ item.description }}</p>
                    <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                  </article>
                </div>

                <div
                  v-if="detail.analysis.differencesFromPrevious.length"
                  class="a-block"
                >
                  <h4>相较上一份总结</h4>
                  <ul class="a-list">
                    <li
                      v-for="(item, index) in detail.analysis.differencesFromPrevious"
                      :key="'diff-' + index"
                    >
                      {{ item }}
                    </li>
                  </ul>
                </div>

                <div
                  v-if="detail.analysis.memoryChangesApplied.length"
                  class="a-block"
                >
                  <h4>
                    长期记忆变化与审核建议
                    <span
                      v-if="detail.reviewRejected"
                      class="a-rejected"
                    >另 {{ detail.reviewRejected }} 条未通过来源校验</span>
                  </h4>
                  <article
                    v-for="(item, index) in detail.analysis.memoryChangesApplied"
                    :key="'change-' + index"
                    class="a-item"
                  >
                    <strong>{{ memoryChangeLabel(item.action, item.result, item.reviewDecision, item.reviewOutcome) }}</strong>
                    <p>{{ item.content || '关联记忆 ' + (item.memoryItemId || item.supersededMemoryId || '—') }}</p>
                    <!-- 没有这一行，「更新」等于没有对照组：看得见要改成什么，看不见现在是什么 -->
                    <div
                      v-if="item.supersededContent"
                      class="a-prev"
                    >
                      <span>当前记忆</span>{{ item.supersededContent }}
                    </div>
                    <div
                      v-if="item.evidenceMessageIds?.length || reviewPending(item)"
                      class="a-foot"
                    >
                      <small v-if="item.evidenceMessageIds?.length">依据 {{ evidenceLabel(item.evidenceMessageIds) }}</small>
                      <span
                        v-if="reviewPending(item)"
                        class="a-actions"
                      >
                        <el-button
                          size="small"
                          :loading="reviewingKey === index + ':ACCEPT'"
                          @click="reviewChange(index, 'ACCEPT', item)"
                        >
                          采纳
                        </el-button>
                        <el-button
                          size="small"
                          text
                          :loading="reviewingKey === index + ':IGNORE'"
                          @click="reviewChange(index, 'IGNORE', item)"
                        >
                          忽略
                        </el-button>
                      </span>
                    </div>
                  </article>
                </div>
              </section>
              <p
                v-else
                class="d-note"
              >
                <el-icon><Files /></el-icon>
                这是一份手动或旧版总结，保存的是结构化记录；自动归档的 AI 提炼结果会显示在这里。
              </p>

              <section class="d-sec">
                <button
                  type="button"
                  class="src-toggle"
                  :aria-expanded="sourcesOpen"
                  @click="sourcesOpen = !sourcesOpen"
                >
                  <el-icon
                    class="src-caret"
                    :class="{ open: sourcesOpen }"
                  >
                    <ArrowDown />
                  </el-icon>
                  来源消息与原文
                  <span class="src-count">
                    {{ detail.sourceMessages?.length || 0 }} 条<template v-if="sourceTotal > sourcePageSize"> · 第 {{ sourceRange }} 条</template>
                  </span>
                </button>

                <div
                  v-if="sourcesOpen && detail.sourceMessages?.length"
                  ref="sourceListEl"
                  class="src-list"
                >
                  <article
                    v-for="source in pagedSources"
                    :key="source.id"
                    class="src-item"
                  >
                    <div class="src-top">
                      <span class="src-no">#{{ sourceIndex(source.id) }}</span>
                      <span
                        class="pill"
                        :class="sourceTone(source)"
                      >{{ sourceRoleLabel(source) }}</span>
                      <span class="src-time">{{ sourceTime(source) }}</span>
                      <button
                        type="button"
                        class="src-more"
                        @click="showSourceMessage(source)"
                      >
                        查看原文
                      </button>
                    </div>
                    <p class="src-conv">
                      {{ source.conversationTitle || "未命名会话" }}
                    </p>
                    <p class="src-preview">
                      {{ source.content }}
                    </p>
                  </article>
                </div>
                <div
                  v-if="sourcesOpen && sourceTotal > sourcePageSize"
                  class="src-pager"
                >
                  <el-pagination
                    v-model:current-page="sourcePage"
                    v-model:page-size="sourcePageSize"
                    :total="sourceTotal"
                    :page-sizes="[10, 20, 50]"
                    :pager-count="5"
                    layout="sizes, prev, pager, next"
                    size="small"
                    background
                  />
                </div>
                <!--
                  这里必须独立 v-if，不能 v-else-if：分页器插在上面之后，
                  v-else-if 会挂到分页器的条件上 —— 来源不足一页（≤10 条，最常见的情况）
                  时原文照常渲染，下面却多出一句「没有可追溯的原始消息」。
                -->
                <p
                  v-if="sourcesOpen && !sourceTotal"
                  class="list-empty"
                >
                  没有可追溯的原始消息，可能是旧版本、纯记忆归档，或来源消息已被清理。
                </p>
              </section>

              <footer class="d-foot">
                <p
                  v-if="detail.kind === 'AUTOMATIC'"
                  class="d-foot-note"
                >
                  重新提炼会为同一周期创建新版本，旧版本保留；记忆变化仅供审核，不会自动覆盖。
                </p>
                <button
                  v-if="detail.kind === 'AUTOMATIC'"
                  type="button"
                  class="btn sm d-action"
                  :disabled="aiRegeneratingId === detail.id || regeneratingId === detail.id"
                  @click="regenerateWithAi(detail)"
                >
                  <el-icon><Refresh /></el-icon>{{ aiRegeneratingId === detail.id ? "重新提炼中…" : "AI 重新提炼" }}
                </button>
                <button
                  v-else
                  type="button"
                  class="btn sm d-action"
                  :disabled="regeneratingId === detail.id || aiRegeneratingId === detail.id"
                  @click="regenerate(detail)"
                >
                  <el-icon><Refresh /></el-icon>{{ regeneratingId === detail.id ? "重新生成中…" : "重新生成此版本" }}
                </button>
              </footer>
            </template>

            <template v-else-if="loading">
              <div
                v-for="n in 4"
                :key="n"
                class="sk"
                :style="{ height: n === 1 ? '22px' : '56px', width: n === 1 ? '42%' : '100%', marginBottom: '10px' }"
              />
            </template>
            <p
              v-else
              class="list-empty"
            >
              从左侧点一份阶段总结，这里会展开摘要、AI 提炼结果与来源原文。
            </p>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览 / 角色记忆 / AI 对话的 A 套：白砖、零描边、零阴影，
   层次靠明度差 + 间距，颜色只给状态。
   ══════════════════════════════════════════════════════════════ */
.card{border:0;border-radius:10px;box-shadow:none}

/* ── 主次两栏：列表窄、详情宽（详情要读长文本） ───────── */
.snap-grid{display:grid;grid-template-columns:minmax(272px,344px) minmax(0,1fr);gap:16px;align-items:start}

/* ── 左：归档时间线 ─────────────────────────────────── */
.list-card{padding:12px 10px 8px}
.list-tools{display:flex;align-items:center;gap:8px;padding:0 4px}
.list-search{min-width:0;flex:1}
.reset-link{border:0;border-radius:6px;background:none;padding:2px 4px;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.reset-link:hover{text-decoration:underline}
/* 左栏列表自己滚，别让几十份归档把右栏详情推到视口外 */
.snap-list{display:flex;max-height:calc(100dvh - 300px);flex-direction:column;gap:2px;margin-top:8px;overflow:auto}
.snap-row{display:flex;width:100%;flex-direction:column;gap:5px;border:0;border-radius:8px;background:none;padding:10px 10px 11px;text-align:left;cursor:pointer;transition:background .14s var(--ease)}
.snap-row:hover{background:var(--surface-2)}
.snap-row.on{background:var(--brand-soft);box-shadow:inset 2px 0 0 var(--brand)}
.snap-row-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.snap-row-tags{display:flex;align-items:center;gap:6px;flex:none}
.snap-row-title{color:var(--text);font-size:14px;font-weight:600;line-height:1.45}
.snap-row.on .snap-row-title{color:var(--brand-strong)}
.snap-row-ver{color:var(--dim);font-weight:500}
.snap-row-sum{display:-webkit-box;overflow:hidden;color:var(--dim);font-size:12px;line-height:1.7;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.snap-row-meta{display:flex;align-items:center;gap:4px;color:var(--dim);font-size:12px;line-height:1.5}
.snap-row-meta .el-icon{font-size:12px}
.sk-row{height:74px;border-radius:8px}
.list-empty{margin:0;padding:22px 12px;color:var(--dim);font-size:12px;line-height:1.8;text-align:center}

/* ── 右：详情 ──────────────────────────────────────── */
.detail-card{padding:18px 20px 16px}
.d-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.d-head h2{margin:0;color:var(--text);font-size:18px;font-weight:700;line-height:1.4}
.d-meta{margin:6px 0 0;color:var(--dim);font-size:12px;line-height:1.7}
/* 摘要是这页要读的东西：15px / 1.9，字号只比标题小一档 */
.d-summary{margin:12px 0 0;color:var(--text);font-size:16px;line-height:1.9;white-space:pre-wrap;overflow-wrap:anywhere}

.d-sec{margin-top:20px;border-top:1px solid var(--surface-3);padding-top:16px}
.d-sec-h{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.d-sec-h h3{margin:0;color:var(--text-2);font-size:14px;font-weight:700}
.d-note{display:flex;align-items:flex-start;gap:7px;margin:16px 0 0;border-radius:8px;background:var(--surface-2);padding:11px 13px;color:var(--dim);font-size:12px;line-height:1.8}
.d-note .el-icon{margin-top:2px;flex:none;color:var(--faint)}

/* AI 提炼结果：一块一块的软底，不再每条都画 1px 边框 */
.a-block + .a-block{margin-top:16px}
/* 小标题用 --text-2 而不是 --dim：12px 的 dim 太像正文边角料，7 个分组就糊成一片 */
.a-block h4{margin:0 0 8px;color:var(--text-2);font-size:12px;font-weight:700;letter-spacing:.03em}
.a-item{border-radius:8px;background:var(--surface-2);padding:10px 12px}
.a-item + .a-item{margin-top:6px}
.a-item strong{display:block;color:var(--text-2);font-size:14px;font-weight:600;line-height:1.55}
.a-item p{margin:4px 0 0;color:var(--dim);font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.a-item strong + p{margin-top:4px}
.a-item small{display:block;margin-top:6px;color:var(--dim);font-size:12px}
/* 审核建议的对照组：只说「要改成什么」而不说「现在是什么」，更新类建议没法判断 */
.a-prev{display:flex;align-items:baseline;gap:8px;margin-top:8px;border-left:2px solid var(--line-strong);padding-left:9px;color:var(--dim);font-size:12px;line-height:1.75;white-space:pre-wrap;overflow-wrap:anywhere}
.a-prev span{flex:none;color:var(--text-2);font-weight:600}
.a-rejected{margin-left:8px;color:#8f5c05;font-weight:500}
/* 依据留左边，处置结果和「采纳 / 忽略」靠右：一条建议的结论比它的出处更该被先看到 */
.a-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}
.a-foot small{margin-top:0}
.a-actions{margin-left:auto;flex:none;display:flex;align-items:center;gap:6px}
.a-actions .el-button + .el-button{margin-left:0}
.a-list{margin:0;padding-left:18px;color:var(--dim);font-size:14px;line-height:1.9}

/* ── 来源消息（默认收起） ──────────────────────────── */
.src-toggle{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:6px;background:none;padding:2px 0;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.src-toggle:hover{text-decoration:underline}
.src-caret{font-size:12px;transition:transform .16s var(--ease)}
.src-caret.open{transform:rotate(180deg)}
.src-count{color:var(--dim);font-weight:400}
.src-list{display:flex;flex-direction:column;gap:8px;margin-top:12px}
.src-item{border-radius:8px;background:var(--surface-2);padding:11px 12px}
.src-top{display:flex;align-items:center;gap:7px}
.src-no{flex:none;color:var(--dim);font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.src-top .pill{flex:none;padding:3px 7px}
.src-time{flex:none;color:var(--dim);font-size:12px}
/* 「查看原文」跟在时间后面靠右，不再独占一行 */
.src-more{margin-left:auto;flex:none;border:0;border-radius:6px;background:none;padding:2px 0;color:var(--brand-strong);font-size:12px;font-weight:600;cursor:pointer}
.src-more:hover{text-decoration:underline}
.src-conv{margin:6px 0 0;overflow:hidden;color:var(--dim);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.src-preview{display:-webkit-box;overflow:hidden;margin:5px 0 0;color:var(--text-2);font-size:14px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:3}
/* 分页器贴右、极轻：它是翻页工具，不该和原文抢视线 */
.src-pager{display:flex;justify-content:flex-end;margin-top:10px}

/* ── 详情页脚 ──────────────────────────────────────── */
.d-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;border-top:1px solid var(--surface-3);padding-top:14px}
.d-foot-note{min-width:0;margin:0;color:var(--dim);font-size:12px;line-height:1.7}
.d-action{flex:none}
.d-action .el-icon{margin-right:2px}

/* ── 响应式 ────────────────────────────────────────── */
@media(max-width:1150px){
  .snap-grid{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:640px){
  .stat-band{padding:14px}
  .sb-f{white-space:normal}
  .detail-card{padding:16px 14px 14px}
  .d-foot{flex-direction:column;align-items:stretch}
  .d-action{width:100%}
}
</style>
