<script setup lang="ts">
import { Collection, Connection, View } from "@element-plus/icons-vue";
import type { SelfUnderstandingView } from "../../../server/utils/self-understanding";

definePageMeta({ topbar: { title: "自我认知", crumbs: [{ label: "成长系统" }] } });

type Evidence = SelfUnderstandingView["evidence"][number];
type Report = { characterId: string; view: SelfUnderstandingView };
const route = useRoute();
const { character } = useCharacterSelection(route.path);
const characterId = computed(() => character.value?.id ?? "");
const request = useApiRequest();
const report = ref<Report | null>(null);
const error = ref("");
const loading = ref(false);
let sequence = 0;

const domainLabels = { memory: "记忆", experience: "互动经验", preferences: "偏好", language: "表达习惯", goals: "目标与愿望", social: "关系", reflection: "反思", knowledge: "知识" };
const statusLabels = { active_record: "有效记录", confirmed_record: "已确认记录", accepted_interpretation: "已采纳的解释", scoped_experience: "会话经验" };
const sourcePaths = {
  memory: "/growth/memory/long-term", experience: "/growth/memory/interaction-experiences", preferences: "/growth/preferences",
  language: "/growth/language", goals: "/growth/goals", social: "/growth/social/assessments", reflection: "/growth/reflection", knowledge: "/growth/knowledge",
} as const;
const sections = [
  { id: "experience", title: "经历与关系", description: "留存的经历、记忆与已经确认的关系。这些资料可以支持回顾，不能替她决定哪段经历最重要。", domains: ["memory", "experience", "social"] },
  { id: "preferences", title: "偏好与表达", description: "当前有效的长期倾向和适用场景；临时反馈不在这里当作稳定特征。", domains: ["preferences", "language", "goals"] },
  { id: "other", title: "其他参考", description: "知识能说明她学过什么，但不能单独说明她是谁。", domains: ["knowledge"] },
] as const;
const view = computed(() => report.value?.characterId === characterId.value ? report.value?.view ?? null : null);
const reflections = computed(() => view.value?.evidence.filter(row => row.domain === "reflection") ?? []);
const changes = computed(() => [...(view.value?.history ?? [])].sort((a, b) => (b.current.recordedAt ?? "").localeCompare(a.current.recordedAt ?? "")));
function evidenceFor(domains: readonly string[]) { return view.value?.evidence.filter(row => domains.includes(row.domain)) ?? []; }
function roleLink(path: string) { return { path, query: { c: characterId.value } }; }
function sourceLink(row: Pick<Evidence, "domain" | "occurredAt">) {
  return roleLink(row.domain === "memory" && row.occurredAt ? "/growth/memory/events" : sourcePaths[row.domain]);
}
const dateFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Shanghai" });
function dateText(value?: string) {
  const date = new Date(value ?? "");
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "未记录";
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
watch(characterId, () => { void load(); }, { immediate: true });
onBeforeUnmount(() => { sequence++; });
</script>

<template>
  <main class="page-wrap self-page">
    <header class="intro">
      <div class="eyebrow">
        <el-icon><View /></el-icon> 认识自己
      </div>
      <h1>自我认知</h1>
      <p>看见她怎样从经历与关系中，一点点理解自己。这里展示已有证据，理解可以随新的经历改变。</p>
      <el-button
        v-if="characterId && !error"
        :loading="loading"
        @click="load"
      >
        刷新证据
      </el-button>
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
      <div
        :key="characterId"
        class="view-stack"
      >
        <div class="lead-grid">
          <el-card
            shadow="never"
            class="identity-card"
          >
            <section aria-labelledby="identity-title">
              <div class="eyebrow">
                身份与定位
              </div>
              <h2 id="identity-title">
                {{ view.identity.name }}
              </h2>
              <el-tag
                effect="plain"
                type="success"
              >
                当前角色名
              </el-tag>
              <p
                v-if="view.presentation.avatar"
                class="appearance"
              >
                {{ view.presentation.avatar === 'configured_image' ? '已设置外观图片' : `外观：${view.presentation.avatar}` }}。外观是呈现方式。
              </p>
              <p>别称、身份如何形成及旧名称变化目前没有可追溯的记录，暂保留为未知。</p>
              <NuxtLink
                class="source-link"
                :to="roleLink(`/characters/${encodeURIComponent(characterId)}`)"
              >
                查看角色资料
              </NuxtLink>
            </section>
          </el-card>
          <el-card
            shadow="never"
            class="summary-card"
          >
            <section aria-labelledby="summary-title">
              <div class="eyebrow">
                阶段性的理解
              </div>
              <h2 id="summary-title">
                自我认知总结
              </h2>
              <template v-if="reflections.length">
                <p>下面是已采纳的反思，代表有来源支持的解释。它们仍可随新证据修订。</p>
                <details
                  v-for="(row, index) in reflections"
                  :key="row.id"
                  :open="index === 0"
                  class="evidence"
                >
                  <summary>已采纳反思 <time :datetime="row.updatedAt">{{ dateText(row.updatedAt) }}</time></summary>
                  <p>{{ row.excerpt }}<span v-if="row.excerptTruncated">…</span></p>
                  <div class="meta">
                    <span class="source-id">记录编号：{{ row.id }}</span><NuxtLink
                      class="source-link"
                      :to="sourceLink(row)"
                    >
                      到反思系统核对
                    </NuxtLink>
                  </div>
                </details>
              </template>
              <p v-else>
                目前没有可供这里展示的、来源仍有效的已采纳反思。可以先查看下方已有证据。
              </p>
            </section>
          </el-card>
        </div>

        <el-card
          v-for="section in sections"
          :key="section.id"
          shadow="never"
          class="section-card"
        >
          <section :aria-labelledby="`self-${section.id}`">
            <h2 :id="`self-${section.id}`">
              <el-icon><Collection v-if="section.id === 'experience'" /><Connection v-else /></el-icon> {{ section.title }}
            </h2>
            <p>{{ section.description }}</p>
            <div
              v-if="evidenceFor(section.domains).length"
              class="records"
            >
              <details
                v-for="row in evidenceFor(section.domains)"
                :key="`${row.domain}:${row.id}`"
                class="evidence"
              >
                <summary>
                  <el-tag effect="plain">
                    {{ domainLabels[row.domain] }}
                  </el-tag>
                  <span class="preview">{{ readableExcerpt(row.excerpt) }}</span>
                </summary>
                <p>{{ readableExcerpt(row.excerpt) }}<span v-if="row.excerptTruncated">…（摘录）</span></p>
                <p v-if="row.context">
                  {{ row.context }}
                </p>
                <div class="meta">
                  <el-tag
                    type="info"
                    effect="plain"
                  >
                    {{ statusLabels[row.status] }}
                  </el-tag>
                  <span v-if="row.occurredAt">发生于 {{ dateText(row.occurredAt) }}</span>
                  <span>记录时间 {{ dateText(row.updatedAt) }}</span>
                  <span v-if="row.revision">版本 {{ row.revision }}</span>
                  <span v-if="row.confidence === null">可信度未知</span>
                  <span v-else-if="row.confidence !== undefined">来源可信度 {{ Math.round(row.confidence * 100) }}%</span>
                </div>
                <div class="meta">
                  <span class="source-id">记录编号：{{ row.id }}</span><NuxtLink
                    class="source-link"
                    :to="sourceLink(row)"
                  >
                    打开来源模块
                  </NuxtLink>
                </div>
              </details>
            </div>
            <p
              v-else
              class="empty-copy"
            >
              这次未读取到此类可展示的证据。
            </p>
          </section>
        </el-card>

        <el-card
          shadow="never"
          class="section-card"
        >
          <section aria-labelledby="self-history">
            <h2 id="self-history">
              成长轨迹
            </h2>
            <p>同一条记录的旧版和当前版。时间表示记录何时更新。</p>
            <el-timeline
              v-if="changes.length"
              class="history"
            >
              <el-timeline-item
                v-for="row in changes"
                :key="`${row.domain}:${row.id}`"
                :timestamp="dateText(row.current.recordedAt)"
                placement="top"
              >
                <h3>
                  {{ domainLabels[row.domain] }}<template v-if="row.domain === 'social'">
                    · {{ view.evidence.find(item => item.domain === row.domain && item.id === row.id)?.excerpt.split(':')[0] }}
                  </template>
                </h3>
                <div class="comparison">
                  <div>
                    <el-tag
                      type="info"
                      effect="plain"
                    >
                      历史版本 {{ row.previous.revision }}
                    </el-tag><p>{{ readableExcerpt(row.previous.excerpt) }}<span v-if="row.previous.excerptTruncated">…</span></p><small>记录时间 {{ dateText(row.previous.recordedAt) }}</small>
                  </div>
                  <div>
                    <el-tag
                      type="success"
                      effect="plain"
                    >
                      当前版本 {{ row.current.revision }}
                    </el-tag><p>{{ readableExcerpt(row.current.excerpt) }}<span v-if="row.current.excerptTruncated">…</span></p>
                  </div>
                </div>
                <NuxtLink
                  class="source-link"
                  :to="sourceLink(row)"
                >
                  前往来源查看记录
                </NuxtLink>
              </el-timeline-item>
            </el-timeline>
            <p
              v-else
              class="empty-copy"
            >
              {{ view.history ? '目前没有可核对的旧版与当前版对照。' : '历史对照暂不可用；上方的当前证据仍可查看。' }}
            </p>
          </section>
        </el-card>
        <footer>本页只读，展示有界的证据，不代表她全部的经历。时间均为北京时间。需要纠正时，请在对应来源模块处理。</footer>
      </div>
    </template>
  </main>
</template>

<style scoped>
.self-page { max-width: 1120px; margin-inline: auto; }
.intro { margin: 8px 0 22px; }
.intro h1 { margin: 6px 0; font-size: clamp(24px, 4vw, 34px); }
.eyebrow { display: flex; align-items: center; gap: 7px; color: var(--el-color-primary-dark-2); font-size: 13px; font-weight: 650; }
.view-stack { display: grid; gap: 16px; }
.lead-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr); gap: 16px; }
.identity-card { background: var(--el-color-primary-light-9); }
.summary-card, .section-card, .identity-card { border-radius: 14px; }
h2 { margin: 3px 0 10px; font-size: 20px; }
h3 { margin: 0 0 10px; font-size: 15px; }
p { margin: 8px 0; line-height: 1.65; overflow-wrap: anywhere; }
.intro p, .section-card section > p, .appearance, small, footer { color: var(--el-text-color-secondary); }
.records { margin-top: 12px; }
.evidence { border-top: 1px solid var(--el-border-color-lighter); padding: 11px 0; }
.evidence summary { cursor: pointer; }
.preview { margin-left: 8px; display: inline-block; max-width: calc(100% - 120px); overflow: hidden; text-overflow: ellipsis; vertical-align: middle; white-space: nowrap; }
.evidence time { margin-left: 8px; color: var(--el-text-color-secondary); font-size: 12px; }
.meta, .notice { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; }
.meta { font-size: 13px; margin-top: 10px; }
.source-id { overflow-wrap: anywhere; color: var(--el-text-color-secondary); }
.source-link { color: var(--el-color-primary-dark-2); display: inline-block; margin-top: 5px; font-size: 13px; }
.source-link:hover { text-decoration: underline; }
.empty-copy, .comparison > div { background: var(--el-fill-color-light); border-radius: 8px; padding: 10px 12px; }
.history { padding: 12px 0 0 8px; }
.comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
small, footer { font-size: 13px; }
@media (max-width: 720px) { .lead-grid, .comparison { grid-template-columns: 1fr; } }
</style>
