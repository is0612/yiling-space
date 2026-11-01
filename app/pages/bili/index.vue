<script setup lang="ts">
import { ref } from "vue";
import { ElMessage } from "element-plus";
import type { BiliAccount } from "./types";
import BiliSidebar from "./BiliSidebar.vue";
import BiliOverview from "./BiliOverview.vue";
import BiliHistory from "./BiliHistory.vue";
import BiliCommand from "./BiliCommand.vue";
import BiliAccountDialog from "./BiliAccountDialog.vue";
import BiliBindDialog from "./BiliBindDialog.vue";
import BiliDutyDialog from "./BiliDutyDialog.vue";
import BiliLoginDialog from "./BiliLoginDialog.vue";
import BiliMenuDialog from "./BiliMenuDialog.vue";
import BiliJournalDialog from "./BiliJournalDialog.vue";
import { provideBiliDesk } from "./useBiliDesk";
import { provideBiliDashboard } from "./useBiliDashboard";
import { provideBiliAccounts } from "./useBiliAccounts";
import { provideBiliMe } from "./useBiliMe";
import { provideBiliRunner } from "./useBiliRunner";
import "./bili.css";

/**
 * B站值班台 —— 只剩「壳」：两条柱子（侧栏 + 工作区）、三个视图的切换、五个弹窗的挂载。
 *
 * 状态分层（都走 provide / inject，页面只创建一次、子组件读同一份）：
 *   useBiliDesk      视图切换 / 命令目录 / 常用 / 菜单可见性 / 页面级动作      （页面私有 + 侧栏共用）
 *   useBiliDashboard dashboard + KPI 派生值 + 封面缓存 + 跑一轮               （概览 + 运行记录共用）
 *   useBiliAccounts  账号弹窗开关 + 解绑 / 删号
 *   useBiliMe        当前扫码登录的账号
 *   useBiliRunner    命令参数 / argv / 执行 / 本次启动的运行记录
 *
 * 纯函数（时间格式化、报告解析、封面渐变）在 utils.ts，数据类型在 types.ts，样式在 bili.css。
 * 这里不写任何业务逻辑 —— 想加东西先想清楚它属于哪一层。
 */
useHead({ title: "B站值班台 · 忆灵空间" });

// 角色列表：绑定角色时用，与角色管理页共享同一份数据。
const characters = useCharacterList();

// 创建顺序 = 依赖顺序：dashboard → me（登录后重读 dashboard）→ accounts（改完要重读）→ desk → runner
// ⚠️ 依赖一律从参数传下去，不在 store 里相互 inject：
//    Vue 的 inject 只往**父组件**的 provides 里找，页面自己 provide 的东西在同一个 setup 里读不到。
const dash = provideBiliDashboard();
const me = provideBiliMe({ onLoggedIn: () => dash.loadDashboard() });
const accounts = provideBiliAccounts({ accounts: dash.accounts, reload: dash.loadDashboard });
const journalVisible = ref(false);
const journalTarget = ref<BiliAccount | null>(null);

const desk = provideBiliDesk({
  openDutyForFirstAccount: () => accounts.openDutyForFirstAccount(),
  openJournalForFirstAccount() {
    const account = dash.accounts.value[0];
    if (!account) {
      ElMessage.warning("先添加一个 B站 账号。");
      return;
    }
    if (!account.bindings.length) {
      ElMessage.warning("这个账号还没绑定角色，札记写在角色的全局记忆里。");
      return;
    }
    journalTarget.value = account;
    journalVisible.value = true;
  },
  async refreshStatus() {
    await Promise.all([dash.loadDashboard(), me.loadMe()]);
    ElMessage.success("状态已刷新。");
  },
});
// runner 要读 desk.activeCmd，所以最后建
const runner = provideBiliRunner({ activeCmd: desk.activeCmd });

await useCharacterListData();

const { view, rail, menuOpen, groups, hiddenGroups, hiddenItems, onMenuSave } = desk;
const { accountVisible, bindVisible, bindTarget, dutyVisible, dutyTarget } = accounts;
const { loginVisible, meProfile, handleLoggedIn } = me;
const { runLog } = runner;
const loadDashboard = dash.loadDashboard;

onMounted(() => {
  desk.init();
  void loadDashboard();
  void me.loadMe();
});
onBeforeUnmount(desk.dispose);
</script>

<template>
  <div class="page-wrap desk-wrap">
    <div
      class="bd"
      :class="{ 'is-rail': rail }"
    >
      <!-- 侧栏 260px：工作台 / 常用 / 全部命令 -->
      <BiliSidebar :run-count="runLog.length" />

      <!-- 工作区：概览 / 运行记录 / 命令台 -->
      <main class="bd-work">
        <div class="bd-in">
          <BiliOverview v-if="view === 'overview'" />
          <BiliHistory v-else-if="view === 'history'" />
          <BiliCommand v-else />
        </div>
      </main>
    </div>

    <!-- 弹窗 -->
    <BiliAccountDialog
      v-model="accountVisible"
      @saved="loadDashboard"
    />

    <BiliBindDialog
      v-model="bindVisible"
      :connection-id="bindTarget?.connectionId ?? ''"
      :characters="characters"
      @saved="loadDashboard"
    />

    <BiliDutyDialog
      v-model="dutyVisible"
      :account="dutyTarget"
      @saved="loadDashboard"
    />

    <BiliJournalDialog
      v-model="journalVisible"
      :account="journalTarget"
      @saved="loadDashboard"
    />

    <BiliLoginDialog
      v-model="loginVisible"
      :me="meProfile"
      @logged-in="handleLoggedIn"
    />

    <BiliMenuDialog
      v-model="menuOpen"
      :groups="groups"
      :hidden-groups="hiddenGroups"
      :hidden-items="hiddenItems"
      @save="onMenuSave"
    />
  </div>
</template>
