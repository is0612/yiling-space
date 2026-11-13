<script setup lang="ts">
import { markRaw } from "vue";
import { ChatDotRound, Microphone, Picture } from "@element-plus/icons-vue";
import CharacterModelSettings from "~/components/CharacterModelSettings.vue";
import "~/assets/css/model-settings.css";

/**
 * 模型设置属于某个角色，所以地址也挂在角色下面（`/characters/:id/settings/model`），
 * 和记忆周期 / 表情包 / 梗语录同一层，顶栏面包屑能直接回「角色管理」。
 * 2026-11-13 之前它是顶栏侧栏里的独立一级页 `/models`，那会儿换角色只能靠 ?c= 之类的查询参数。
 * 旧地址还在转发（见 app/pages/models.vue），老书签不会断。
 */
definePageMeta({
  topbar: {
    title: "模型设置",
    crumbs: [{ label: "角色管理", to: "/characters" }],
  },
});

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
/** 角色来自路径参数：这一页只在某个角色的上下文里成立，不再回落到 cookie 里的「上次那个」 */
const characterId = computed(() => String(route.params.id || ""));

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
  void router.replace({ path: `/characters/${characterId.value}/settings/model`, query: { ...route.query, c: characterId.value || undefined, section: value }, hash: route.hash });
}
</script>

<template>
  <div class="model-settings-workspace page-wrap">
    <header class="model-workspace-header">
      <div class="model-workspace-heading">
        <h1>一次找到，按需配置。</h1>
        <p>对话、看图、语音，以及跟着对话模型走的四个助手。</p>
      </div>
      <div class="model-workspace-actions">
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
