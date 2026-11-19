<script setup lang="ts">
import type { SelfUnderstandingView } from "../../../server/utils/self-understanding";

definePageMeta({ topbar: { title: "自我认知", crumbs: [{ label: "成长系统" }] } });

type Evidence = SelfUnderstandingView["evidence"][number];
type HistoryRow = NonNullable<SelfUnderstandingView["history"]>[number];
type Report = { characterId: string; view: SelfUnderstandingView };
type Domain = Evidence["domain"];
type Status = Evidence["status"];

const route = useRoute();
const { character } = useCharacterSelection(route.path);
const characterId = computed(() => character.value?.id ?? "");
const request = useApiRequest();
const report = ref<Report | null>(null);
const error = ref("");
const loading = ref(false);
let sequence = 0;

const domainLabels: Record<Domain, string> = {
  memory: "记忆", experience: "互动经验", preferences: "偏好", language: "表达习惯",
  goals: "目标与愿望", social: "关系", reflection: "反思", knowledge: "知识",
};
const statusLabels: Record<Status, string> = {
  active_record: "有效记录", confirmed_record: "已确认记录",
  accepted_interpretation: "已采纳解释", scoped_experience: "会话经验",
};
const sourcePaths: Record<Domain, string> = {
  memory: "/growth/memory/long-term", experience: "/growth/memory/interaction-experiences",
  preferences: "/growth/preferences", language: "/growth/language", goals: "/growth/goals",
  social: "/growth/social/assessments", reflection: "/growth/reflection", knowledge: "/growth/knowledge",
};
const statusFilters: Array<{ value: Status | "ALL"; label: string }> = [
  { value: "ALL", label: "全部" },
  { value: "confirmed_record", label: "已确认记录" },
  { value: "scoped_experience", label: "会话经验" },
  { value: "accepted_interpretation", label: "已采纳解释" },
];

const domainOrder: Domain[] = ["memory", "experience", "preferences", "language", "goals", "social", "reflection", "knowledge"];
const domainFilter = ref<Domain | "ALL">("ALL");
const statusFilter = ref<Status | "ALL">("ALL");
const visibleCount = ref(5);

const view = computed(() => (report.value?.characterId === characterId.value ? report.value?.view ?? null : null));
const evidence = computed(() => view.value?.evidence ?? []);
const reflections = computed(() => evidence.value.filter(row => row.domain === "reflection"));
const quote = computed(() => reflections.value[0] ?? null);
const historyRows = computed<HistoryRow[]>(() => [...(view.value?.history ?? [])]
  .sort((a, b) => (b.current.recordedAt ?? "").localeCompare(a.current.recordedAt ?? "")));
const counts = computed(() => {
  const base: Record<string, number> = { memory: 0, experience: 0, preferences: 0, language: 0, goals: 0, social: 0, reflection: 0, knowledge: 0 };
  for (const row of evidence.value) base[row.domain] = (base[row.domain] ?? 0) + 1;
  return base;
});
const filtered = computed(() => evidence.value.filter(row =>
  (domainFilter.value === "ALL" || row.domain === domainFilter.value)
  && (statusFilter.value === "ALL" || row.status === statusFilter.value)));
const shown = computed(() => filtered.value.slice(0, visibleCount.value));
const remaining = computed(() => Math.max(0, filtered.value.length - visibleCount.value));
const latestUpdate = computed(() => {
  const stamps = evidence.value.map(row => row.updatedAt).filter(value => Number.isFinite(Date.parse(value)));
  if (!stamps.length) return "";
  return stamps.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
});
const avatarLetter = computed(() => (view.value?.identity.name ?? "忆").trim().slice(0, 1) || "忆");
const appearance = computed(() => {
  const value = view.value?.presentation.avatar ?? "";
  if (value === "configured_image") return "已设置图片";
  return value.trim() ? "文字头像" : "未设置";
});
const appearanceHint = computed(() => {
  const value = view.value?.presentation.avatar ?? "";
  if (value === "configured_image") return "已设置外观图片";
  return value.trim() || "未设置外观";
});

function countFor(value: Status | "ALL") {
  return value === "ALL" ? evidence.value.length : evidence.value.filter(row => row.status === value).length;
}
function pickDomain(value: Domain) {
  if (!counts.value[value]) return;
  domainFilter.value = domainFilter.value === value ? "ALL" : value;
}
function pickStatus(value: Status | "ALL") {
  statusFilter.value = value;
}
watch([domainFilter, statusFilter], () => { visibleCount.value = 5; });

const shortFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" });
function shortText(value?: string) {
  const date = new Date(value ?? "");
  return Number.isFinite(date.getTime()) ? shortFormat.format(date).replace("/", "-") : "未记录";
}
const labels: Record<string, string> = {
  STRANGER: "陌生", ACQUAINTANCE: "认识", FRIEND: "朋友", CLOSE_FRIEND: "亲密朋友",
  UNOBSERVED: "尚未观察", NORMAL: "正常相处", DISTANT: "疏远", CONFLICT: "有冲突", REPAIRING: "修复中",
  LIKE: "喜欢", DISLIKE: "不喜欢", INTEREST: "感兴趣",
};
function readableExcerpt(value: string) {
  return value.replace(/^[A-Z_]+(?=:)/u, word => labels[word] ?? word)
    .replace(/(?:^|: |, )([A-Z_]+)(?=, |$)/gu, (match, word: string) => match.slice(0, -word.length) + (labels[word] ?? word));
}
function roleLink(path: string) { return { path, query: { c: characterId.value } }; }
function sourceLink(row: Evidence) {
  return roleLink(row.domain === "memory" && row.occurredAt ? "/growth/memory/events" : sourcePaths[row.domain]);
}
function historySubject(row: HistoryRow) {
  if (row.domain !== "social") return domainLabels[row.domain];
  const name = evidence.value.find(item => item.domain === row.domain && item.id === row.id)?.excerpt.split(":")[0];
  return name ? `${domainLabels[row.domain]} · ${name}` : domainLabels[row.domain];
}

async function load() {
  const target = characterId.value;
  const token = ++sequence;
  report.value = null;
  error.value = "";
  loading.value = Boolean(target);
  if (!target) return;
  const current = () => token === sequence && target === characterId.value;
  try {
    const result = await request<Report>({ url: `/characters/${encodeURIComponent(target)}/growth/self-understanding`, method: "get" });
    if (!current()) return;
    if (result.characterId !== target) throw new Error("角色不匹配");
    report.value = result;
  } catch {
    if (current()) error.value = "这次没能读取自我认知，请重试。";
  } finally {
    if (current()) loading.value = false;
  }
}
watch(characterId, () => {
  domainFilter.value = "ALL";
  statusFilter.value = "ALL";
  visibleCount.value = 5;
  void load();
}, { immediate: true });
onBeforeUnmount(() => { sequence++; });
</script>

<template>
  <main class="page-wrap self-page">
    <header class="phead">
      <div>
        <h1>她怎样理解自己</h1>
        <p class="sub">
          只读 · 展示有界证据，时间为北京时间
        </p>
      </div>
      <div class="acts">
        <el-button
          type="primary"
          :loading="loading"
          :disabled="!characterId"
          @click="load"
        >
          刷新证据
        </el-button>
      </div>
    </header>

    <el-empty
      v-if="!characterId"
      description="请先选择一个角色"
    />
    <el-skeleton
      v-else-if="loading"
      :rows="5"
      animated
      aria-label="正在读取自我认知"
    />
    <div
      v-else-if="error"
      class="notice"
    >
      <el-alert
        :title="error"
        type="error"
        :closable="false"
        show-icon
      />
      <el-button @click="load">
        重试
      </el-button>
    </div>

    <template v-else-if="view">
      <section
        class="ident"
        aria-labelledby="ident-heading"
      >
        <div
          class="avatar"
          aria-hidden="true"
        >
          {{ avatarLetter }}
        </div>
        <div class="ident-main">
          <div
            id="ident-heading"
            class="eyebrow"
          >
            身份与定位
          </div>
          <div class="ident-name">
            <h2>{{ view.identity.name }}</h2>
            <span class="pill">当前角色名</span>
          </div>
          <div class="ident-meta">
            {{ evidence.length }} 条证据<template v-if="latestUpdate">
              · 最近更新 {{ shortText(latestUpdate) }}
            </template> · 外观是呈现方式
          </div>
        </div>
        <div class="ident-fields">
          <div class="field-row">
            <div class="field">
              <span class="f-label">外观</span>
              <span
                class="f-value"
                :title="appearanceHint"
              >{{ appearance }}</span>
            </div>
            <div class="field">
              <span class="f-label">别称</span>
              <span class="f-value">—</span>
            </div>
            <div class="field">
              <span class="f-label">旧名</span>
              <span class="f-value">—</span>
            </div>
          </div>
          <div class="legend">
            — 表示角色数据中没有这条记录，不作为判断依据。
          </div>
        </div>
        <NuxtLink
          class="l1"
          :to="roleLink(`/characters/${encodeURIComponent(characterId)}`)"
        >
          查看角色资料 →
        </NuxtLink>
      </section>

      <div class="kpis">
        <div class="kpi">
          <div class="row">
            <span class="lab">证据总数</span><span class="note">{{ Object.values(counts).filter((value) => value > 0).length }} 个域有记录</span>
          </div><b>{{ evidence.length }}</b>
        </div>
        <div class="kpi">
          <div class="row">
            <span class="lab">已采纳反思</span><span class="note">可随新证据修订</span>
          </div><b>{{ reflections.length }}</b>
        </div>
        <div class="kpi">
          <div class="row">
            <span class="lab">修订对照</span><span class="note">旧版仍可核对</span>
          </div><b>{{ historyRows.length }}</b>
        </div>
        <div class="kpi">
          <div class="row">
            <span class="lab">会话经验</span><span class="note">只在原会话生效</span>
          </div><b>{{ counts.experience ?? 0 }}</b>
        </div>
      </div>

      <div class="grid">
        <aside class="card">
          <div class="card-h">
            <h3>按域查看</h3><span class="meta">{{ evidence.length }}</span>
          </div>
          <div class="domlist">
            <button
              v-for="key in domainOrder"
              :key="key"
              type="button"
              class="domrow"
              :class="{ on: domainFilter === key, dis: !counts[key] }"
              :aria-pressed="domainFilter === key"
              :aria-disabled="!counts[key]"
              :disabled="!counts[key]"
              @click="pickDomain(key)"
            >
              <i
                class="dot"
                :class="`d-${key}`"
              />{{ domainLabels[key] }}<b>{{ counts[key] || '—' }}</b>
            </button>
          </div>
          <div class="b-note">
            本页只读，只展示有界证据，<br>不作为能力或身份证明。<br>纠正请到来源模块处理。
          </div>
        </aside>

        <section class="card">
          <div
            v-if="quote"
            class="quote"
          >
            <div class="lab">
              她现在的说法
            </div>
            <p>{{ readableExcerpt(quote.excerpt) }}<span v-if="quote.excerptTruncated">…</span></p>
            <div class="q-meta">
              已采纳的解释 · {{ shortText(quote.updatedAt) }}
            </div>
          </div>
          <div
            v-else
            class="quote"
          >
            <div class="lab">
              她现在的说法
            </div>
            <p class="quiet">
              还没有被采纳的解释。这里只展示有来源支持、且经你确认过的理解。
            </p>
          </div>

          <div
            class="filters"
            role="group"
            aria-label="按状态筛选"
          >
            <button
              v-for="item in statusFilters"
              :key="item.value"
              type="button"
              class="fchip"
              :class="{ on: statusFilter === item.value }"
              :aria-pressed="statusFilter === item.value"
              :disabled="!countFor(item.value)"
              @click="pickStatus(item.value)"
            >
              {{ item.label }} <b>{{ countFor(item.value) }}</b>
            </button>
          </div>

          <div class="list">
            <ul
              v-if="shown.length"
              class="ev"
            >
              <li
                v-for="row in shown"
                :key="`${row.domain}:${row.id}`"
              >
                <i
                  class="dot"
                  :class="`d-${row.domain}`"
                />
                <span class="ev-k">{{ domainLabels[row.domain] }}</span>
                <div class="ev-body">
                  <p class="ev-t">
                    {{ readableExcerpt(row.excerpt) }}<span v-if="row.excerptTruncated">…</span>
                  </p>
                  <div class="ev-meta">
                    {{ statusLabels[row.status] }} · {{ shortText(row.occurredAt ?? row.updatedAt) }}<template v-if="row.confidence !== null && row.confidence !== undefined">
                      · 置信度 {{ row.confidence.toFixed(2) }}
                    </template><template v-if="row.revision">
                      · v{{ row.revision }}
                    </template>
                  </div>
                </div>
                <NuxtLink
                  class="l3"
                  :to="sourceLink(row)"
                  :aria-label="`在${domainLabels[row.domain]}模块核对这条证据（离开本页）`"
                >
                  来源 ↗
                </NuxtLink>
              </li>
            </ul>
            <p
              v-else
              class="empty-inline"
            >
              当前筛选下没有证据。换一个域，或查看全部。
            </p>
          </div>

          <div class="ev-foot">
            <span>已显示 {{ shown.length }} / {{ filtered.length }} 条</span>
            <button
              v-if="remaining"
              type="button"
              @click="visibleCount += 20"
            >
              再显示 20 条，剩余 {{ remaining }} 条
            </button>
          </div>
        </section>

        <aside class="card">
          <div class="card-h">
            <h3>成长轨迹</h3><span class="meta">{{ historyRows.length }} 项变化</span>
          </div>
          <div class="tl">
            <div
              v-for="row in historyRows"
              :key="`${row.domain}:${row.id}`"
              class="tl-item"
            >
              <div class="tl-time">
                {{ shortText(row.current.recordedAt) }} · {{ domainLabels[row.domain] }}
              </div>
              <div class="tl-title">
                {{ historySubject(row) }}
              </div>
              <div class="cmp">
                <div class="o">
                  <span>历史版 v{{ row.previous.revision }}</span>{{ readableExcerpt(row.previous.excerpt) }}<span v-if="row.previous.excerptTruncated">…</span>
                </div>
                <div class="n">
                  <span>当前版 v{{ row.current.revision }}</span>{{ readableExcerpt(row.current.excerpt) }}<span v-if="row.current.excerptTruncated">…</span>
                </div>
              </div>
            </div>
            <p
              v-if="!historyRows.length"
              class="empty-inline"
            >
              还没有可对照的修订。记录第一次变化后，这里会保留旧版与当前版。
            </p>
          </div>
          <div class="tl-foot">
            <NuxtLink
              class="l2"
              :to="roleLink('/growth/reflection')"
            >
              到反思系统核对 →
            </NuxtLink>
          </div>
        </aside>
      </div>
    </template>
  </main>
</template>

<style scoped>
.self-page { max-width: 1124px; margin-inline: auto; }
.phead { display: flex; align-items: flex-end; gap: 14px; }
.phead h1 { margin: 0; font-size: 22px; line-height: 28px; letter-spacing: -.02em; }
.phead .sub { margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var(--dim); }
.phead .acts { margin-left: auto; padding-bottom: 3px; }
.notice { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }

.ident { height: 104px; margin-top: 12px; background: var(--surface); border-radius: 10px; padding: 0 16px; display: flex; align-items: center; }
.avatar { width: 56px; height: 56px; border-radius: 10px; background: var(--brand-soft); color: var(--brand-btn); font-size: 24px; font-weight: 700; display: grid; place-items: center; flex: none; }
.ident-main { min-width: 0; margin-left: 14px; }
.eyebrow { font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: .06em; color: var(--dim); margin-bottom: 2px; }
.ident-name { display: flex; align-items: center; gap: 8px; }
.ident-name h2 { margin: 0; font-size: 22px; line-height: 28px; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill { height: 22px; padding: 0 10px; border-radius: 999px; background: var(--brand-soft); color: var(--brand-btn); font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; flex: none; }
.ident-meta { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--dim); }
.ident-fields { margin-left: 32px; display: flex; flex-direction: column; gap: 6px; }
.field-row { display: flex; gap: 24px; }
.field { width: 96px; }
.f-label { display: block; font-size: 12px; line-height: 16px; color: var(--dim); }
.f-value { display: block; font-size: 14px; line-height: 20px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend { font-size: 12px; line-height: 16px; color: var(--dim); }
.l1 { margin-left: auto; flex: none; font-size: 14px; font-weight: 600; color: var(--brand-btn); }
.l2 { font-size: 12px; font-weight: 600; color: var(--brand-btn); }
.l3 { flex: none; font-size: 12px; color: var(--dim); text-align: right; }
.l1:hover, .l2:hover, .l3:hover { text-decoration: underline; }

.kpis { display: grid; grid-template-columns: 224px 281px 281px 296px; gap: 14px; margin-top: 16px; }
.kpi { background: var(--surface); border-radius: 10px; padding: 12px 16px; }
.kpi .row { display: flex; align-items: baseline; gap: 8px; }
.kpi .lab { font-size: 12px; line-height: 16px; color: var(--dim); }
.kpi .note { margin-left: auto; font-size: 12px; line-height: 16px; color: var(--dim); text-align: right; }
.kpi b { display: block; font-size: 22px; line-height: 26px; margin-top: 4px; font-weight: 700; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }

.grid { display: grid; grid-template-columns: 224px minmax(0, 1fr) 296px; gap: 14px; margin-top: 14px; height: max(460px, calc(100vh - 378px)); }
.card { background: var(--surface); border-radius: 10px; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.card-h { display: flex; align-items: baseline; gap: 8px; padding: 16px 16px 8px; flex: none; }
.card-h h3 { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .06em; color: var(--dim); }
.card-h .meta { margin-left: auto; font-size: 12px; color: var(--dim); font-variant-numeric: tabular-nums; }

.domlist { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 6px 0; }
.domrow { display: flex; align-items: center; gap: 8px; width: 100%; height: 34px; padding: 0 10px; border: 0; border-radius: 8px; background: none; font-family: inherit; font-size: 14px; color: var(--text-2); text-align: left; cursor: pointer; }
.domrow b { margin-left: auto; font-size: 12px; color: var(--dim); font-weight: 600; font-variant-numeric: tabular-nums; }
.domrow:hover:not(.dis) { background: var(--bg); }
.domrow.on { background: var(--brand-soft); color: var(--brand-btn); font-weight: 600; }
.domrow.on b { color: var(--brand-btn); }
.domrow.dis { color: #8b94a3; cursor: default; }
.domrow.dis b { color: #8b94a3; }
.b-note { margin-top: auto; padding: 8px 16px 16px; font-size: 12px; line-height: 20px; color: var(--dim); }

.quote { padding: 16px 16px 12px; flex: none; }
.quote .lab { font-size: 12px; font-weight: 700; letter-spacing: .06em; color: var(--dim); margin-bottom: 6px; }
.quote p { margin: 0; font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.quote p.quiet { color: var(--dim); }
.q-meta { margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--dim); }
.filters { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 12px; flex: none; }
.fchip { height: 28px; padding: 0 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: 12px; color: var(--text-2); font-family: inherit; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.fchip b { font-weight: 600; color: var(--dim); font-variant-numeric: tabular-nums; }
.fchip:hover:not(:disabled) { border-color: var(--brand-btn); }
.fchip.on { border-color: var(--brand-btn); background: var(--brand-soft); color: var(--brand-btn); font-weight: 600; }
.fchip.on b { color: var(--brand-btn); }
.fchip:disabled { opacity: .5; cursor: default; }

.list { flex: 1; min-height: 0; overflow-y: auto; border-top: 1px solid var(--line); }
.ev { list-style: none; margin: 0; padding: 0; }
.ev li { display: grid; grid-template-columns: 7px 54px minmax(0, 1fr) 58px; gap: 10px; align-items: center; min-height: 55px; padding: 6px 16px; border-bottom: 1px solid var(--line); }
.ev li:hover { background: var(--bg); }
.ev-k { font-size: 12px; color: var(--dim); white-space: nowrap; }
.ev-body { min-width: 0; }
.ev-t { margin: 0; font-size: 14px; line-height: 1.5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ev-meta { margin-top: 2px; font-size: 12px; line-height: 18px; color: var(--dim); font-variant-numeric: tabular-nums; }
.dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex: none; background: #8b94a3; }
.d-memory { background: #4c5fd5; }
.d-experience { background: var(--brand); }
.d-preferences { background: #b57c1f; }
.d-language { background: #0b7a54; }
.d-reflection { background: #4c5fd5; }
.d-goals, .d-social, .d-knowledge { background: #8b94a3; }

.ev-foot { flex: none; min-height: 38px; display: flex; align-items: center; gap: 10px; padding: 0 16px; border-top: 1px solid var(--line); font-size: 12px; color: var(--dim); }
.ev-foot button { margin-left: auto; height: 24px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); font-size: 12px; color: var(--text-2); font-family: inherit; cursor: pointer; }
.ev-foot button:hover { border-color: var(--brand-btn); color: var(--brand-btn); }
.empty-inline { margin: 0; padding: 20px 16px; font-size: 12px; line-height: 20px; color: var(--dim); }

.tl { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 16px 0; scrollbar-width: thin; mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent); -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 22px), transparent); }
.tl-item { position: relative; padding: 4px 0 8px 14px; border-left: 1px solid var(--line); }
.tl-item:last-child { border-left-color: transparent; }
.tl-item::before { content: ""; position: absolute; left: -4px; top: 8px; width: 7px; height: 7px; border-radius: 50%; background: var(--brand); }
.tl-time { font-size: 12px; line-height: 16px; color: var(--dim); }
.tl-title { font-size: 14px; font-weight: 600; margin: 2px 0 6px; }
.cmp { border-radius: 8px; overflow: hidden; }
.cmp div { padding: 6px 10px; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.cmp .o { background: var(--bg); color: var(--dim); }
.cmp .n { background: var(--surface); color: var(--text); border-left: 2px solid var(--brand); }
.cmp span { display: block; font-size: 12px; line-height: 16px; margin-bottom: 2px; color: var(--dim); }
.cmp .n span { color: var(--brand-btn); font-weight: 600; }
.tl-foot { flex: none; padding: 12px 16px 16px; border-top: 1px solid var(--line); }


@media (max-width: 1180px) {
  .ident { height: auto; padding: 14px 16px; flex-wrap: wrap; gap: 10px 16px; }
  .ident-fields { margin-left: 70px; }
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid { grid-template-columns: 200px minmax(0, 1fr); height: auto; }
  .grid > .card:last-child { grid-column: 1 / -1; max-height: 320px; }
}
@media (max-width: 860px) {
  .ident-fields { margin-left: 0; width: 100%; }
  .field { width: auto; flex: 1; }
  .grid { grid-template-columns: 1fr; }
  .grid > .card:first-child { max-height: 280px; }
  .list, .tl { max-height: 420px; }
  .ev li { grid-template-columns: 7px 46px minmax(0, 1fr); }
  .l3 { display: none; }
}
</style>
