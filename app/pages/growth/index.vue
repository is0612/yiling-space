<script setup lang="ts">
definePageMeta({ topbar: { title: "成长总览" } });
type Conclusion = { id: string; title: string; observation: string; inference: string; recommendation: string; acceptedAt: string; sourceRefs: unknown[] };
type Overview = {
  character: { id: string; name: string }; period: { days: number; start: string; end: string }; generatedAt: string;
  stats: { memories: number; knowledge: number; relationships: number; conclusions: number };
  pending: { reflections: number; knowledge: number; relationships: number };
  conclusions: Conclusion[];
  timeline: { id: string; type: "reflection" | "knowledge" | "relationship" | "snapshot"; title: string; at: string; description: string; href: string }[];
  delivery: { failed: number; stuck: number; ready: number };
};
const route = useRoute();
const { character: activeCharacter } = useCharacterSelection(route.path);
const characterId = computed(() => activeCharacter.value?.id ?? "");
const days = ref<7 | 14 | 30>(7);
const overview = ref<Overview | null>(null);
const loading = ref(false);
const loadError = ref("");
const sourceOpen = ref(false);
const selectedConclusion = ref<Conclusion | null>(null);
let roleGeneration = 0;
let requestVersion = 0;
let disposed = false;
const pendingTotal = computed(() => overview.value ? Object.values(overview.value.pending).reduce((sum, value) => sum + value, 0) : null);
const stats = [
  { key: "memories", label: "记录下的经历", unit: "条忆泡", note: "本期有效的公开经历" },
  { key: "knowledge", label: "确认入库的知识", unit: "条知识", note: "本期新增且仍有效" },
  { key: "relationships", label: "已采纳的关系变化", unit: "次变化", note: "每次变化都有依据" },
  { key: "conclusions", label: "保存的成长结论", unit: "条结论", note: "保留你的审阅记录" },
] as const;
const typeLabels = { reflection: "反思", knowledge: "知识", relationship: "社交", snapshot: "记忆" };
const domains = [
  { title: "记忆", description: "经历、长期记忆与阶段总结", icon: "▤", href: "/growth/memory" },
  { title: "社交", description: "好友、重要经历与关系评估", icon: "♧", href: "/growth/social" },
  { title: "知识", description: "候选整理、知识库与来源", icon: "◇", href: "/growth/knowledge" },
  { title: "偏好", description: "她自己的喜恶、兴趣与形成依据", icon: "♡", href: "/growth/preferences" },
];
function roleHref(path: string) {
  const allowed = ["/growth/reflection", "/growth/knowledge", "/growth/social/assessments", "/growth/memory", "/growth/social", "/growth/memory/snapshots", "/growth/deliveries", "/growth/preferences"];
  const base = path.split(/[?#]/)[0] ?? "";
  const safe = allowed.includes(base) ? base : "/growth/reflection";
  return `${safe}?c=${encodeURIComponent(characterId.value)}`;
}
function closeSources() { sourceOpen.value = false; selectedConclusion.value = null; }
function openSources(item: Conclusion) {
  if (!overview.value?.conclusions.some(row => row.id === item.id)) return;
  selectedConclusion.value = item;
  sourceOpen.value = true;
}
function sourceRows(value: unknown[]) {
  return value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return [{ key: typeof row.key === "string" ? row.key : String(index), title: typeof row.title === "string" ? row.title : "来源引用", excerpt: typeof row.excerpt === "string" ? row.excerpt : "该来源未保存展示摘录，请到反思记录核对引用。" }];
  });
}
function formatDate(value: string | null | undefined, short = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", short ? { month: "2-digit", day: "2-digit" } : { dateStyle: "medium", timeStyle: "short" }).format(date);
}
async function loadOverview() {
  const target = characterId.value;
  const generation = roleGeneration;
  const version = ++requestVersion;
  overview.value = null;
  closeSources();
  loadError.value = "";
  loading.value = Boolean(target);
  if (!target || disposed) return;
  const current = () => !disposed && roleGeneration === generation && requestVersion === version && characterId.value === target;
  try {
    const result = await $fetch<Overview>(`/api/characters/${encodeURIComponent(target)}/growth/overview`, { query: { days: days.value } });
    if (!current()) return;
    if (result.character.id !== target) throw new Error("角色数据不匹配");
    overview.value = result;
  } catch {
    if (!current()) return;
    overview.value = null;
    loadError.value = "读取成长总览失败，请重试；当前没有可确认的统计结果。";
  } finally {
    if (current()) loading.value = false;
  }
}
function changeRange(value: 7 | 14 | 30) {
  if (days.value === value) return;
  days.value = value;
  void loadOverview();
}
watch(characterId, () => {
  roleGeneration += 1;
  requestVersion += 1;
  overview.value = null;
  closeSources();
  void loadOverview();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; roleGeneration += 1; requestVersion += 1; closeSources(); });
</script>

<template>
  <div class="page-wrap growth-overview">
    <header class="overview-heading">
      <div>
        <div class="overview-eyebrow">
          GROWTH JOURNAL
        </div><h1>一点一点，成为她自己。</h1><p>回看{{ activeCharacter?.name ?? '当前角色' }}的近期积累，看看哪些变化值得留下。</p>
      </div>
      <div
        class="overview-range"
        aria-label="查看时间范围"
      >
        <el-button
          v-for="range in ([7, 14, 30] as const)"
          :key="range"
          :type="days === range ? 'primary' : 'default'"
          :plain="days !== range"
          :aria-pressed="days === range"
          @click="changeRange(range)"
        >
          近 {{ range }} 天
        </el-button>
      </div>
    </header>
    <el-empty
      v-if="!activeCharacter"
      description="请先选择一个角色，再回看成长记录。"
    />
    <template v-else>
      <el-alert
        v-if="loadError"
        :title="loadError"
        type="error"
        :closable="false"
        show-icon
        class="overview-error"
      >
        <template #default>
          <el-button
            size="small"
            @click="loadOverview"
          >
            重新读取
          </el-button>
        </template>
      </el-alert>
      <div
        v-if="loading"
        class="overview-loading"
        role="status"
      >
        <el-skeleton
          :rows="6"
          animated
        /><p>正在读取当前角色的成长记录…</p>
      </div>
      <template v-if="overview">
        <section class="overview-hero">
          <div class="overview-hero-copy">
            <div class="overview-meta">
              <span class="overview-pill pink">本期回顾</span><span>{{ formatDate(overview.period.start, true) }} — {{ formatDate(overview.period.end, true) }}</span>
            </div><h2>这段时间，留下了 {{ overview.stats.conclusions }} 条你确认的成长结论。</h2><p>它们来自具体经历与反思，经你审阅后保存。先看见变化，再决定下一步。</p><div class="overview-hero-foot">
              <NuxtLink :to="roleHref('/growth/reflection')">
                回看成长结论 ↗
              </NuxtLink><span>结论已保存 · 尚不自动影响聊天行为</span>
            </div>
          </div>
          <div
            class="overview-art"
            aria-hidden="true"
          >
            <svg
              viewBox="0 0 260 190"
              fill="none"
            ><circle
              cx="135"
              cy="95"
              r="70"
              stroke="#ecd9e1"
            /><circle
              cx="135"
              cy="95"
              r="48"
              stroke="#ecd9e1"
              stroke-dasharray="3 6"
            /><path
              d="M57 149C98 146 102 115 131 110C164 103 162 69 197 54"
              stroke="#c77291"
              stroke-width="2"
            /><circle
              cx="57"
              cy="149"
              r="5"
              fill="#ead1dc"
            /><circle
              cx="98"
              cy="131"
              r="5"
              fill="#dca7bc"
            /><circle
              cx="137"
              cy="107"
              r="6"
              fill="#cb7597"
            /><circle
              cx="172"
              cy="77"
              r="6"
              fill="#bc4d78"
            /><circle
              cx="198"
              cy="53"
              r="8"
              fill="#c9416b"
            /><path
              d="M198 25v11M198 70v9M172 53h10M215 53h10"
              stroke="#cf8ba5"
            /></svg><span>每一次积累，都有来处。</span>
          </div>
        </section>
        <section
          class="overview-stats"
          aria-label="本期积累"
        >
          <div
            v-for="stat in stats"
            :key="stat.key"
            class="overview-stat"
          >
            <div>{{ stat.label }}</div><strong>{{ overview.stats[stat.key] }}<small>{{ stat.unit }}</small></strong><p>{{ stat.note }}</p>
          </div>
        </section>
        <div class="overview-columns">
          <section class="overview-card overview-conclusions">
            <div class="overview-section-head">
              <h2>最近留下的成长</h2><NuxtLink :to="roleHref('/growth/reflection')">
                全部结论 →
              </NuxtLink>
            </div><p class="overview-caption">
              已接受的反思结论，尚不自动改写她的人设。
            </p><el-empty
              v-if="!overview.conclusions.length"
              description="还没有本期确认的成长结论。先积累经历，再回望一次。"
              :image-size="72"
            /><article
              v-for="item in overview.conclusions"
              :key="item.id"
              class="overview-conclusion"
            >
              <span
                class="overview-quote"
                aria-hidden="true"
              >“</span><div class="overview-meta">
                <span class="overview-pill">已接受</span><time>{{ formatDate(item.acceptedAt) }}</time><span>阶段反思</span>
              </div><h3>{{ item.title }}</h3><p>{{ item.observation }}</p><div class="overview-sources">
                <span>依据：{{ item.sourceRefs.length }} 条来源引用</span><el-button
                  link
                  type="primary"
                  @click="openSources(item)"
                >
                  查看依据 ↗
                </el-button>
              </div>
            </article>
          </section>
          <section class="overview-card overview-todo">
            <div class="overview-section-head">
              <h2>等你一起决定 <span class="overview-count">{{ pendingTotal }}</span></h2>
            </div><el-empty
              v-if="pendingTotal === 0"
              description="暂时没有需要你确认的事项。"
              :image-size="64"
            /><template v-else>
              <article
                v-if="overview.pending.reflections > 0"
                class="overview-pending"
              >
                <div class="overview-meta">
                  <span>反思建议</span><span>{{ overview.pending.reflections }} 条待审阅</span>
                </div><h3>这次反思，哪些值得留下？</h3><p>区分事实、推断与建议，再决定接受、暂缓或驳回。</p><NuxtLink :to="roleHref('/growth/reflection')">
                  <el-button
                    size="small"
                    type="primary"
                  >
                    审阅反思建议 →
                  </el-button>
                </NuxtLink>
              </article><article
                v-if="overview.pending.knowledge > 0"
                class="overview-pending"
              >
                <div class="overview-meta">
                  <span>知识候选</span><span>{{ overview.pending.knowledge }} 条待处理</span>
                </div><h3>有几段内容，可能值得学会。</h3><p>候选还不是正式知识，需要先整理，再确认入库。</p><NuxtLink :to="roleHref('/growth/knowledge')">
                  <el-button
                    size="small"
                    plain
                  >
                    查看知识候选 →
                  </el-button>
                </NuxtLink>
              </article><article
                v-if="overview.pending.relationships > 0"
                class="overview-pending"
              >
                <div class="overview-meta">
                  <span>关系评估</span><span>{{ overview.pending.relationships }} 条待确认</span>
                </div><h3>一段关系，有了新的变化建议。</h3><p>先查看依据，再决定是否采纳关系变化。</p><NuxtLink :to="roleHref('/growth/social/assessments')">
                  <el-button
                    size="small"
                    plain
                  >
                    查看关系评估 →
                  </el-button>
                </NuxtLink>
              </article>
            </template>
          </section>
          <section class="overview-card overview-timeline">
            <div class="overview-section-head">
              <h2>成长足迹</h2><el-button
                link
                type="primary"
                @click="loadOverview"
              >
                刷新记录
              </el-button>
            </div><el-empty
              v-if="!overview.timeline.length"
              description="近期还没有可展示的足迹，记录一段经历就有了回望的起点。"
              :image-size="64"
            /><ol v-else>
              <li
                v-for="entry in overview.timeline"
                :key="entry.id"
              >
                <time>{{ formatDate(entry.at, true) }}</time><span class="overview-pin" /><div>
                  <NuxtLink :to="roleHref(entry.href)">
                    <span class="overview-type">{{ typeLabels[entry.type] }}</span>{{ entry.title }}
                  </NuxtLink><p>{{ entry.description }}</p>
                </div>
              </li>
            </ol>
          </section>
          <section class="overview-insight">
            <h3>给最近的经历，一点回望的时间。</h3><p>主动发起一次反思，看看哪些做法值得保留。没有充分依据时，也可以没有建议。</p><NuxtLink :to="roleHref('/growth/reflection')">
              <el-button plain>
                发起阶段反思 ↗
              </el-button>
            </NuxtLink>
          </section>
        </div>
        <section class="overview-domains">
          <div class="overview-section-head">
            <h2>继续照看她的积累</h2><span>各领域各自保存，来源彼此相连</span>
          </div><div class="overview-domain-grid">
            <NuxtLink
              v-for="domain in domains"
              :key="domain.href"
              :to="roleHref(domain.href)"
              class="overview-domain"
            >
              <span class="overview-domain-icon">{{ domain.icon }}</span><div><strong>{{ domain.title }}</strong><small>{{ domain.description }}</small></div><span class="overview-arrow">↗</span>
            </NuxtLink>
          </div><p class="overview-future">
            后续逐步接入：状态 · 表达习惯 · 目标与愿望　<span>当前不展示虚构进度</span>
          </p>
        </section>
        <footer class="overview-footer">
          <span :class="{ 'overview-warning': overview.delivery.failed > 0 || overview.delivery.stuck > 0 }"><template v-if="overview.delivery.failed || overview.delivery.stuck">投递需关注：{{ overview.delivery.failed }} 条失败 · {{ overview.delivery.stuck }} 条过期租约</template><template v-else>投递当前未记录失败或过期租约</template> · {{ overview.delivery.ready }} 条已到执行时间 <NuxtLink :to="roleHref('/growth/deliveries')">查看投递记录</NuxtLink></span><span>统计截至 {{ formatDate(overview.generatedAt) }} · 无综合成长分数</span>
        </footer>
      </template>
    </template>
    <el-dialog
      :model-value="sourceOpen"
      title="每一条结论，都能回到具体来源"
      width="min(620px, 94vw)"
      @update:model-value="value => { if (!value) closeSources(); }"
    >
      <template v-if="selectedConclusion">
        <h3>{{ selectedConclusion.title }}</h3><p class="overview-source-notice">
          以下为生成时保存的来源摘要。接受的结论不等于推断已成为确定事实。
        </p><article
          v-for="source in sourceRows(selectedConclusion.sourceRefs)"
          :key="source.key"
          class="overview-evidence"
        >
          <strong>{{ source.title }}</strong><p>{{ source.excerpt }}</p>
        </article><el-empty
          v-if="!sourceRows(selectedConclusion.sourceRefs).length"
          description="没有可展示的来源摘要，请到反思记录核对。"
          :image-size="60"
        />
      </template><template #footer>
        <el-button @click="closeSources">
          关闭
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.growth-overview{max-width:1360px;margin:auto}.overview-heading{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:24px}.overview-eyebrow{font-size:12px;letter-spacing:.1em;color:var(--brand-strong);font-weight:600}.overview-heading h1{font-size:26px;font-weight:650;line-height:1.4;margin:8px 0}.overview-heading p{margin:0;color:var(--dim);font-size:14px}.overview-range{display:flex;gap:4px;flex:none}.overview-range .el-button+.el-button{margin-left:0}.overview-error{margin-bottom:24px}.overview-loading{background:var(--surface);padding:32px;border-radius:10px;color:var(--dim)}.overview-loading p{font-size:14px}.overview-hero{display:grid;grid-template-columns:minmax(0,1fr) 250px;background:var(--surface);border-radius:10px;overflow:hidden;margin-bottom:24px}.overview-hero-copy{padding:28px 32px;position:relative}.overview-hero-copy:before{content:"";position:absolute;left:0;top:28px;bottom:28px;width:3px;background:var(--brand)}.overview-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;color:var(--dim);font-size:12px}.overview-pill{display:inline-block;border-radius:999px;padding:3px 9px;background:var(--green-soft);color:var(--green);font-size:12px}.overview-pill.pink{background:var(--brand-soft);color:var(--brand-strong)}.overview-hero h2{font-size:22px;font-weight:600;line-height:1.55;margin:12px 0 8px}.overview-hero p{font-size:14px;color:var(--dim);margin:0;max-width:650px}.overview-hero-foot{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;margin-top:18px}.overview-hero-foot span{color:var(--dim)}.overview-art{display:flex;align-items:center;justify-content:center;flex-direction:column;background:#fbf4f6;padding:16px}.overview-art svg{width:220px;max-width:100%;height:180px}.overview-art span{font-size:12px;color:#806675}.overview-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:26px}.overview-stat{border-right:1px solid var(--line-strong);padding:0 24px}.overview-stat:first-child{padding-left:0}.overview-stat:last-child{border:0}.overview-stat>div,.overview-stat p{font-size:12px;color:var(--dim)}.overview-stat strong{display:block;font-size:26px;line-height:1.4;font-weight:600;margin-top:6px}.overview-stat small{font-size:12px;font-weight:400;color:var(--dim);margin-left:7px}.overview-stat p{margin:5px 0 0}.overview-columns{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(290px,1fr);gap:24px;align-items:start}.overview-card{background:var(--surface);border-radius:10px;padding:24px;min-width:0}.overview-conclusions{grid-column:1;grid-row:1}.overview-todo{grid-column:2;grid-row:1 / span 2}.overview-timeline{grid-column:1;grid-row:2 / span 2}.overview-insight{grid-column:2;grid-row:3}.overview-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px}.overview-section-head h2{font-size:16px;font-weight:650;margin:0}.overview-section-head a,.overview-section-head>span{font-size:12px}.overview-caption{font-size:12px;color:var(--dim);margin:-10px 0 20px}.overview-conclusion{border:1px solid var(--line);border-radius:8px;padding:20px;margin-top:12px;position:relative}.overview-conclusion h3{font-size:16px;font-weight:600;margin:12px 18px 8px 0}.overview-conclusion p{font-size:14px;color:var(--text-2);margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.overview-quote{position:absolute;right:16px;top:18px;font-family:Georgia,serif;font-size:40px;color:#e7c5d2;line-height:1}.overview-sources{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;font-size:12px;color:var(--dim)}.overview-count{display:inline-block;padding:2px 7px;border-radius:6px;background:var(--brand-soft);color:var(--brand-strong);font-size:12px;margin-left:6px}.overview-pending{border-bottom:1px solid var(--line);padding:18px 0}.overview-pending:last-child{border-bottom:0;padding-bottom:0}.overview-pending:first-of-type{padding-top:0}.overview-pending .overview-meta{justify-content:space-between}.overview-pending h3{font-size:14px;margin:8px 0 5px;font-weight:600}.overview-pending p{font-size:12px;color:var(--dim);margin:0 0 12px}.overview-timeline ol{list-style:none;margin:0;padding:0}.overview-timeline li{display:grid;grid-template-columns:48px 14px minmax(0,1fr);gap:10px;position:relative;padding-bottom:24px}.overview-timeline li:last-child{padding-bottom:0}.overview-timeline li:not(:last-child):after{content:"";position:absolute;left:61px;top:18px;bottom:0;width:1px;background:var(--line)}.overview-timeline time{font-size:12px;color:var(--dim);padding-top:1px}.overview-pin{width:8px;height:8px;margin-top:7px;border-radius:50%;background:#d6dce5;outline:1px solid #d6dce5;border:2px solid var(--surface);z-index:1}.overview-timeline li:first-child .overview-pin{background:var(--brand);outline-color:#edccd8}.overview-timeline a{font-size:14px;color:var(--text-2);overflow-wrap:anywhere}.overview-timeline p{font-size:12px;color:var(--dim);margin:5px 0 0}.overview-type{font-size:12px;padding:2px 6px;border-radius:4px;color:#526478;background:#f0f3f7;margin-right:7px;white-space:nowrap}.overview-insight{padding:22px 24px;background:#edf3f1;border-radius:10px}.overview-insight h3{font-size:14px;margin:0 0 8px}.overview-insight p{font-size:12px;color:#4d655a;margin:0 0 16px}.overview-insight .el-button{font-size:12px;background:transparent;color:#365d48;border-color:#b7cbc0}.overview-domains{margin-top:28px}.overview-domain-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.overview-domain{display:flex;gap:12px;align-items:center;padding:18px 20px;background:var(--surface);border-radius:8px;color:var(--text)}.overview-domain:hover{background:var(--surface-2)}.overview-domain-icon{width:34px;height:34px;flex:none;border-radius:8px;background:#f5f2f5;color:#a85b78;display:grid;place-items:center;font-size:18px}.overview-domain strong{font-size:14px;font-weight:600}.overview-domain small{display:block;font-size:12px;color:var(--dim)}.overview-arrow{margin-left:auto;color:var(--dim)}.overview-future{font-size:12px;color:var(--dim);margin:16px 0 0}.overview-future span{white-space:nowrap}.overview-footer{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-top:1px solid var(--line-strong);margin-top:28px;padding-top:16px;font-size:12px;color:var(--dim)}.overview-footer a{margin-left:8px}.overview-warning{color:var(--red-text)}.overview-source-notice{font-size:14px;color:var(--dim)}.overview-evidence{background:var(--surface-2);padding:16px;border-radius:8px;margin-top:12px}.overview-evidence strong{font-size:14px}.overview-evidence p{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0}
@media(max-width:1100px){.overview-hero{grid-template-columns:minmax(0,1fr) 190px}.overview-columns{gap:16px;grid-template-columns:minmax(0,1.3fr) minmax(270px,1fr)}.overview-card{padding:20px}.overview-stat{padding:0 16px}.overview-domain-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:820px){.overview-columns{grid-template-columns:1fr}.overview-columns>*{grid-column:1;grid-row:auto}.overview-todo{grid-row:1}.overview-conclusions{grid-row:2}.overview-heading{align-items:flex-start;flex-wrap:wrap}.overview-hero{grid-template-columns:minmax(0,1fr) 150px}.overview-hero-copy{padding:24px}.overview-art svg{height:150px}}
@media(max-width:540px){.overview-heading h1{font-size:26px}.overview-heading p{font-size:12px}.overview-hero{grid-template-columns:1fr}.overview-art{display:none}.overview-hero h2{font-size:18px}.overview-hero p{font-size:12px}.overview-stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 0}.overview-stat:nth-child(odd){padding-left:0}.overview-stat:nth-child(2){border:0}.overview-stat strong{font-size:22px}.overview-stat p{display:none}.overview-card{padding:20px 16px}.overview-conclusion{padding:16px}.overview-conclusion h3{font-size:14px}.overview-conclusion p{font-size:12px}.overview-domain-grid{grid-template-columns:1fr}.overview-section-head>span{display:none}.overview-footer{flex-direction:column}.overview-sources{align-items:flex-start;flex-wrap:wrap}}
</style>
