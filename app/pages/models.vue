<script setup lang="ts">
import { markRaw } from "vue";
import { MODEL_PURPOSE_DEFAULTS } from "#shared/utils/model-purpose-defaults";
import { ChatDotRound, Cpu, InfoFilled, Microphone, Picture } from "@element-plus/icons-vue";
import CharacterModelSettings from "~/components/CharacterModelSettings.vue";
import "~/assets/css/model-settings.css";

definePageMeta({ topbar: { title: "模型设置" } });

/**
 * 2026-11-12：侧边栏从 7 项收到 3 项。
 *
 * 记忆 / 语境 / 知识 / 关系评估四个助手不再是并列的「能力」，而是对话模型页里的分节 ——
 * 它们默认沿用对话模型的服务商和 Key，只有真想换一家时才需要展开覆写。
 * 把「同一套连接信息填五遍」当成五个功能的代价，是换服务商时必漏一处。
 */
type ModelSection = "chat" | "voice" | "vision";
const route = useRoute();
const router = useRouter();
const { id: characterId, character } = useCharacterSelection("/models");

const sections: Array<{ key: ModelSection; label: string; description: string; icon: typeof ChatDotRound }> = [
  {
    key: "chat",
    label: "对话模型",
    description: "角色最终说出的每一句话，以及记忆、语境、知识、关系评估四个后台助手。助手默认沿用这里的服务商与 Key，需要时再展开单独覆写。",
    icon: ChatDotRound,
  },
  {
    key: "voice",
    label: "语音模型",
    description: "分别配置听懂语音和生成语音。识别与合成可以使用不同服务。",
    icon: Microphone,
  },
  {
    key: "vision",
    label: "图片模型",
    description: "让角色理解收到的图片，选择支持视觉理解的模型。",
    icon: Picture,
  },
];

/** 老链接里可能还带着 `?section=memoryAssistant` 之类：一律落到对话模型页。 */
function readSection(value: unknown): ModelSection {
  const candidate = typeof value === "string" ? value : "chat";
  return sections.some(item => item.key === candidate) ? candidate as ModelSection : "chat";
}

const section = computed(() => readSection(route.query.section));
const currentSection = computed(() => sections.find(item => item.key === section.value) ?? sections[0]!);
const description = computed(() => currentSection.value.description);
const recommendation = computed(() => {
  if (section.value === "voice") return `建议语速 ${MODEL_PURPOSE_DEFAULTS.voice.speed}×，先试听再微调`;
  if (section.value === "vision") return "选择支持视觉理解的模型，图片生成模型不用于看图";
  return `推荐起点：温度 ${MODEL_PURPOSE_DEFAULTS.chat.temperature} · 输出 ${MODEL_PURPOSE_DEFAULTS.chat.maxOutputTokens.toLocaleString()} Token`;
});
const saveScope = computed(() => "保存对话、助手、语音与图片设置");
const saveScopeExplanation = "对话模型页里的四个助手与对话模型共用「保存设置」，会一起保存；语音和图片各自保存。切换能力保留草稿，切换角色会重新载入。";

const modelCallLogsOpen = ref(false);
const activePanel = ref<{ busy?: boolean } | null>(null);
const busy = computed(() => activePanel.value?.busy === true);
onBeforeRouteUpdate((to, from) => {
  if (busy.value && (to.query.section !== from.query.section || to.query.c !== from.query.c)) return false;
});
onBeforeRouteLeave(() => busy.value ? false : undefined);
watch(characterId, () => { modelCallLogsOpen.value = false; }, { flush: "sync" });

const mainComponent = markRaw(CharacterModelSettings);

function selectSection(value: ModelSection) {
  if (busy.value || value === section.value) return;
  void router.replace({ path: "/models", query: { ...route.query, c: characterId.value || undefined, section: value }, hash: route.hash });
}
</script>

<template>
  <div class="model-settings-workspace page-wrap">
    <header class="model-workspace-header">
      <div class="model-workspace-heading">
        <span class="model-workspace-eyebrow"><el-icon><Cpu /></el-icon>模型与能力</span>
        <h1>一次找到，按需配置。</h1>
        <p>对话、看图、语音，以及跟着对话模型走的四个助手。</p>
      </div>
      <div class="model-workspace-actions">
        <span
          v-if="character"
          class="model-role-indicator"
        ><span />{{ character.name }}</span>
        <el-button
          :disabled="!characterId"
          @click="modelCallLogsOpen = true"
        >
          调用日志
        </el-button>
      </div>
    </header>
    <ModelCallLogsDialog
      v-model="modelCallLogsOpen"
      :character-id="characterId"
    />
    <el-empty
      v-if="!characterId"
      description="请先选择一个角色，再配置模型。"
    />
    <div
      v-else
      class="model-workspace-layout"
    >
      <aside class="model-capability-sidebar">
        <div class="model-sidebar-heading">
          <strong>能力配置</strong><span>3 项</span>
        </div>
        <nav
          class="model-capability-nav"
          aria-label="模型能力设置"
        >
          <section class="model-nav-group">
            <el-button
              v-for="item in sections"
              :key="item.key"
              :aria-pressed="section === item.key"
              :class="{ 'is-selected': section === item.key }"
              :disabled="busy"
              @click="selectSection(item.key)"
            >
              <span class="model-nav-label">
                <el-icon><component :is="item.icon" /></el-icon>{{ item.label }}
              </span>
            </el-button>
          </section>
        </nav>
        <p class="model-sidebar-note">
          先配置对话模型，四个助手会自动跟着它走。
        </p>
      </aside>
      <main class="model-workspace-content">
        <header class="model-purpose-header">
          <div>
            <span class="model-purpose-eyebrow">当前能力</span>
            <h2>{{ currentSection.label }}</h2>
            <p class="model-capability-description">
              {{ description }}
            </p>
            <span class="model-purpose-recommendation">{{ recommendation }}</span>
          </div>
          <el-tag
            v-if="busy"
            type="info"
            effect="plain"
          >
            正在处理…
          </el-tag>
        </header>
        <div class="model-settings-guidance">
          <span><el-icon><InfoFilled /></el-icon>{{ saveScope }}</span>
          <el-tooltip
            :content="saveScopeExplanation"
            placement="bottom"
            :show-after="200"
          >
            <el-button
              text
              size="small"
              aria-label="查看草稿与保存范围说明"
            >
              草稿与保存说明
            </el-button>
          </el-tooltip>
        </div>
        <div class="model-settings-panel">
          <KeepAlive :key="characterId">
            <component
              :is="mainComponent"
              ref="activePanel"
              :character-id="characterId"
              :section="section"
              embedded
            />
          </KeepAlive>
        </div>
      </main>
    </div>
  </div>
</template>
