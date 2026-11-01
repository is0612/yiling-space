import { computed, inject, provide, ref, type InjectionKey } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  ChatDotRound, ChatLineRound, Collection, DataLine, Film, Folder, MessageBox,
  Microphone, Promotion, Setting, Star, TrendCharts, Upload, User, VideoPlay, View,
} from "@element-plus/icons-vue";
import type { BiliCatalogGroup, BiliCatalogItem } from "./types";
import { readErrorMessage } from "./utils";

/**
 * 值班台的「外壳状态」—— 视图切换 + 命令目录 + 侧栏可见性 + 常用固定项。
 *
 * 侧栏和页面都要这份数据（侧栏要渲染，页面要知道现在停在哪条命令），
 * 又都只读不写外部状态，所以用 provide / inject 做单例：
 * 页面里 `provideBiliDesk(...)` 一次，侧栏 `useBiliDesk()` 直接拿到同一份。
 * 千万别在组件里直接 `ref()` 复制一份 —— 那样搜索框和目录就会各走各的。
 *
 * 页面私有、侧栏用不到的东西（dashboard / runLog / 弹窗开关）不放这里。
 */
export type BiliDeskHandlers = {
  /** 侧栏点「值班设置」：没有账号时要由页面弹提示 */
  openDutyForFirstAccount: () => void;
  /** 侧栏点「她的札记」：打开当前账号对应角色的长期记忆札记 */
  openJournalForFirstAccount: () => void;
  /** 页头的「刷新状态」：重读 dashboard + 登录信息，两个视图都有这个按钮 */
  refreshStatus: () => void | Promise<void>;
};

export type BiliDesk = ReturnType<typeof createDesk>;

const DESK_KEY: InjectionKey<BiliDesk> = Symbol("bili-desk");

function createDesk(handlers: BiliDeskHandlers) {
// ── 视图切换 ───────────────────────────────────────────────
const route = useRoute();
const router = useRouter();
const view = ref<"overview" | "history" | "command">("overview");
const activeCmd = ref<BiliCatalogItem | null>(null);

/** 侧栏收成 64px 图标栏：手动点「收起」，或窗口窄于 1180 自动收。 */
const railManual = ref(false);
const narrow = ref(false);
const rail = computed(() => railManual.value || narrow.value);

function toggleRail() {
  railManual.value = !railManual.value;
}

function goWorkbench(key: "overview" | "history") {
  view.value = key;
  activeCmd.value = null;
  void router.replace({ query: key === "history" ? { view: "history" } : {} });
}

function openCommand(item: BiliCatalogItem) {
  view.value = "command";
  activeCmd.value = item;
  // 参数表单由 BiliCommand watch activeCmd 自己重置，这里不碰
  void router.replace({ query: { cmd: item.id } });
}

/**
 * 目录里 kind 型条目（值班设置 / 发动态 / 她看过什么 / 她的札记 / 升级自检）的 argv 是空的，
 * 直接丢进运行器会跑出空命令，所以这里分派到对应的真实界面。
 */
function selectItem(item: BiliCatalogItem) {
  if (item.kind === "duty") {
    handlers.openDutyForFirstAccount();
    return;
  }
  if (item.kind === "seen") {
    goWorkbench("history");
    return;
  }
  if (item.kind === "journal") {
    handlers.openJournalForFirstAccount();
    return;
  }
  if (item.kind === "dynamic") {
    const target = allItems.value.find((entry) => entry.id === "dynamic.post");
    if (target) {
      openCommand(target);
      return;
    }
  }
  openCommand(item);
}

function isCmdActive(id: string) {
  return view.value === "command" && activeCmd.value?.id === id;
}

// ── 命令目录（侧栏「全部命令」） ──────────────────────────
const groups = ref<BiliCatalogGroup[]>([]);
const catalogLoading = ref(true);
const query = ref("");
const openedGroups = ref<string[]>([]);
const searchRef = ref<{ focus?: () => void } | null>(null);

// ── 菜单管理：只影响侧栏显示，命令表本身不动 ──────────────
const MENU_KEY = "yiling-hub:bili-menu";
/**
 * v3：命令表改为读 `bili schema`，新增的命令很多。老配置要合并一次默认隐藏集，
 * 否则升级后侧栏会被 100 多条命令铺满。
 */
const MENU_VERSION = 3;

/**
 * 存「隐藏清单」而不是「显示清单」：
 * 以后 bili CLI 多出来的命令默认可见，用户不用再去勾一次。
 */
const hiddenGroups = ref<string[]>([]);
const hiddenItems = ref<string[]>([]);
/** 已存配置；目录没到位时算不出默认隐藏集，所以读和算是两步 */
let savedMenu: { version: number; hiddenGroups: string[]; hiddenItems: string[] } | null = null;

function defaultHiddenIds(): string[] {
  return groups.value.flatMap((group) => group.items.filter((item) => !item.common).map((item) => item.id));
}

function readMenu() {
  try {
    const raw = localStorage.getItem(MENU_KEY);
    if (!raw) {
      savedMenu = null;
      return;
    }
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== "object") {
      savedMenu = null;
      return;
    }
    const d = data as { version?: unknown; hiddenGroups?: unknown; hiddenItems?: unknown };
    savedMenu = {
      version: typeof d.version === "number" ? d.version : 1,
      hiddenGroups: Array.isArray(d.hiddenGroups) ? d.hiddenGroups.filter((x): x is string => typeof x === "string") : [],
      hiddenItems: Array.isArray(d.hiddenItems) ? d.hiddenItems.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    savedMenu = null;
  }
}

function writeMenu() {
  try {
    localStorage.setItem(
      MENU_KEY,
      JSON.stringify({
        version: MENU_VERSION,
        hiddenGroups: hiddenGroups.value,
        hiddenItems: hiddenItems.value,
      }),
    );
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 目录到手后才调：此时才知道哪些命令带 common 标记 */
function applyMenu() {
  hiddenGroups.value = savedMenu?.hiddenGroups ?? [];
  if (savedMenu?.version === MENU_VERSION) {
    hiddenItems.value = savedMenu.hiddenItems;
    return;
  }
  // 老配置只记了「自己手藏的几条」。不并进默认集的话，升级后侧栏毫无变化。
  hiddenItems.value = [...new Set([...defaultHiddenIds(), ...(savedMenu?.hiddenItems ?? [])])];
  writeMenu();
}

/** 某条命令是否被藏起来（整组隐藏也算） */
function isItemHidden(id: string) {
  if (hiddenItems.value.includes(id)) return true;
  const group = groups.value.find((g) => g.items.some((item) => item.id === id));
  return group ? hiddenGroups.value.includes(group.group) : false;
}

const menuTotal = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0));

/** 侧栏真正渲染的集合：去掉隐藏的分组/命令，空组不留空行 */
const visibleGroups = computed(() =>
  groups.value
    .filter((g) => !hiddenGroups.value.includes(g.group))
    .map((g) => ({ ...g, items: g.items.filter((i) => !hiddenItems.value.includes(i.id)) }))
    .filter((g) => g.items.length > 0),
);
const visibleCount = computed(() => visibleGroups.value.reduce((n, g) => n + g.items.length, 0));
/** 命令目录读出来了，但全被藏了——需要给个能勾回来的入口 */
const menuEmpty = computed(() => !catalogLoading.value && groups.value.length > 0 && visibleCount.value === 0);

/** 管理弹窗：编辑态（draft）在 BiliMenuDialog 内部，这里只管「已保存态」 */
const menuOpen = ref(false);

function openMenuManager() {
  menuOpen.value = true;
}

/** 弹窗保存：写回已保存态 + 落 localStorage；正在看的命令被藏了就退回概览 */
function onMenuSave(next: { hiddenGroups: string[]; hiddenItems: string[] }) {
  hiddenGroups.value = [...next.hiddenGroups];
  hiddenItems.value = [...next.hiddenItems];
  writeMenu();
  menuOpen.value = false;
  // 正在看的命令被藏起来了，退回概览，免得停在一个从侧栏进不去的页面
  if (activeCmd.value && isItemHidden(activeCmd.value.id)) goWorkbench("overview");
  ElMessage.success(`菜单已更新，侧栏显示 ${visibleCount.value} / ${menuTotal.value} 条命令。`);
}

const allItems = computed(() => groups.value.flatMap((g) => g.items));
const totalCmds = computed(() => allItems.value.length);

/** 分组图标：bili 的 9 个组各有语义，全用文件夹会看不出层级。 */
const GROUP_ICON: Record<string, unknown> = {
  刷B站: Promotion,
  账号: User,
  收件箱: MessageBox,
  发现: View,
  视频: VideoPlay,
  评论: ChatDotRound,
  私信: ChatLineRound,
  互动: ChatDotRound,
  动态: ChatLineRound,
  投稿: Upload,
  合集: Collection,
  弹幕: Film,
  转写: Microphone,
  用户: User,
  数据: DataLine,
  系统: Setting,
};
const groupIcon = (name: string) => GROUP_ICON[name] ?? Folder;

async function loadCatalog() {
  catalogLoading.value = true;
  try {
    const data = await $fetch<{ groups: BiliCatalogGroup[] }>("/api/admin/bili/catalog");
    groups.value = data.groups;
    applyMenu();
    // 深链：/bili?cmd=video.watch
    const deepLink = String(route.query.cmd || "");
    if (deepLink) {
      const item = allItems.value.find((entry) => entry.id === deepLink);
      if (item) {
        const group = groups.value.find((g) => g.items.some((entry) => entry.id === deepLink));
        if (group) openedGroups.value = [group.group];
        openCommand(item);
      }
    }
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "无法读取命令目录。"));
  } finally {
    catalogLoading.value = false;
  }
}

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return visibleGroups.value;
  return visibleGroups.value
    .map((g) => ({
      ...g,
      items: g.items.filter((i) =>
        i.label.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        i.argv.join(" ").toLowerCase().includes(q)),
    }))
    .filter((g) => g.items.length > 0);
});

const searching = computed(() => Boolean(query.value.trim()));
function toggleGroup(group: string) {
  openedGroups.value = openedGroups.value.includes(group)
    ? openedGroups.value.filter((x) => x !== group)
    : [...openedGroups.value, group];
}
const isGroupOpen = (group: string) => searching.value || openedGroups.value.includes(group);

function focusSearch(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchRef.value?.focus?.();
  }
}

function onResize() {
  narrow.value = window.innerWidth < 1180;
}

// ── 常用（可取消固定的固定项，存 localStorage） ────────────
const PIN_KEY = "yiling-hub:bili-pins";
const DEFAULT_PINS = ["video.watch", "hot.rank", "feed.inbox", "duty.settings"];

const PIN_LABEL: Record<string, string> = {
  "video.watch": "看懂视频",
  "hot.rank": "排行榜",
  "feed.inbox": "收件箱",
  "duty.settings": "值班设置",
};
const PIN_ICON: Record<string, unknown> = {
  "video.watch": View,
  "hot.rank": TrendCharts,
  "feed.inbox": MessageBox,
  "duty.settings": Setting,
};

function readPins(): string[] {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return [...DEFAULT_PINS];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [...DEFAULT_PINS];
  } catch {
    return [...DEFAULT_PINS];
  }
}

const pinKeys = ref<string[]>([...DEFAULT_PINS]);

function savePins() {
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify(pinKeys.value));
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

/** 只渲染命令表里真的存在、且没被菜单管理藏起来的固定项。 */
const pins = computed(() =>
  pinKeys.value.flatMap((key) => {
    const item = allItems.value.find((i) => i.id === key);
    return item && !isItemHidden(key) ? [{ key, item }] : [];
  }),
);

const pinLabel = (item: BiliCatalogItem) => PIN_LABEL[item.id] ?? item.label;
const pinIcon = (item: BiliCatalogItem) => PIN_ICON[item.id] ?? Star;

function unpin(key: string, event: MouseEvent) {
  event.stopPropagation();
  pinKeys.value = pinKeys.value.filter((x) => x !== key);
  savePins();
}

function restorePins() {
  pinKeys.value = [...DEFAULT_PINS];
  savePins();
}

/** 页面挂载时调一次：读本地配置、绑快捷键、按深链落位、拉命令目录 */
function init() {
  pinKeys.value = readPins();
  readMenu();
  window.addEventListener("keydown", focusSearch);
  window.addEventListener("resize", onResize);
  onResize();
  // 深链：/bili?view=history 直接落在运行记录
  if (route.query.view === "history") view.value = "history";
  void loadCatalog();
}

function dispose() {
  window.removeEventListener("keydown", focusSearch);
  window.removeEventListener("resize", onResize);
}
  return {
    // 视图
    view, activeCmd, rail, railManual, narrow, toggleRail,
    goWorkbench, openCommand, selectItem, isCmdActive,
    // 目录
    groups, catalogLoading, query, searchRef, openedGroups,
    filteredGroups, searching, toggleGroup, isGroupOpen, allItems, totalCmds,
    groupIcon, loadCatalog,
    // 菜单可见性
    hiddenGroups, hiddenItems, menuOpen, menuTotal, visibleCount, menuEmpty,
    openMenuManager, onMenuSave,
    // 常用
    pins, pinLabel, pinIcon, unpin, restorePins,
    // 页面级动作（概览 / 运行记录共用，所以在页面 provide 时挂进来）
    refreshStatus: handlers.refreshStatus,
    // 生命周期
    init, dispose,
  };
}

export function provideBiliDesk(handlers: BiliDeskHandlers): BiliDesk {
  const desk = createDesk(handlers);
  provide(DESK_KEY, desk);
  return desk;
}

/** 子组件用：拿页面 provide 的那一份 */
export function useBiliDesk(): BiliDesk {
  const desk = inject(DESK_KEY, null);
  if (!desk) throw new Error("useBiliDesk() 必须在 <BiliSidebar> 等页面子组件里调用。");
  return desk;
}
