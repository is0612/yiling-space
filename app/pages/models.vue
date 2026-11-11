<script setup lang="ts">
import { markRaw } from "vue";
import { MODEL_PURPOSE_DEFAULTS } from "#shared/utils/model-purpose-defaults";
import { ArrowRight, ChatDotRound, Connection, Cpu, InfoFilled, Setting } from "@element-plus/icons-vue";
import CharacterModelSettings from "~/components/CharacterModelSettings.vue";
import KnowledgeAssistantSettings from "~/components/KnowledgeAssistantSettings.vue";
import SocialAssessmentSettings from "~/components/SocialAssessmentSettings.vue";
import "~/assets/css/model-settings.css";

definePageMeta({ topbar: { title: "模型设置" } });
type ModelSection = "chat" | "voice" | "vision" | "memoryAssistant" | "contextAssistant";
type SettingsSection = ModelSection | "knowledge" | "social";
const route = useRoute();
const router = useRouter();
const { id: characterId, character } = useCharacterSelection("/models");
const sections: Array<{ key: SettingsSection; label: string; description: string }> = [
  { key: "chat", label: "对话模型", description: "负责角色最终说出的每一句话。先配置服务连接，再调整回复与上下文参数。" },
  { key: "voice", label: "语音模型", description: "分别配置听懂语音和生成语音。识别与合成可以使用不同服务。" },
  { key: "vision", label: "图片模型", description: "让角色理解收到的图片，选择支持视觉理解的模型。" },
  { key: "memoryAssistant", label: "记忆助手", description: "从历史候选中筛选可靠来源，为需要回忆的问题提供依据。" },
  { key: "contextAssistant", label: "语境助手", description: "理解群聊里谁在对谁说话，并判断是否需要记忆或知识。" },
  { key: "knowledge", label: "知识助手", description: "整理知识候选、辨别重复与冲突，结果仍由你确认。" },
  { key: "social", label: "关系评估助手", description: "根据共同经历提出关系变化建议，不自动修改关系。" },
];
const capabilityGroups = [
  { title: "对话与多模态", icon: ChatDotRound, keys: ["chat", "voice", "vision"] },
  { title: "理解与检索", icon: Connection, keys: ["memoryAssistant", "contextAssistant"] },
  { title: "后台助手", icon: Setting, keys: ["knowledge", "social"] },
];
function groupSections(keys: string[]) { return sections.filter(item => keys.includes(item.key)); }
function readSection(value: unknown): SettingsSection {
  const candidate = typeof value === "string" ? value : "chat";
  return sections.some(item => item.key === candidate) ? candidate as SettingsSection : "chat";
}
const section = computed(() => readSection(route.query.section));
const mainSection = computed<ModelSection>(() => section.value === "knowledge" || section.value === "social" ? "chat" : section.value);
const currentSection = computed(() => sections.find(item => item.key === section.value) ?? sections[0]!);
const description = computed(() => currentSection.value.description);
const recommendation = computed(() => {
  if (section.value === "voice") return `建议语速 ${MODEL_PURPOSE_DEFAULTS.voice.speed}×，先试听再微调`;
  if (section.value === "vision") return "选择支持视觉理解的模型，图片生成模型不用于看图";
  const purpose = section.value === "memoryAssistant" ? MODEL_PURPOSE_DEFAULTS.memory
    : section.value === "contextAssistant" ? MODEL_PURPOSE_DEFAULTS.context
      : section.value === "knowledge" ? MODEL_PURPOSE_DEFAULTS.knowledge
        : section.value === "social" ? MODEL_PURPOSE_DEFAULTS.social : MODEL_PURPOSE_DEFAULTS.chat;
  return `推荐起点：温度 ${purpose.temperature} · 输出 ${purpose.maxOutputTokens.toLocaleString()} Token`;
});
const saveScope = computed(() => section.value === "knowledge" ? "仅保存知识助手设置" : section.value === "social" ? "仅保存关系评估设置" : "保存对话、多模态与检索设置");
const saveScopeExplanation = "对话、语音、图片、记忆和语境共用“保存设置”，会一起保存这五项草稿；知识和关系评估分别保存。切换能力保留草稿，切换角色会重新载入。";
const modelCallLogsOpen = ref(false);
const activePanel = ref<{ busy?: boolean } | null>(null);
const busy = computed(() => activePanel.value?.busy === true);
onBeforeRouteUpdate((to, from) => {
  if (busy.value && (to.query.section !== from.query.section || to.query.c !== from.query.c)) return false;
});
onBeforeRouteLeave(() => busy.value ? false : undefined);
watch(characterId, () => { modelCallLogsOpen.value = false; }, { flush: "sync" });
const mainComponent = markRaw(CharacterModelSettings);
const knowledgeComponent = markRaw(KnowledgeAssistantSettings);
const socialComponent = markRaw(SocialAssessmentSettings);
const activeComponent = computed(() => section.value === "knowledge" ? knowledgeComponent : section.value === "social" ? socialComponent : mainComponent);
function selectSection(value: SettingsSection) {
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
        <p>对话、看图、语音与助手，都在这里。</p>
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
          <strong>能力配置</strong><span>7 项</span>
        </div>
        <nav
          class="model-capability-nav"
          aria-label="模型能力设置"
        >
          <section
            v-for="group in capabilityGroups"
            :key="group.title"
            class="model-nav-group"
          >
            <h2><el-icon><component :is="group.icon" /></el-icon>{{ group.title }}</h2>
            <el-button
              v-for="item in groupSections(group.keys)"
              :key="item.key"
              :aria-pressed="section === item.key"
              :class="{ 'is-selected': section === item.key }"
              :disabled="busy"
              @click="selectSection(item.key)"
            >
              <span>{{ item.label }}</span><el-icon aria-hidden="true">
                <ArrowRight />
              </el-icon>
            </el-button>
          </section>
        </nav>
        <p class="model-sidebar-note">
          先配置对话模型，再按需要启用其他能力。
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
              :is="activeComponent"
              ref="activePanel"
              :character-id="characterId"
              v-bind="section !== 'knowledge' && section !== 'social' ? { section: mainSection } : {}"
              embedded
            />
          </KeepAlive>
        </div>
      </main>
    </div>
  </div>
</template>
