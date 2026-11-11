<script setup lang="ts">
import type { Component } from "vue";
import {
  ArrowRight,
  ArrowDown,
  Avatar,
  ChatDotRound,
  Collection,
  Cpu,
  DataAnalysis,
  ChatLineRound,
  DataBoard,
  MagicStick,
  Memo,
  Refresh,
  Setting,
  SwitchButton,
  TrendCharts,
  User,
  UserFilled,
  VideoPlay,
  Reading,
} from "@element-plus/icons-vue";
import { readTopbarHeading, type TopbarHeading } from "~/utils/topbar";

const route = useRoute();
const { displayName, logout, isLocalDevIdentity, isAdmin } = useAuthSession();
const loggingOut = ref(false);
const avatarLetter = computed(() => (displayName.value || "管").slice(0, 1));

/**
 * 页面标题放顶栏：路由解析时就能拿到，服务端首屏直接带出来，不会先闪一下再归位。
 * 没声明的页面（还没搬过来的）左侧留空，右侧那组用户信息照旧贴右。
 */
const heading = computed<TopbarHeading | null>(() => readTopbarHeading(route.meta));

const refreshing = ref(false);
async function handleTopbarRefresh() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await refreshNuxtData();
  } finally {
    refreshing.value = false;
  }
}

async function handleLogout() {
  if (loggingOut.value) return;
  loggingOut.value = true;
  try {
    await logout();
  } finally {
    loggingOut.value = false;
  }
}
type NavigationItem = {
  key: string;
  label: string;
  href: string;
  icon: Component;
  count?: string;
  /** 只按完整路径高亮：分组默认入口（如 /growth）不能被 /growth/xxx 一起点亮 */
  exact?: boolean;
};

/** 分组：工作空间与成长系统是同级，系统管理仅管理员可见 */
type NavigationSection = {
  key: string;
  label: string;
  items: NavigationItem[];
  /** 可折叠分组：标题可点，展开状态只记在本次会话里 */
  collapsible?: boolean;
};

// 首屏就取到角色列表：角色管理页的卡片要用，别在这里等第二次请求。
await useCharacterListData();
const characters = useCharacterList();
const {
  id: activeCharacterId,
  character: activeCharacter,
  go: goToCharacter,
} = useCharacterSelection(route.path);

async function handleCharacterSwitch(nextId: string) {
  if (!nextId || nextId === activeCharacterId.value) return;
  // 角色详情/设置页本身带有角色 ID，切换时同步替换路径参数；
  // 其他菜单页保留当前路由，只更新共享的 ?c= 与 cookie。
  const characterRoute = /^\/characters\/[^/]+/.exec(route.path);
  const targetPath = characterRoute
    ? route.path.replace(/^\/characters\/[^/]+/, `/characters/${encodeURIComponent(nextId)}`)
    : route.path;
  await goToCharacter(nextId, targetPath);
}

/**
 * 角色级页面从侧栏共享当前角色；各页面通过同一份 query/cookie 状态读取数据。
 */
const workspaceNavigation: NavigationItem[] = [
  { key: "home", label: "总览", href: "/", icon: DataBoard },
  { key: "characters", label: "角色管理", href: "/characters", icon: User },
  { key: "models", label: "模型设置", href: "/models", icon: Cpu },
  {
    key: "journal",
    label: "日记手账",
    href: "/journal",
    icon: Reading,
  },
];

/**
 * 成长系统：各模块按阶段接入；角色级页面通过全局角色选择器共享上下文。
 * 菜单只登记入口，不自行读取角色或拉取业务接口。
 */
const growthNavigation: NavigationItem[] = [
  { key: "growth", label: "总览", href: "/growth", icon: TrendCharts, exact: true },
  { key: "growth-memory", label: "记忆系统", href: "/growth/memory", icon: Collection },
  { key: "growth-social", label: "社交系统", href: "/growth/social", icon: Avatar },
  { key: "growth-language", label: "语言系统", href: "/growth/language", icon: ChatDotRound },
  { key: "growth-reflection", label: "反思系统", href: "/growth/reflection", icon: MagicStick },
  { key: "growth-knowledge", label: "知识系统", href: "/growth/knowledge", icon: Memo },
];

const adminNavigation = computed<NavigationItem[]>(() => {
  if (!isAdmin.value) return [];
  return [
    { key: "qq", label: "QQ 渠道", href: "/qq", icon: ChatLineRound },
    { key: "bili", label: "B站值班台", href: "/bili", icon: VideoPlay },
    { key: "tasks", label: "任务监控", href: "/tasks", icon: DataAnalysis },
    { key: "users", label: "用户管理", href: "/users", icon: UserFilled },
    { key: "settings", label: "系统设置", href: "/settings", icon: Setting },
  ];
});

const navigation = computed<NavigationSection[]>(() => {
  const sections: NavigationSection[] = [
    { key: "workspace", label: "工作空间", items: workspaceNavigation },
    { key: "growth", label: "成长系统", items: growthNavigation, collapsible: true },
  ];
  if (adminNavigation.value.length) {
    sections.push({ key: "system", label: "系统管理", items: adminNavigation.value });
  }
  return sections;
});

function isGrowthPath(path: string) {
  return path === "/growth" || path.startsWith("/growth/");
}

/**
 * 九个入口默认全展开：一进门就要能看见它们。
 * 收起只在用户点了分组标题之后发生；一旦进到成长系统的任意页面（含刷新、直接输 URL），
 * 再打开一次，保证「当前页的菜单在侧栏里看得见」。
 */
const growthOpen = ref(true);
watch(
  () => route.path,
  (path) => {
    if (isGrowthPath(path)) growthOpen.value = true;
  },
);

function isActive(item: NavigationItem) {
  const path = route.path;
  if (item.exact) return path === item.href;
  switch (item.key) {
    case "home":
      return path === "/";
    case "characters":
      return path === "/characters";
    case "bili":
      return path === "/bili" || path.startsWith("/bili/");
    default:
      return path === item.href || path.startsWith(`${item.href}/`);
  }
}
</script>

<template>
  <div class="app-grid">
    <aside class="sidebar">
      <div class="sidebar-top">
        <NuxtLink
          to="/"
          class="brand"
        >
          <div class="brand-mark">
            忆
          </div>
          <div class="brand-wordmark">
            <div class="brand-title">
              忆灵空间 <span>Yiling</span>
            </div>
            <div class="brand-subtitle">
              AI CHARACTER HUB
            </div>
          </div>
        </NuxtLink>
      </div>

      <nav
        class="sidebar-nav"
        aria-label="主导航"
      >
        <template
          v-for="section in navigation"
          :key="section.key"
        >
          <button
            v-if="section.collapsible"
            type="button"
            class="sidebar-group"
            :class="{ 'is-open': growthOpen }"
            :aria-expanded="growthOpen"
            :aria-controls="`sidebar-nav-${section.key}`"
            @click="growthOpen = !growthOpen"
          >
            <span>{{ section.label }}</span>
            <el-icon><ArrowRight /></el-icon>
          </button>
          <div
            v-else
            class="sidebar-section"
          >
            {{ section.label }}
          </div>
          <div
            :id="`sidebar-nav-${section.key}`"
            class="sidebar-group-body"
            :class="{ 'is-collapsed': section.collapsible && !growthOpen }"
          >
            <NuxtLink
              v-for="item in section.items"
              :key="item.href"
              :to="item.href"
              class="sidebar-link"
              :class="{ active: isActive(item) }"
            >
              <el-icon><component :is="item.icon" /></el-icon>
              <span class="sidebar-label">{{ item.label }}</span>
              <span
                v-if="item.count"
                class="nav-count"
              >{{ item.count }}</span>
            </NuxtLink>
          </div>
        </template>
      </nav>

      <div class="sidebar-bottom">
        <el-dropdown
          v-if="characters.length"
          class="character-switcher"
          trigger="click"
          placement="top-start"
          @command="handleCharacterSwitch"
        >
          <button
            type="button"
            class="character-switcher-trigger"
            :aria-label="`当前角色：${activeCharacter?.name || '未选择'}，点击切换角色`"
          >
            <span class="admin-avatar character-switcher-avatar">
              {{ activeCharacter?.avatar || activeCharacter?.name?.slice(0, 1) || "忆" }}
            </span>
            <span class="admin-info sidebar-bottom-copy character-switcher-copy">
              <span class="admin-name">{{ activeCharacter?.name || "选择角色" }}</span>
              <span class="admin-note">当前角色 · 共 {{ characters.length }} 个</span>
            </span>
            <el-icon class="character-switcher-arrow">
              <ArrowDown />
            </el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item
                v-for="item in characters"
                :key="item.id"
                :command="item.id"
                :class="{ 'is-current-character': item.id === activeCharacterId }"
              >
                <span class="character-switcher-option-avatar">{{ item.avatar || item.name.slice(0, 1) }}</span>
                <span>{{ item.name }}</span>
                <span
                  v-if="item.id === activeCharacterId"
                  class="character-switcher-current"
                >当前</span>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <NuxtLink
          v-else
          to="/characters"
          class="character-switcher-trigger character-switcher-empty"
        >
          <span class="admin-avatar character-switcher-avatar">＋</span>
          <span class="admin-info sidebar-bottom-copy character-switcher-copy">
            <span class="admin-name">还没有角色</span>
            <span class="admin-note">去创建一个角色</span>
          </span>
        </NuxtLink>
        <div class="sidebar-version">
          <span>Yiling Space · 预览版</span><span>v0.1</span>
        </div>
      </div>
    </aside>

    <div class="app-main">
      <header class="topbar">
        <div
          v-if="heading"
          class="topbar-head"
        >
          <h1>{{ heading.title }}</h1>
        </div>
        <div class="topbar-right">
          <button
            v-if="heading?.refreshable"
            class="topbar-refresh"
            type="button"
            :disabled="refreshing"
            @click="handleTopbarRefresh"
          >
            <el-icon><Refresh /></el-icon>{{ refreshing ? "刷新中" : "刷新" }}
          </button>
          <span class="env-indicator"><span class="env-dot" />{{ isLocalDevIdentity ? "本地开发" : "已登录" }}</span>
          <div class="user-pill">
            <el-avatar :size="30">
              {{ avatarLetter }}
            </el-avatar><span>{{ displayName }}</span>
          </div>
          <el-button
            text
            size="small"
            :loading="loggingOut"
            @click="handleLogout"
          >
            <el-icon><SwitchButton /></el-icon>退出
          </el-button>
        </div>
      </header>
      <main><slot /></main>
      <!-- 记忆任务的进度挂在壳上：任务在服务端跑，切页面不该让它「消失」。 -->
      <MemoryProgressPanel />
    </div>
  </div>
</template>
