<script setup lang="ts">
/**
 * QQ 渠道（OneBot 小号）。
 *
 * 四块结构，视觉权重从上到下递减：
 * ① 状态条（链路带：全通时压成一行，断了才展开并带修复动作）
 * ② 绑定清单（主工作区，一行一条角色×群，日常调参都在这）
 * ③ 连接管理（地址/进程/设置入口，一张紧凑卡片，设好就不用看）
 * ④ 接入教程（默认收起，一个号都没有时才自动展开）
 * 页面只有两个视觉层：画布 --bg 上铺白砖，砖内用 --surface-2/3 分块，异常才上色。
 * 一个主操作（添加 QQ 小号），卡片上的按钮一律降成文字按钮。
 */
import {
  ArrowRight,
  CopyDocument,
  Delete,
  Download,
  FolderOpened,
  Plus,
  Refresh,
  VideoPlay,
  Warning,
} from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import type { ChainActionKind } from "~/utils/qq-channel";
import type { Character } from "~/utils/mock-data";

useHead({ title: "QQ 渠道 · 忆灵空间" });

type GroupChatSettings = {
  mode: "mention" | "ambient" | "all";
  batchWindowSeconds: number;
  mentionWindowSeconds: number;
  minGapSeconds: number;
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  ambientChance: number;
  aliases: string[];
};

type ChannelBinding = {
  id: string;
  characterId: string;
  characterName: string;
  routingKey: string | null;
  /** 群聊限流窗口（分钟）与窗口内上限；上限 0 = 不限。 */
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  /** 群聊是否仅被 @ 时才回复（后端已回退到连接默认值）。 */
  replyOnlyWhenMentioned: boolean;
  /** 群聊怎么回：模式 + 攒批/闸门参数，后端已解析好默认值。 */
  groupChat: GroupChatSettings;
  /** 按群覆盖的模式：`{ "<群号>": 档位 }`；没在这张表里的群沿 groupChat.mode。 */
  groupChatModes?: Record<string, GroupChatSettings["mode"]>;
  /** 主人能否在群里触发刷一轮 B站（后端已回退到连接默认值）。 */
  groupBiliRunEnabled: boolean;
};
/** 接口回显的明文凭据（管理员页可见）；解不开时为 null。 */
type QqCredentials = {
  wsUrl?: string;
  httpUrl?: string;
  accessToken?: string;
  httpToken?: string;
  /** SnowLuma 网页面板密码，用来在「一键启动」后自动登录配节点。 */
  snowlumaPassword?: string;
};
type QqConnection = {
  id: string; platform: string; displayName: string; appId: string | null; status: string;
  lastEventAt: string | null; createdAt: string; metadata: Record<string, unknown> | null;
  credentials?: QqCredentials | null;
  bindings: ChannelBinding[];
};

const characters = useCharacterList();
await useCharacterListData();

function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

// SSR 阶段带上登录态；这个页面只管 OneBot 小号，B站 连接由值班台自己管。
const request = import.meta.server ? useRequestFetch() : $fetch;
const { data, pending, refresh, error } = await useAsyncData("qq-connections", async () => {
  const response = await request<{ connections: QqConnection[] }>("/api/admin/channels");
  return response.connections.filter((item) => item.platform === "qq-onebot");
});

const connections = computed(() => data.value ?? []);
const loading = computed(() => pending.value);
const hasConnections = computed(() => connections.value.length > 0);
const hasLoadError = computed(() => Boolean(error.value));

/**
 * 链路轨只画一条：网关端口、适配器进程本来就是整台机器共用的一份，
 * 多个号时按第一个号画，其余号的差别只在「有没有绑角色」。
 */
const primaryConnection = computed(() => connections.value[0] ?? null);
const primaryBinding = computed(() => primaryConnection.value?.bindings[0] ?? null);

/**
 * 一张卡对应一条绑定（角色 ↔ 号/群）：群号、群聊回复、限流、刷 B站 都是绑定级，
 * 跟着绑定走；发表情、主动找话是角色级，多绑定时在每张卡里复用（改的是同一个角色）。
 * 角色基本只有一个，所以通常就一张卡。
 */
const boundBindings = computed(() => {
  const result: Array<{ binding: ChannelBinding; connection: QqConnection; character: Character }> = [];
  for (const connection of connections.value) {
    for (const binding of connection.bindings) {
      const character = characters.value.find((item) => item.id === binding.characterId);
      if (character) result.push({ binding, connection, character });
    }
  }
  return result;
});

/**
 * 一行 = 一条绑定（角色 × 号/群）。
 *
 * 为什么按绑定组织而不是按「号」：日常真正要调的是「她在这个群里怎么说话」，
 * 而群号、参与度、限流**本来就在绑定上**。按号铺卡片，这些设置只能塞进号的下面，
 * 一个号绑三个角色时就变成三种展开方式叠在一起 —— 上一版就是这么乱的。
 *
 * 没绑角色的号也占一行：否则那个号在页面上彻底消失，人不知道它还挂着。
 */
type BindRow = {
  key: string;
  connection: QqConnection;
  binding: ChannelBinding | null;
  character: Character | null;
};

const rows = computed<BindRow[]>(() => {
  const result: BindRow[] = [];
  for (const connection of connections.value) {
    if (!connection.bindings.length) {
      result.push({ key: `${connection.id}:unbound`, connection, binding: null, character: null });
      continue;
    }
    for (const binding of connection.bindings) {
      result.push({
        key: binding.id,
        connection,
        binding,
        character: characters.value.find((item) => item.id === binding.characterId) ?? null,
      });
    }
  }
  return result;
});

/** 展开的是哪几行。默认全收着 —— 清单要能一眼扫完，改哪行再展开哪行。 */
const openRows = ref<string[]>([]);
function isRowOpen(key: string) {
  return openRows.value.includes(key);
}
function toggleRow(key: string) {
  openRows.value = isRowOpen(key)
    ? openRows.value.filter((item) => item !== key)
    : [...openRows.value, key];
}

const MODE_LABEL: Record<string, string> = {
  mention: "仅被 @ 时回",
  ambient: "自然接话",
  all: "每条都回",
};

/**
 * 行头的参与度徽标。
 *
 * 按群设过就不能再显示默认档了 —— 一条绑定挂三个群、各设一档时，
 * 显示「自然接话」会让人以为三个群都是这样。具体怎么设的放进 title。
 */
function modeLabelOf(binding: ChannelBinding): string {
  return Object.keys(binding.groupChatModes ?? {}).length
    ? "按群设置"
    : MODE_LABEL[binding.groupChat.mode] ?? "会回复";
}

function modeBadgeTitle(binding: ChannelBinding): string {
  const entries = Object.entries(binding.groupChatModes ?? {});
  if (!entries.length) return "";
  return entries
    .map(([group, mode]) => `${group}：${MODE_LABEL[mode] ?? mode}`)
    .join("；");
}

const boundCount = computed(() => connections.value.reduce((sum, item) => sum + item.bindings.length, 0));
const characterCount = computed(
  () => new Set(boundBindings.value.map((item) => item.binding.characterId)).size,
);

/** 头像位只放一个字，且优先取汉字 —— 名字叫「deepseek鲸鱼娘」时，取到 "d" 很难看 */
function initialOf(name: string) {
  const chars = Array.from(name.trim());
  const cjk = chars.find((char) => /[\u4e00-\u9fa5]/.test(char));
  if (cjk) return cjk;
  const latin = chars.slice(0, 2).join("");
  return latin ? latin.toUpperCase() : "？";
}

/** 行副标题：先说她管哪些群，多号时再补上是谁的号 —— 单号时那半句是噪音 */
function whereOf(row: BindRow) {
  if (!row.binding) return row.connection.appId ? `QQ ${row.connection.appId}` : row.connection.displayName;
  const keys = row.binding.routingKey ? row.binding.routingKey.split(",").map((key) => key.trim()).filter(Boolean) : [];
  const scope = keys.length > 0 ? (keys.length === 1 ? `只在群 ${keys[0]}` : `只在群 ${keys.join("、")}`) : "全部群 + 私聊";
  return connections.value.length > 1 ? `${scope} · ${row.connection.displayName}` : scope;
}

const lede = computed(() => (hasConnections.value
  ? "挂一个小号，让她在群里按场合说话。改哪一行，只影响那一行。"
  : "一个号都还没接进来，先走下面四步。"));

/** 重连请求还没被适配器消费时的那个号：为它留一条常驻提示 */
const reloadingConnection = computed(() => connections.value.find(reloadPending) ?? null);

async function refreshCharacters() {
  await loadCharacters();
}

/** 角色卡里改了绑定级或角色级字段，都回来刷新一次（连接列表 + 角色列表 + 额度）。 */
async function onBehaviorSaved() {
  await refresh();
  await refreshCharacters();
  void loadQuota();
}

// ── 这条链路上的两个进程 ────────────────────────────────
/**
 * SnowLuma（网关本体）+ 适配器（yarn onebot:run）+ 网关端口通不通，一次拿到。
 * 三样分开显示，是因为它们的失败长得一模一样：日志里都是连不上 3001，
 * 但可能是「网关没启动」「网关起了 WS 节点没开」「适配器没起」三件完全不同的事。
 */
type SnowlumaStatus = {
  home: string;
  /** 目录从哪来：saved=页面上填过 env=环境变量 process/scan=自动找到 default=没找到，用的默认值 */
  source: "saved" | "env" | "process" | "scan" | "default";
  /** start.bat 在不在 */
  installed: boolean;
  running: boolean;
  panelPort: number;
};
type RuntimeStatus = {
  adapter: { running: boolean; pid?: number; startedAt?: string };
  snowluma: SnowlumaStatus;
  /** 适配器要连的那个端口通不通；读不到连接配置时为 null */
  gateway: { wsUrl: string; host: string; port: number; reachable: boolean } | null;
  /** 人点过「停止」后自动补起会一直关着，直到再点启动/重连 */
  autostart: { paused: boolean; at?: string };
};

const runtime = ref<RuntimeStatus | null>(null);
const adapterStatus = computed(() => runtime.value?.adapter ?? null);
const snowluma = computed(() => runtime.value?.snowluma ?? null);
const gateway = computed(() => runtime.value?.gateway ?? null);
/** 运行时状态没拿到之前不判断断点，否则首帧会先闪一下「全部灰掉」 */
const runtimeReady = computed(() => runtime.value !== null);

/**
 * 面板密码：单独取一次，**不跟 runtime 轮询一起走**（明文没必要每几秒传一遍）。
 *
 * 为什么非要显示出来：全新安装时这串密码是忆灵空间替 SnowLuma 生成、直接塞进连接凭据的，
 * 用户从头到尾没打过字。不摆在页面上，他就既不知道密码是什么、也没法换成自己记得住的，
 * 只能翻数据库 —— 那等于「我们替他改了个他打不开的门锁」。
 */
type PanelPasswordInfo = {
  password: string | null;
  accountQq: string;
  panelPort: number;
  panelUrl: string;
  snowlumaRunning: boolean;
};
const panelPassword = ref<PanelPasswordInfo | null>(null);
/** 默认摊开：这页在本人电脑上，遮起来反而让「看一眼再复制」多两步。旁边留了「遮住」 */
const panelPasswordVisible = ref(true);

async function loadPanelPassword() {
  try {
    // 只在客户端取：明文密码不该被 SSR 写进页面 HTML（查看源代码就能看到的东西不算「只有管理员可见」）。
    panelPassword.value = await $fetch<PanelPasswordInfo>("/api/admin/channels/onebot/runtime/panel-password");
  } catch {
    panelPassword.value = null;
  }
}

const adapterStarting = ref(false);
const snowlumaStarting = ref(false);
const homeEditing = ref(false);
const homeSaving = ref(false);
const homeDraft = ref("");
let runtimePollTimer: ReturnType<typeof setTimeout> | null = null;

function clockOf(value?: string) {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return ` · 从 ${pad(at.getHours())}:${pad(at.getMinutes())} 起`;
}

const adapterStateText = computed(() => {
  const status = adapterStatus.value;
  if (!status) return "正在检查…";
  if (!status.running) return "未运行";
  return `运行中 · PID ${status.pid}${clockOf(status.startedAt)}`;
});

const snowlumaStateText = computed(() => {
  const status = snowluma.value;
  if (!status) return "正在检查…";
  if (!status.installed) return "没找到程序";
  return status.running ? `已启动 · 面板 ${status.panelPort}` : "未启动";
});

/** 只有「它自己认出来」的才标，用户填的和默认值不用解释 */
const snowlumaSourceLabel = computed(() => {
  switch (snowluma.value?.source) {
    case "process": return "自动找到 · 已运行的进程";
    case "scan": return "自动找到 · 扫出来的";
    case "env": return "来自 SNOWLUMA_HOME";
    default: return "";
  }
});

async function loadRuntime() {
  try {
    runtime.value = await $fetch<RuntimeStatus>("/api/admin/channels/onebot/runtime");
    if (!homeEditing.value) homeDraft.value = runtime.value.snowluma.home;
  } catch {
    runtime.value = null;
  }
  void loadQuota();
}

// ── 她今天还能不能说话 ────────────────────────────────
/**
 * 链路四段全通 ≠ 她会回话。
 *
 * 额度检查在管道深处，额度用完时每条消息都会静默丢弃（返回 daily_quota_exceeded），
 * 群里表现就是「@ 也不回」，而页面上四段全是绿的 —— 2026-10-30 就因此查了半天。
 * 所以这里单独拿一次额度，用尽时在列表上方明说，而不是等人去翻日志。
 */
type QuotaRow = {
  id: string;
  name: string;
  /** 0 = 没设上限（不限额） */
  limit: number;
  used: number;
  remaining: number | null;
  exceeded: boolean;
};
const quotaRows = ref<QuotaRow[]>([]);
const exhaustedQuota = computed(() => quotaRows.value.filter((row) => row.exceeded));
const exhaustedText = computed(() => exhaustedQuota.value
  .map((row) => `${row.name} 已用 ${formatTokens(row.used)}，上限 ${formatTokens(row.limit)}`)
  .join("、"));

async function loadQuota() {
  if (!hasConnections.value) {
    quotaRows.value = [];
    return;
  }
  try {
    const response = await $fetch<{ characters: QuotaRow[] }>("/api/admin/channels/onebot/quota");
    quotaRows.value = response.characters;
  } catch {
    // 额度只是提示，拿不到就不显示，不要因为一行提示把整页变成错误态
    quotaRows.value = [];
  }
}

/** 100000 → 「10 万」、103103 → 「10.3 万」，省得一行里全是数不清的零。 */
function formatTokens(value: number): string {
  if (value < 10_000) return String(value);
  const scaled = value / 10_000;
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)} 万`;
}

/** 点完按钮盯一段时间：起进程要几秒，端口起来才算真的好了 */
async function pollRuntime(deadline: number, ready: () => boolean) {
  await loadRuntime();
  if (ready() || Date.now() > deadline) return;
  runtimePollTimer = setTimeout(() => void pollRuntime(deadline, ready), 1000);
}

function readStatus(error: unknown) {
  return (error as { statusCode?: number }).statusCode;
}

async function startAdapter() {
  if (adapterStarting.value || adapterStatus.value?.running) return;
  adapterStarting.value = true;
  try {
    // 适配器连不上多半是面板里没有对应的节点（或令牌对不上）。
    // 面板已经在跑就顺手对齐一次 —— 这一步失败不影响启动，所以是 quiet。
    if (snowluma.value?.running) await provisionPanel(true);
    const result = await launchAdapter();
    if (!result.ok) {
      ElMessage.error(result.message);
      return;
    }
    if (result.alreadyRunning) {
      ElMessage.info(result.message);
      await loadRuntime();
      return;
    }
    ElMessage.success(result.message);
    void pollRuntime(Date.now() + 10_000, () => adapterStatus.value?.running === true);
  } finally {
    adapterStarting.value = false;
  }
}

/**
 * 等面板端口应答。`pollRuntime` 只排一次检查就返回了，这里要一条能 await 的等待，
 * 因为「启动完立刻配节点」必须等面板真的在听。
 */
async function waitForPanel(deadline: number): Promise<boolean> {
  await loadRuntime();
  if (snowluma.value?.running) return true;
  if (Date.now() > deadline) return false;
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return waitForPanel(deadline);
}

/** 同上，等适配器自己把「我在跑」的标记写出来。 */
async function waitForAdapter(deadline: number): Promise<boolean> {
  await loadRuntime();
  if (adapterStatus.value?.running) return true;
  if (Date.now() > deadline) return false;
  await new Promise((resolve) => setTimeout(resolve, 800));
  return waitForAdapter(deadline);
}

type LaunchResult = { ok: boolean; message: string; alreadyRunning?: boolean };

/**
 * 拉起协议端。已经开着（409）不算失败 —— 一键接通里「它刚好起来了」和「它本来就在」是一样的。
 */
async function launchGateway(): Promise<LaunchResult> {
  try {
    const result = await $fetch<{ message: string }>("/api/admin/channels/onebot/runtime/snowluma", { method: "POST" });
    return { ok: true, message: result.message };
  } catch (error) {
    if (readStatus(error) === 409) {
      return { ok: true, message: readErrorMessage(error, "SnowLuma 已经在运行。"), alreadyRunning: true };
    }
    return { ok: false, message: readErrorMessage(error, "启动 SnowLuma 失败，请手动双击 start.bat。") };
  }
}

/** 拉起适配器；409 同理。 */
async function launchAdapter(): Promise<LaunchResult> {
  try {
    const result = await $fetch<{ message: string }>("/api/admin/channels/onebot/runtime/adapter", { method: "POST" });
    return { ok: true, message: result.message };
  } catch (error) {
    if (readStatus(error) === 409) {
      return { ok: true, message: readErrorMessage(error, "适配器已经在运行。"), alreadyRunning: true };
    }
    return { ok: false, message: readErrorMessage(error, "启动失败，请手动运行 yarn onebot:run。") };
  }
}

type ProvisionResponse = {
  ok: boolean;
  reason?: "no-password" | "unreachable" | "bad-password" | "totp" | "rate-limited" | "error";
  message: string;
  changes: string[];
  warnings: string[];
  uin?: string;
  ports?: { ws: number; http: number };
};

/**
 * 用存下的密码登录面板，把 WS/HTTP 节点对齐成连接里的那份。
 *
 * `quiet` 用在「保存并重新连接」之后：那时保存已经成功了，面板没起来是常态，
 * 不该因为配不上节点再弹一条失败 —— 只有真改了东西才值得说一句。
 *
 * 面板按 IP 数失败次数（5 次锁 15 分钟），所以密码错一次就停手：
 * 再自动试下去是把自己锁在面板外面。改完密码保存时会把闸门放开。
 */
const panelProvisioning = ref(false);
const panelAuthPaused = ref(false);

/** 保存过设置就说明密码可能刚改对，把「别再自动试」的闸门放开一次。 */
function resumePanelAuth() {
  panelAuthPaused.value = false;
}

async function provisionPanel(quiet = false) {
  if (panelProvisioning.value || panelAuthPaused.value) return;
  panelProvisioning.value = true;
  try {
    const result = await $fetch<ProvisionResponse>("/api/admin/channels/onebot/runtime/provision", { method: "POST" });
    for (const warning of result.warnings) ElMessage.warning(warning);
    if (result.ok) {
      if (result.changes.length || !quiet) ElMessage.success(result.message);
    } else {
      if (result.reason === "bad-password" || result.reason === "rate-limited") panelAuthPaused.value = true;
      if (!quiet) ElMessage.warning(result.message);
    }
  } catch (error) {
    if (!quiet) ElMessage.warning(readErrorMessage(error, "自动配节点没成功，可以手动去面板核对。"));
  } finally {
    panelProvisioning.value = false;
  }
}

type HookResponse = {
  ok: boolean;
  /** already=本来就在听；attached=这次挂上了；failed=没挂上 */
  action: "already" | "attached" | "failed";
  message: string;
  /**
   * 失败分类，服务端给的。页面靠它决定「要不要顺手把面板开给用户」：
   * 密码类（no-password / bad-password / totp / rate-limited）和「面板拒绝挂载」，
   * 人只能进面板解决；no-process 开面板也没用（该去 QQ 客户端）。
   */
  reason?: string;
  uin?: string;
  wsPort?: number | null;
  reachable?: boolean;
};

/**
 * 这些原因都意味着「人得进面板」。
 *
 * 挂在模块层而不是写在函数里，是因为判断这段逻辑的是「用户点按钮之后」那条路径 ——
 * 后台自动补起（打开页面时悄悄挂一次）不会走到这里，那种场合弹浏览器窗口会吓人。
 */
const PANEL_NEEDED_REASONS = new Set(["no-password", "bad-password", "totp", "rate-limited", "load-failed"]);

/**
 * 把 QQ 号挂到面板上（注入 hook）。
 *
 * 「面板在跑」和「节点在听」是两件事：面板的 OneBot 节点只在这个号的会话建立之后才 listen，
 * 会话来自注入进 QQ 客户端的 hook。QQ 客户端比面板后启动、或者 QQ 重登过，
 * 这个 hook 就不会自己挂回来 —— 表现是适配器一直刷 `code=1006`，而面板里节点明明配着。
 * 密码已经存在连接凭据里，所以这一步也用同一个密码自动做（面板的 `/api/processes` + `load`）。
 *
 * `quiet` 用在「启动协议端 / 接通链路」里顺带挂的那次：那条流程失败时已经有自己的话要说，
 * 这里再弹一句只会让人不知道先看哪条。
 *
 * 返回值从 boolean 改成 `{ ok, message }`：挂不上的原因有四种（没填面板密码、密码不对、
 * 面板登录被锁、面板里没有这个号的进程），只有调用方把原话带出去，人才知道该改哪一处。
 * 以前只回 boolean，上层只能写死一句「确认这个号正在 QQ 客户端里登录」，最常见的原因
 * （**没填面板密码**，连进程列表都读不到）反而被藏起来了 —— 2026-11-02 就是这么被带偏的。
 */
async function attachHook(quiet = false): Promise<{ ok: boolean; message: string; reason?: string }> {
  try {
    const result = await $fetch<HookResponse>("/api/admin/channels/onebot/runtime/hook", { method: "POST" });
    if (result.ok) {
      if (result.action === "attached" && !quiet) ElMessage.success(result.message);
      return { ok: true, message: result.message, reason: result.reason };
    }
    if (!quiet) ElMessage.warning(result.message);
    return { ok: false, message: result.message, reason: result.reason };
  } catch (error) {
    const message = readErrorMessage(error, "把 QQ 挂上面板没成功，可以去面板里手动挂一次。");
    if (!quiet) ElMessage.warning(message);
    return { ok: false, message };
  }
}

/**
 * 把 SnowLuma 面板开在浏览器里。
 *
 * 只在「用户点了按钮、而且这条链自己修不动」时调用（见 PANEL_NEEDED_REASONS）：
 * 密码没填 / 填错这类事，人总得进面板把密码拿出来或改掉，替他开一下比让他
 * 自己在地址栏敲 127.0.0.1:5099 省事。
 *
 * `window.open` 在一串 await 之后容易被浏览器当广告拦掉 —— 拦住了就退回把地址说出来，
 * 不能因为弹窗被拦就让人以为没事发生。
 */
function openPanel() {
  const url = snowluma.value ? `http://127.0.0.1:${snowluma.value.panelPort}` : PROXY.panel;
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) ElMessage.info(`面板地址：${url}（浏览器拦了自动开窗，手动打开一下）`);
  return url;
}

async function startSnowluma() {
  if (snowlumaStarting.value || snowluma.value?.running) return;
  snowlumaStarting.value = true;
  try {
    const result = await $fetch<{ message: string; panelPassword?: string | null }>(
      "/api/admin/channels/onebot/runtime/snowluma",
      { method: "POST" },
    );
    ElMessage.success(result.message);
    /*
     * 刚接管的密码当场摊开：它只在这一刻存在于响应里（库里另存一份），
     * 人要是没看见，下次想知道就得翻凭据。所以先刷新展示块，再单独提一句去哪儿看。
     */
    if (result.panelPassword) {
      panelPasswordVisible.value = true;
      ElMessage.info(`面板密码：${result.panelPassword}（已显示在上方，可直接复制）`);
    }
    void loadPanelPassword();
    // 它要加载 QQ 客户端钩子，比适配器慢，给 40 秒
    snowlumaStarting.value = false;
    const up = await waitForPanel(Date.now() + 40_000);
    if (!up) {
      ElMessage.warning("40 秒内面板还没应答，看一眼 SnowLuma 目录里 runtime.log 的最后几行。");
      return;
    }
    // 面板一起来就把节点对齐：这一步以前要人肉登录面板做，而密码忘了就彻底卡住。
    await provisionPanel();
    // 对齐完还得把这个号挂上去 —— 节点只在会话建立后才 listen。QQ 客户端先于面板启动时，
    // hook 不会自己挂，不补这一步就会出现「节点明明配着、3001 却没人听」。
    await attachHook();
  } catch (error) {
    if (readStatus(error) === 409) {
      ElMessage.info(readErrorMessage(error, "SnowLuma 已经在运行。"));
      await loadRuntime();
      void loadPanelPassword();
      // 已经在跑也算「一键」的结果：节点没配对的话适配器照样连不上。
      await provisionPanel(true);
      await attachHook(true);
    } else {
      ElMessage.error(readErrorMessage(error, "启动失败，请手动双击 start.bat。"));
    }
  } finally {
    snowlumaStarting.value = false;
  }
}

function toggleHomeEdit() {
  homeEditing.value = !homeEditing.value;
  if (homeEditing.value && runtime.value) homeDraft.value = runtime.value.snowluma.home;
}

/** 刚装完没被扫到的时候再试一次：失败不进缓存，重拉就会重新找 */
async function rescanSnowluma() {
  await loadRuntime();
  if (snowluma.value && !snowluma.value.installed) {
    ElMessage.info("还是没找到，把目录手动填进来吧。");
  }
}

async function saveHome() {
  if (homeSaving.value) return;
  homeSaving.value = true;
  try {
    await $fetch("/api/admin/channels/onebot/runtime/snowluma", {
      method: "PUT",
      body: { home: homeDraft.value },
    });
    ElMessage.success("目录已记住。");
    homeEditing.value = false;
    await loadRuntime();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "这个目录用不了，看看里面有没有 start.bat。"));
  } finally {
    homeSaving.value = false;
  }
}

/**
 * 链路轨上只有一个修复动作，按断点分派到已有的处理函数 —— 不另开一套启动逻辑，
 * 免得「从轨道启动」和「从第 4 步启动」将来跑出两种行为。
 */
function onChainAction(kind: ChainActionKind) {
  const connection = primaryConnection.value;
  switch (kind) {
    case "start-gateway":
      void startSnowluma();
      break;
    case "start-adapter":
      void startAdapter();
      break;
    case "bind-character":
      if (connection) openBind(connection);
      break;
    case "edit-connection":
      if (connection) void openEdit(connection);
      break;
    case "reconnect":
      if (connection) void reconnectConnection(connection);
      break;
    case "stop":
      void stopChain();
      break;
    case "open-steps":
      scrollToSteps();
      break;
  }
}

/** 「没找到程序 / 小号掉线 / 排查指南」没有一键解法，展开教程并滚过去让人照着做 */
function scrollToSteps() {
  if (import.meta.server) return;
  const el = document.getElementById("qq-steps");
  if (!el) return;
  // 教程有号之后默认收着：不先展开就滚，人到了也只看得到一行标题
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * 打开页面时问一句「链路齐了吗」。
 *
 * server 启动时后端已经补过一次（`server/plugins/onebot-autostart.ts`），这里兜的是运行期间掉的：
 * 适配器崩了、进程被手动杀了、SnowLuma 跟着 QQ 客户端一起没了。点过「停止」的话服务端会直接跳过，
 * 不会出现「我明明关了它又自己回来」。
 */
async function ensureStack() {
  if (import.meta.server) return;
  try {
    const result = await $fetch<{ action: string; message: string; steps: string[] }>(
      "/api/admin/channels/onebot/runtime/ensure",
      { method: "POST" },
    );
    if (result.action === "started") {
      ElMessage.success(result.message);
      await loadRuntime();
      // 自动补起也可能顺手接管了面板密码（首次运行时），刷新一下展示块
      void loadPanelPassword();
    } else if (result.action === "starting") {
      // 服务端还在等 SnowLuma 起来，先给一句话，别让人以为页面没反应
      ElMessage.info(result.message);
      await loadRuntime();
      void loadPanelPassword();
    }
  } catch {
    // 补不起来不影响看页面：链路带本来就会指出断在哪一段
  }
}

watch(error, (value) => {
  if (value) ElMessage.error(readErrorMessage(value, "无法读取渠道连接。"));
});

onMounted(() => {
  void loadRuntime();
  void loadPanelPassword();
  void ensureStack();
});
onBeforeUnmount(() => {
  if (runtimePollTimer) clearTimeout(runtimePollTimer);
});

/**
 * 协议端只用 SnowLuma：自带网页面板（不用另装面板）、挂在本机已登录的 QQNT 客户端上。
 * 只有一种方案，就不需要「二选一」的选择器和它那套 tagline —— 直接落到唯一那份配置说明。
 */
type ProxyGuide = {
  name: string;
  repo: string;
  /** 配置 OneBot 的那个页面地址，不是面板首页。 */
  panel: string;
  /** 面板内按顺序完成的配置动作。 */
  steps: { title: string; detail: string }[];
  /** 最容易踩的那一处，单独高亮。 */
  warn: string;
};

const PROXY: ProxyGuide = {
  name: "SnowLuma",
  repo: "https://github.com/SnowLuma/SnowLuma/releases",
  panel: "http://127.0.0.1:5099/config",
  steps: [
    { title: "打开面板并登录", detail: "面板在 127.0.0.1:5099，密码明写在上方「连接管理」里那行「面板密码」（点「复制」即可；全新安装时由忆灵空间生成，自动配节点和挂 QQ 都用它）。在面板里改了密码，要回「连接设置 → SnowLuma 面板密码」同步一次。登录后在左侧选中 QQ 小号。" },
    { title: "配置 WebSocket 服务端", detail: "切到「WS 服务端」。已有 3001 节点就直接使用；没有再新建，端口填 3001。" },
    { title: "配置 HTTP API", detail: "切到「HTTP API」。已有节点就把端口改为 3002；没有再新建。不要用 3000。" },
    { title: "分别复制两个 Token", detail: "复制 WS 节点和 HTTP 节点的授权 Token，分别填到 QQ 渠道的对应输入框。" },
    { title: "保存并重启 SnowLuma", detail: "WS 与 HTTP 的 Token 可能不同，不要填反。" },
  ],
  warn: "面板地址固定为 http://127.0.0.1:5099/config。面板密码只有一处真相：连接设置里那格「SnowLuma 面板密码」（上方「连接管理」里那行「面板密码」显示的就是它）——你在面板里改了密码必须回来同步，否则自动配节点 / 自动挂 QQ 会报「面板密码不对」。已有同端口节点时请修改或复用，不要重复创建。",
};

// ── 添加 / 编辑 ─────────────────────────────────────────────
const editVisible = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);
/** 正在编辑的是哪个号：「删除这个号」必须删它，不能默认删第一个 */
const editingTarget = ref<QqConnection | null>(null);
/** 点开「连接设置」后要单独取一次明文凭据，取回来之前别让人往空框里打字（会被回填覆盖）。 */
const credLoading = ref(false);
const form = reactive({
  qqNumber: "",
  displayName: "",
  wsUrl: "",
  httpUrl: "",
  accessToken: "",
  httpToken: "",
  snowlumaPassword: "",
  groupAnnouncementEnabled: false,
  ownerQq: "",
  ownerName: "",
});

function resetForm() {
  form.qqNumber = "";
  form.displayName = "";
  form.wsUrl = "";
  form.httpUrl = "";
  form.accessToken = "";
  form.httpToken = "";
  form.snowlumaPassword = "";
  form.groupAnnouncementEnabled = false;
  form.ownerQq = "";
  form.ownerName = "";
}

function openCreate() {
  editingId.value = null;
  editingTarget.value = null;
  credLoading.value = false;
  resetForm();
  editVisible.value = true;
}

function fillDefaultUrls() {
  if (!form.wsUrl.trim()) form.wsUrl = "ws://127.0.0.1:3001";
  if (!form.httpUrl.trim()) form.httpUrl = "http://127.0.0.1:3002";
}

/**
 * 打开「连接设置」。必须 async —— 里面要单独取一次明文凭据（列表不带着下发）。
 * 之前漏了 async，`await` 在非 async 函数里是语法错误，整个 SFC 编译失败，页面直接打不开。
 */
async function openEdit(connection: QqConnection) {
  editingId.value = connection.id;
  editingTarget.value = connection;
  resetForm();
  form.qqNumber = connection.appId || "";
  form.displayName = connection.appId ? connection.displayName : "";
  form.groupAnnouncementEnabled = connection.metadata?.groupAnnouncementEnabled === true;
  form.ownerQq = typeof connection.metadata?.ownerQq === "string" ? connection.metadata.ownerQq : "";
  form.ownerName = typeof connection.metadata?.ownerName === "string" ? connection.metadata.ownerName : "";
  editVisible.value = true;

  /**
   * 明文凭据不跟着列表下发（SSR 会把它写进页面 HTML），打开弹窗时才单独取一次。
   * 取失败就保持空 —— 留空保存 = 沿用原值，不会把 token 清掉。
   */
  credLoading.value = true;
  try {
    const detail = await request<{ connections: QqConnection[] }>("/api/admin/channels?withCredentials=1");
    const found = detail.connections.find((item) => item.id === connection.id);
    form.wsUrl = found?.credentials?.wsUrl ?? "";
    form.httpUrl = found?.credentials?.httpUrl ?? "";
    form.accessToken = found?.credentials?.accessToken ?? "";
    form.httpToken = found?.credentials?.httpToken ?? "";
    form.snowlumaPassword = found?.credentials?.snowlumaPassword ?? "";
  } catch {
    // 忽略：列表还在，表单留空也能保存。
  } finally {
    credLoading.value = false;
  }
}

function reloadPending(connection: QqConnection) {
  const requested = connection.metadata?.onebotReloadRequestedAt;
  return typeof requested === "string" && requested !== connection.metadata?.onebotReloadAppliedAt;
}

/**
 * 提交重连请求后自动盯一会儿：适配器通常一两秒就重连完，但页面不会自己变 ——
 * 人只能在中间态（未连接 / 重连中）点刷新，正好看到「连接异常」那一帧，像是坏了。
 */
const reloadPolling = ref(false);
let reloadPollTimer: ReturnType<typeof setTimeout> | null = null;

function stopReloadPolling() {
  if (reloadPollTimer) {
    clearTimeout(reloadPollTimer);
    reloadPollTimer = null;
  }
  reloadPolling.value = false;
}

async function pollReload(deadline: number) {
  if (Date.now() > deadline) {
    stopReloadPolling();
    // 15 秒还没被适配器消费，多半是适配器已经不在了 —— 这时候点「重连」比让人去开终端快
    if (connections.value.some(reloadPending)) {
      ElMessage.warning("适配器一直没响应重连请求，点上面的「重连」让它重新起来。");
    }
    return;
  }
  if (!connections.value.some(reloadPending)) {
    stopReloadPolling();
    return;
  }
  reloadPollTimer = setTimeout(async () => {
    try {
      await refresh();
    } catch {
      // 这一轮读失败就等下一轮，别把人从轮询里踢出去
    }
    void pollReload(deadline);
  }, 1500);
}

function startReloadPolling() {
  if (import.meta.server) return;
  stopReloadPolling();
  reloadPolling.value = true;
  void pollReload(Date.now() + 15000);
}

/**
 * 「重连」= 把这条链路一键接通，而不是只丢一个 reload 包。
 *
 * 2026-10-30 的教训：SnowLuma 和适配器都被关掉之后点重连，页面只回一句「去启动 SnowLuma」——
 * 那段话本来就该由按钮自己去做。现在按链路顺序过一遍：协议端没跑就启动 → 节点没对齐就对齐 →
 * 适配器没跑就启动、在跑就让它重连。断在哪一段，就只修那一段，别的不动。
 */
const reconnecting = ref(false);
/** 接通进度：链路有几步就报几步，全在一条常驻提示里，不刷屏。 */
const connecting = ref(false);
const connectStep = ref("");

async function reconnectConnection(connection: QqConnection) {
  if (reconnecting.value || stopping.value) return;
  reconnecting.value = true;
  connecting.value = true;
  try {
    connectStep.value = "检查链路状态…";
    await loadRuntime();

    // ① 协议端：没在跑就拉起来。它起不来，后面两步都没有意义。
    if (!snowluma.value?.running) {
      connectStep.value = "协议端没在跑，正在启动 SnowLuma…";
      const launched = await launchGateway();
      if (!launched.ok) {
        ElMessage.error(launched.message);
        return;
      }
      connectStep.value = "等 SnowLuma 面板应答（最多 40 秒）…";
      if (!(await waitForPanel(Date.now() + 40_000))) {
        ElMessage.error("SnowLuma 40 秒内没起来。它挂在 QQ 客户端上 —— 先确认 QQ 已经登录，再看 SnowLuma 目录里 runtime.log 的最后几行。");
        return;
      }
    }

    // ② 节点：面板在跑就把 WS/HTTP 对齐，不然适配器连的端口根本没人听。
    connectStep.value = "对齐协议端节点…";
    await provisionPanel(true);

    // ③ QQ 会话：节点配好 ≠ 端口在听。QQ 客户端后启动 / 重登过时 hook 没挂上，
    //    面板只有 WebUI、3001 一个都不 listen —— 这正是「适配器一直在重试 code=1006」的样子。
    await loadRuntime();
    if (!gateway.value?.reachable) {
      connectStep.value = "把 QQ 挂到协议端…";
      const hooked = await attachHook(true);
      if (!hooked.ok) {
        // 原话照搬服务端的原因：没填面板密码 / 密码不对 / 面板里没有这个号的进程
        // 三种要改的地方完全不同，写死一句「确认 QQ 已登录」只会把人往错的方向带。
        ElMessage.error(`QQ 没挂上面板（3001 上不会有节点）：${hooked.message}`);
        // 密码类 / 面板拒绝挂载：人只能进面板解决，顺手替他开出来
        if (hooked.reason && PANEL_NEEDED_REASONS.has(hooked.reason)) openPanel();
        return;
      }
    }

    // ④ 适配器：没在跑就启动（新进程会自己读最新配置）；已经在跑就让它重连一次。
    if (!adapterStatus.value?.running) {
      connectStep.value = "适配器没在跑，正在启动…";
      const launched = await launchAdapter();
      if (!launched.ok) {
        ElMessage.error(launched.message);
        return;
      }
      connectStep.value = "等适配器连上网关…";
      if (!(await waitForAdapter(Date.now() + 20_000))) {
        ElMessage.warning("适配器起来了但没连上网关，看一眼它的窗口报什么错（常见是 3001 没人监听）。");
        return;
      }
    } else {
      connectStep.value = "让适配器重新连接…";
      await $fetch(`/api/admin/channels/${encodeURIComponent(connection.id)}/reload`, { method: "POST" });
      startReloadPolling();
    }

    connectStep.value = "收尾…";
    await loadRuntime();
    await refresh();
    ElMessage.success("链路已接通。");
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "接通失败，看一眼上面的链路带断在哪一段。"));
  } finally {
    reconnecting.value = false;
    connecting.value = false;
    connectStep.value = "";
  }
}

onBeforeUnmount(stopReloadPolling);

/**
 * 「停止」= 把这两条本机进程收掉。
 *
 * 必须由服务端按 pid 树去收，不能只让用户关窗口：点一次启动会在 nuxt 底下套出
 * `cmd /k yarn` → `yarn` → `cmd /c tsx` → `node` 四层，关掉看得见的那个窗口，
 * 残留的是哪一层用户根本分不出来 —— 表现就是「明明关了，刷新还说在跑」。
 *
 * 一次请求停两条（不是这儿连发两个），见 `runtime/stop.post.ts` 里的说明。
 */
const stopping = ref(false);

async function stopChain() {
  // 和「重连」互斥：一边在拉进程一边在收进程，收尾状态必然对不上
  if (stopping.value || reconnecting.value) return;
  stopping.value = true;
  connecting.value = true;
  try {
    connectStep.value = "停止适配器和协议端…";
    const result = await $fetch<{ stopped: boolean; message: string }>(
      "/api/admin/channels/onebot/runtime/stop",
      { method: "POST" },
    );

    connectStep.value = "收尾…";
    // taskkill 是同步的，但端口真正释放、页面探活反映过来还要几百毫秒。
    // 不等这一下，刚停完的页面会继续显示「运行中」，人以为停止没生效又点一次。
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await loadRuntime();
      if (!adapterStatus.value?.running && !snowluma.value?.running) break;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    await refresh();
    ElMessage.success(result.message);
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "停止失败，可以到任务管理器结束 node 进程。"));
  } finally {
    stopping.value = false;
    connecting.value = false;
    connectStep.value = "";
  }
}

async function submitConnection(reconnect = false) {
  if (saving.value) return;
  if (!form.qqNumber.trim()) {
    ElMessage.warning("请填写 QQ 号。");
    return;
  }
  saving.value = true;
  try {
    const saved = await $fetch<{ id: string }>("/api/admin/channels", {
      method: "POST",
      body: {
        platform: "qq-onebot",
        qqNumber: form.qqNumber.trim(),
        displayName: form.displayName.trim(),
        wsUrl: form.wsUrl.trim(),
        httpUrl: form.httpUrl.trim(),
        accessToken: form.accessToken,
        httpToken: form.httpToken,
        snowlumaPassword: form.snowlumaPassword,
        groupAnnouncementEnabled: form.groupAnnouncementEnabled,
        ownerQq: form.ownerQq.trim(),
        ownerName: form.ownerName.trim(),
      },
    });
    if (reconnect) {
      try {
        await $fetch(`/api/admin/channels/${encodeURIComponent(saved.id)}/reload`, { method: "POST" });
        ElMessage.success("设置已保存，重新连接请求已提交。请查看连接卡片的处理状态。");
      } catch (reloadError) {
        ElMessage.warning(readErrorMessage(reloadError, "设置已保存，但重新连接请求失败，请稍后重试。"));
      }
    } else {
      ElMessage.success("设置已保存。运行中的新版 QQ 适配器会自动读取新设置。");
    }
    editVisible.value = false;
    await refresh();
    // 这一格里可能刚改过面板密码，上方展示块跟它读的是同一份凭据，顺手对齐。
    void loadPanelPassword();
    if (reconnect) startReloadPolling();
    // 改了地址/Token 之后，面板那边也得跟着改，否则两边对不上、适配器照样连不上。
    // 面板没在跑时 provision 会 409，quiet 模式直接咽下去 —— 保存本身已经成功了。
    resumePanelAuth();
    if (snowluma.value?.running) void provisionPanel(true);
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "保存失败，请稍后重试。"));
  } finally {
    saving.value = false;
  }
}

// ── 绑定角色 ───────────────────────────────────────────────
const bindVisible = ref(false);
const bindSaving = ref(false);
const bindTarget = ref<QqConnection | null>(null);
const bindForm = reactive({ characterId: "", routingKeys: [] as string[] });

/**
 * 已经绑在这个号上的角色。
 *
 * 后端是 upsert：同一个角色再绑一次只会把原记录原样写回去，列表看不出任何变化，
 * 却在按钮上回一句「绑定成功」—— 这句成功完全是误导。所以这里直接把已绑定的角色
 * 在选项里标出来并禁掉，群号要改就去清单里展开那一行改，不走这个弹窗。
 */
const boundCharacterIds = computed(
  () => new Set((bindTarget.value?.bindings ?? []).map((item) => item.characterId)),
);
/** 角色全都在这个号上了：弹窗里一个能选的都没有，得说清楚该去哪改。 */
const allCharactersBound = computed(
  () => characters.value.length > 0 && characters.value.every((item) => boundCharacterIds.value.has(item.id)),
);

function openBind(connection: QqConnection) {
  bindTarget.value = connection;
  bindForm.characterId = "";
  bindForm.routingKeys = [];
  bindVisible.value = true;
}

async function submitBind() {
  if (bindSaving.value || !bindTarget.value) return;
  if (!bindForm.characterId) {
    ElMessage.warning("请选择要绑定的角色。");
    return;
  }
  // 列表可能有延迟：选项禁用了，这里再挡一次，别真发一个什么都没改的请求。
  if (boundCharacterIds.value.has(bindForm.characterId)) {
    ElMessage.warning("该角色已绑定这个号了，不用重复绑定。");
    return;
  }
  bindSaving.value = true;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(bindTarget.value.id)}/bindings`, {
      method: "POST",
      body: {
        characterId: bindForm.characterId,
        routingKey: bindForm.routingKeys.join(","),
      },
    });
    ElMessage.success("角色已绑定。");
    bindVisible.value = false;
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "绑定失败，请稍后重试。"));
  } finally {
    bindSaving.value = false;
  }
}

async function unbind(connection: QqConnection, binding: ChannelBinding) {
  const confirmed = await ElMessageBox.confirm(
    `解除「${binding.characterName}」与「${connection.displayName}」的绑定？`,
    "解除绑定",
    { confirmButtonText: "解绑", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(
      `/api/admin/channels/${encodeURIComponent(connection.id)}/bindings/${encodeURIComponent(binding.id)}`,
      { method: "DELETE" },
    );
    ElMessage.success("已解绑。");
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "解绑失败，请稍后重试。"));
  }
}

async function removeConnection(connection: QqConnection) {
  const confirmed = await ElMessageBox.confirm(
    `删除后「${connection.displayName}」及其绑定都会移除，确定？`,
    "删除连接",
    { confirmButtonText: "删除", cancelButtonText: "取消", type: "warning" },
  ).catch(() => false);
  if (!confirmed) return;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(connection.id)}`, { method: "DELETE" });
    ElMessage.success("已删除。");
    // 号没了，弹窗里那些字段就没有对象了；关掉再刷新，别留一个悬空的表单
    editVisible.value = false;
    await refresh();
  } catch (error) {
    ElMessage.error(readErrorMessage(error, "删除失败，请稍后重试。"));
  }
}

async function copyText(text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(successMessage);
  } catch {
    ElMessage.warning("复制失败，请手动选中。");
  }
}

function copyCommand(command: string) {
  return copyText(command, "命令已复制。");
}

function copyInstallGuide() {
  const panelSteps = PROXY.steps
    .map((step, index) => `${index + 1}. ${step.title}：${step.detail}`)
    .join("\n");
  const prompt = [
    `请一步一步帮我在 Windows 上安装并配置 ${PROXY.name}，让它通过 OneBot v11 连接到本机 yiling-space。`,
    "请先询问并检查我电脑上的 QQ 版本、协议端是否已安装和项目运行状态；每次只指导一个阶段，用简单中文说明需要做什么、在哪里操作、完成后如何确认。",
    `官方发布页：${PROXY.repo}`,
    `管理面板：${PROXY.panel}`,
    "配置目标：正向 WebSocket 服务端端口 3001；HTTP API 端口 3002（不要使用 3000）；按协议端要求配置 Token。",
    `面板配置要点：\n${panelSteps}`,
    "之后指导我在 yiling-space 的 QQ 渠道添加 QQ 小号，地址使用 ws://127.0.0.1:3001 和 http://127.0.0.1:3002，绑定一个角色，再运行 yarn onebot:run。以出现 onebot-connected 并完成一条收发测试作为验收。",
    "安全要求：只使用上面的官方发布页，不下载来历不明的软件；不要替我登录 QQ、处理扫码/验证码或绕过安全提示；不要要求我把 QQ 密码、验证码、WS/HTTP Token、API Key 发给你。需要输入凭据时告诉我在本机哪个页面自行填写；运行命令、安装软件或修改配置前先解释影响并等我确认。",
  ].join("\n\n");
  return copyText(prompt, "AI 安装教程已复制。");
}
</script>

<template>
  <div class="page-wrap qq-a">
    <PageHeader
      eyebrow="系统管理 / QQ 渠道"
      title="QQ 渠道"
      :description="lede"
    >
      <!-- 空态时页头不给主操作：同一个动作在屏幕上出现两次会分散注意力 -->
      <template
        v-if="hasConnections"
        #actions
      >
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="refresh()"
        >
          <el-icon><Refresh /></el-icon>刷新
        </button>
        <button
          type="button"
          class="btn primary"
          @click="openCreate"
        >
          <el-icon><Plus /></el-icon>添加 QQ 小号
        </button>
      </template>
    </PageHeader>

    <template v-if="hasConnections">
      <!-- 链路带：一条带子 + 右端一句结论；断的时候下面多一条断点条 -->
      <QqChannelChain
        v-if="primaryConnection"
        :connection="primaryConnection"
        :binding="primaryBinding"
        :adapter="adapterStatus"
        :snowluma="snowluma"
        :gateway="gateway"
        :ready="runtimeReady"
        :panel-url="PROXY.panel"
        @action="onChainAction"
      />

      <!-- 一键接通的进度：按链路顺序报「现在在做哪一步」，比一条条弹提示安静 -->
      <div
        v-if="connecting"
        class="reloadbar"
        role="status"
      >
        <b>{{ stopping ? "正在停止" : "正在接通" }}</b>
        <p>{{ connectStep }}</p>
      </div>

      <!-- 点过「停止」之后，自动补起是关着的：链路断着也不会自己回来。
           不把这句话亮出来，用户只会以为「自动补起坏了」。 -->
      <div
        v-if="runtime?.autostart?.paused && !connecting"
        class="reloadbar is-paused"
        role="status"
      >
        <b>已停止，不会自动重启</b>
        <p>你点过「停止」，所以链路断了也不会自己补起来。想恢复就点上面的「重连」—— 它会先把停止开关解掉，再补齐协议端和适配器。</p>
      </div>

      <!-- 只在等适配器重连时出现：平时这行不该占版面 -->
      <div
        v-if="reloadingConnection && !connecting"
        class="reloadbar"
        role="status"
      >
        <b>{{ reloadPending(reloadingConnection) ? "等待适配器重新连接" : "适配器已按新设置连接过网关" }}</b>
        <p>
          {{ reloadPending(reloadingConnection)
            ? (reloadPolling
              ? "正在自动刷新（每 1.5 秒），一般一两秒就完成。若 15 秒还停在这里，点上面的「重连」—— 协议端和适配器它会自己补齐。"
              : "点「刷新」查看结果。一直卡住就点上面的「重连」，不用再手动去开进程。")
            : "实际是否连通看上面那条带子；历史重连完成不代表此刻在线。" }}
        </p>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="refresh()"
        >
          刷新
        </button>
      </div>

      <!-- 额度用完时链路依然是「四段全通」，但她一个字都不会回：必须明说，否则又只能靠猜 -->
      <div
        v-if="exhaustedQuota.length"
        class="limitbar"
        role="alert"
      >
        <b>今天的模型额度用完了</b>
        <p>{{ exhaustedText }}。额度耗尽后群消息会被静默丢弃 —— 包括 @ 她，所以看起来像「不理人」。北京时间 0 点自动重置。</p>
        <NuxtLink
          v-if="exhaustedQuota.length === 1"
          class="btn"
          :to="`/characters/${exhaustedQuota[0]!.id}/settings/model`"
        >
          调高上限
        </NuxtLink>
      </div>

      <div class="list-head">
        <h2>她在哪些群里说话</h2>
        <span class="count">{{ characterCount }} 个角色 · {{ boundCount }} 处</span>
        <button
          v-if="primaryConnection"
          type="button"
          class="btn quiet"
          @click="openBind(primaryConnection)"
        >
          <el-icon><Plus /></el-icon>加一条
        </button>
      </div>

      <div class="rows">
        <article
          v-for="row in rows"
          :key="row.key"
          class="row"
          :class="{ 'is-open': isRowOpen(row.key) }"
        >
          <button
            type="button"
            class="row-main"
            :aria-expanded="isRowOpen(row.key)"
            @click="toggleRow(row.key)"
          >
            <span
              class="ava"
              aria-hidden="true"
            >{{ row.character ? initialOf(row.character.name) : "？" }}</span>
            <span class="who">
              <b>{{ row.character?.name ?? "还没绑角色" }}</b>
              <!-- 群/私聊范围与参与度说的是同一件事「她在哪、怎么接」，放一行读完；
                   分开放时徽标会漂在整条行头的中间，视线要来回跳。 -->
              <span class="who-sub">
                <span class="where">{{ whereOf(row) }}</span>
                <span
                  v-if="row.binding"
                  class="mode"
                  :class="{ 'is-ambient': row.binding.groupChat.mode === 'ambient' }"
                  :title="modeBadgeTitle(row.binding)"
                >{{ modeLabelOf(row.binding) }}</span>
                <span
                  v-else
                  class="mode is-todo"
                >消息进来没人接</span>
              </span>
            </span>
            <span class="quota">
              <template v-if="row.binding">
                <b>{{ row.binding.groupChat.dailyMax || "不限" }}</b>
                <template v-if="row.binding.groupChat.dailyMax"> 句/天</template>
              </template>
            </span>
            <el-icon class="caret">
              <ArrowRight />
            </el-icon>
          </button>

          <div class="row-body">
            <QqCharacterBehavior
              v-if="row.binding && row.character"
              :character-id="row.character.id"
              :connection-id="row.connection.id"
              :routing-key="row.binding.routingKey"
              :reply-window-minutes="row.binding.replyWindowMinutes"
              :reply-limit-per-window="row.binding.replyLimitPerWindow"
              :reply-only-when-mentioned="row.binding.replyOnlyWhenMentioned"
              :group-chat="row.binding.groupChat"
              :group-chat-modes="row.binding.groupChatModes"
              :group-bili-run-enabled="row.binding.groupBiliRunEnabled"
              :emoji-enabled="row.character.emojiEnabled === true"
              :emoji-window-minutes="row.character.emojiWindowMinutes"
              :emoji-per-window="row.character.emojiPerWindow"
              :image-understanding="row.character.imageUnderstanding === true"
              :sticker-auto-collect="row.character.stickerAutoCollect === true"
              :catchphrase-auto-mine="row.character.catchphraseAutoMine === true"
              :voice-enabled="row.character.voiceEnabled === true"
              :voice-transcribe="row.character.voiceTranscribe === true"
              :voice-chance="row.character.voiceChance ?? 0"
              :voice-cooldown-minutes="row.character.voiceCooldownMinutes ?? 20"
              :proactive="row.character.proactive"
              :group-initiative="row.character.groupInitiative"
              @saved="onBehaviorSaved"
            >
              <template #actions>
                <button
                  type="button"
                  class="btn quiet is-danger"
                  @click="unbind(row.connection, row.binding)"
                >
                  解绑
                </button>
              </template>
            </QqCharacterBehavior>

            <div
              v-else
              class="row-blank"
            >
              <p>
                {{ row.character
                  ? "这条绑定指向的角色已经不在了（可能被删掉），解绑后重新绑一个。"
                  : "号通了，但消息进来没有角色接。" }}
              </p>
              <button
                type="button"
                class="btn primary"
                @click="openBind(row.connection)"
              >
                <el-icon><Plus /></el-icon>绑定角色
              </button>
              <button
                v-if="row.binding"
                type="button"
                class="btn quiet is-danger"
                @click="unbind(row.connection, row.binding)"
              >
                解绑
              </button>
            </div>
          </div>
        </article>
      </div>

      <!-- 第 3 块：连接管理。地址、进程、设置入口收进一张紧凑卡片 ——
           设好之后几个月不用看，所以压在清单下面；但要用时不该进教程里翻。 -->
      <section
        v-if="primaryConnection"
        class="admin"
        aria-label="连接管理"
      >
        <div class="admin-h">
          <h2>连接管理</h2>
          <span class="admin-sub">地址和进程都在这，设好之后这里基本不用动</span>
        </div>
        <div class="admin-chips">
          <span class="chip">QQ <b class="is-mono">{{ primaryConnection.appId || "未填" }}</b></span>
          <span
            v-if="gateway"
            class="chip"
          >网关 <b class="is-mono">{{ gateway.host }}:{{ gateway.port }}</b></span>
          <a
            class="chip is-link"
            :href="PROXY.panel"
            target="_blank"
            rel="noopener noreferrer"
          >面板 <b class="is-mono">{{ PROXY.panel.replace("http://", "") }}</b></a>
        </div>
        <!-- 面板密码明写在这里：它是忆灵空间装 SnowLuma 时替人生成的，只存在于连接凭据里。
             不写出来，用户既不知道密码是什么、也没法换成自己记得住的 —— 等于替他换了把打不开的锁。 -->
        <div
          v-if="panelPassword?.password"
          class="admin-pw"
        >
          <div class="admin-pw-row">
            <span class="admin-pw-label">面板密码</span>
            <code class="admin-pw-value">{{ panelPasswordVisible ? panelPassword.password : "••••••••••••••••" }}</code>
            <button
              type="button"
              class="tlink"
              @click="copyText(panelPassword?.password ?? '', '面板密码已复制。')"
            >
              <el-icon><CopyDocument /></el-icon>复制
            </button>
            <button
              type="button"
              class="tlink"
              @click="panelPasswordVisible = !panelPasswordVisible"
            >
              {{ panelPasswordVisible ? "遮住" : "显示" }}
            </button>
            <button
              type="button"
              class="tlink"
              @click="openPanel"
            >
              打开面板登录
            </button>
          </div>
          <p class="admin-pw-note">
            登录 <code>{{ panelPassword.panelUrl }}</code> 用的就是这一串（<b>不是</b> WS/HTTP Token）。
            想换成自己记得住的：先在面板里改，再
            <button
              type="button"
              class="admin-pw-link"
              @click="void openEdit(primaryConnection)"
            >
              在连接设置里填回来
            </button>
            —— 两边不一致时，自动配节点 / 自动挂 QQ 会报「面板密码不对」。
          </p>
        </div>
        <!-- 读到了但没有值：凭据解不开或那格一直空着。说清楚怎么办，别留一块空白让人猜。 -->
        <div
          v-else-if="panelPassword && !panelPassword.password"
          class="admin-pw"
        >
          <span class="admin-pw-label">面板密码</span>
          <span class="admin-pw-empty">读不出来（连接凭据里没有或解不开），去「连接设置」重填一次。</span>
        </div>
        <div class="admin-acts">
          <button
            v-if="snowluma?.installed && !snowluma.running"
            type="button"
            class="btn"
            :disabled="snowlumaStarting"
            @click="startSnowluma"
          >
            <el-icon><VideoPlay /></el-icon>{{ snowlumaStarting ? "正在打开…" : "启动 SnowLuma" }}
          </button>
          <button
            v-if="!adapterStatus?.running"
            type="button"
            class="btn"
            :disabled="adapterStarting"
            @click="startAdapter"
          >
            <el-icon><VideoPlay /></el-icon>{{ adapterStarting ? "正在打开…" : "启动适配器" }}
          </button>
          <button
            type="button"
            class="btn quiet"
            @click="void openEdit(primaryConnection)"
          >
            连接设置
          </button>
          <button
            type="button"
            class="btn quiet"
            @click="scrollToSteps"
          >
            排查指南
          </button>
        </div>
      </section>
    </template>

    <div
      v-else-if="loading"
      class="rows"
      aria-hidden="true"
    >
      <div
        v-for="i in 2"
        :key="'sk-' + i"
        class="row is-skeleton"
      >
        <span class="sk is-ava" />
        <span class="sk" />
        <span class="sk is-short" />
      </div>
    </div>

    <div
      v-else-if="hasLoadError"
      class="errbar"
      role="alert"
    >
      <b>连接列表暂时无法读取</b>
      <p>检查管理员登录状态或服务连接后重试。已经运行的适配器不受影响。</p>
      <button
        type="button"
        class="btn"
        :disabled="loading"
        @click="refresh()"
      >
        <el-icon><Refresh /></el-icon>重试
      </button>
    </div>

    <!-- 空态只当一条横幅：四步在下面的教程里，这里再列一遍就是两套一样的步骤。
         第一次接进来需要的细节（下载、面板、启动按钮）都在教程里，所以那边默认展开。 -->
    <div
      v-else
      class="empty"
    >
      <span
        class="empty-mark"
        aria-hidden="true"
      >鱼</span>
      <div class="empty-copy">
        <h2>还没有 QQ 小号</h2>
        <p>挂一个号，她才能进群说话。按下面的四步来，大约十分钟。</p>
      </div>
      <button
        type="button"
        class="btn primary"
        @click="openCreate"
      >
        <el-icon><Plus /></el-icon>添加 QQ 小号
      </button>
    </div>

    <!-- 接入四步：只在第一次配的时候要看，有号了就默认收起 -->
    <details
      id="qq-steps"
      class="setup"
      :open="!hasConnections"
    >
      <summary>
        <h2>第一次接进来</h2>
        <span class="sm">装协议端 → 开端口 → 填连接 → 绑角色</span>
        <span class="grow" />
        <span class="fold-hint">展开</span>
        <el-icon class="fold-caret">
          <ArrowRight />
        </el-icon>
      </summary>

      <div class="setup-body">
        <div class="guide-tools">
          <button
            type="button"
            class="guide-copy"
            @click="copyInstallGuide"
          >
            <el-icon><CopyDocument /></el-icon>复制安装教程
          </button>
        </div>

        <ol class="steps">
          <li class="step">
            <span class="step-no">1</span>
            <div class="step-body">
              <h3>下载并登录 QQ 小号</h3>
              <p>
                装 {{ PROXY.name }}（自带网页配置面板，不用另装面板），装好后用 QQ 客户端登录小号。
                它是挂在这个已登录的客户端上收发消息的，所以那个窗口全程别关。
              </p>
              <p class="step-line">
                <a
                  :href="PROXY.repo"
                  target="_blank"
                  rel="noopener noreferrer"
                ><el-icon><Download /></el-icon>下载 {{ PROXY.name }}</a>
                <span class="sep">·</span>选最新的 win-x64 包，自带 Node 运行时，不用另外装环境。
              </p>
              <p class="step-note">
                建议使用小号，避免主号承担非官方协议的风控风险。
              </p>
            </div>
          </li>

          <li class="step">
            <span class="step-no">2</span>
            <div class="step-body">
              <h3>开启收发接口</h3>
              <!-- 协议端本体没起来的话，下面的面板链接点了也是白打，所以先解决它 -->
              <div class="run-row">
                <span
                  class="run-state"
                  :class="{
                    'is-on': snowluma?.running,
                    'is-warn': Boolean(snowluma?.installed) && !snowluma?.running,
                  }"
                >
                  <span class="dot" />{{ PROXY.name }} {{ snowlumaStateText }}
                  <span
                    v-if="snowlumaSourceLabel"
                    class="run-tag"
                  >{{ snowlumaSourceLabel }}</span>
                </span>
                <button
                  v-if="snowluma?.installed && !snowluma.running"
                  type="button"
                  class="abtn is-lead"
                  :disabled="snowlumaStarting"
                  @click="startSnowluma"
                >
                  <el-icon><VideoPlay /></el-icon>
                  {{ snowlumaStarting ? "正在打开…" : "启动 SnowLuma" }}
                </button>
                <button
                  v-if="snowluma?.installed"
                  type="button"
                  class="tlink"
                  @click="toggleHomeEdit"
                >
                  <el-icon><FolderOpened /></el-icon>换目录
                </button>
                <button
                  v-if="snowluma && !snowluma.installed"
                  type="button"
                  class="tlink"
                  @click="rescanSnowluma"
                >
                  <el-icon><Refresh /></el-icon>重新找一遍
                </button>
              </div>
              <p
                v-if="panelPassword?.password"
                class="step-note"
              >
                面板密码就在上方「连接管理」里，点「复制」粘到面板登录页即可。
              </p>
              <p
                v-if="snowluma && !snowluma.installed"
                class="run-warn"
              >
                没找到 <code>{{ snowluma.home }}\start.bat</code>。自动找的时候扫过下载、桌面、文档、
                Program Files 和各盘根目录下两层，都没中。把「一眼能看到 start.bat 的那一层」填到下面，
                只填一次；刚装完还没被扫到的，点上面「重新找一遍」。
              </p>
              <div
                v-if="snowluma && (!snowluma.installed || homeEditing)"
                class="home-edit"
              >
                <input
                  v-model="homeDraft"
                  class="home-input"
                  spellcheck="false"
                  placeholder="D:\Tools\SnowLuma"
                  aria-label="协议端安装目录"
                >
                <button
                  type="button"
                  class="abtn is-lead"
                  :disabled="homeSaving"
                  @click="saveHome"
                >
                  {{ homeSaving ? "保存中…" : "保存目录" }}
                </button>
              </div>
              <p class="endpoint-intro">
                打开协议端面板：<a
                  :href="PROXY.panel"
                  target="_blank"
                  rel="noopener noreferrer"
                ><code>{{ PROXY.panel }}</code></a>
              </p>
              <ol class="endpoint-steps">
                <li>
                  <span class="endpoint-index">1</span>
                  <span class="endpoint-copy"><b>开启 WebSocket 服务端</b><span>端口 <code>3001</code>，用于接收 QQ 消息</span></span>
                </li>
                <li>
                  <span class="endpoint-index">2</span>
                  <span class="endpoint-copy"><b>开启 HTTP API</b><span>端口 <code>3002</code>，用于发送 QQ 消息</span></span>
                </li>
                <li>
                  <span class="endpoint-index">3</span>
                  <span class="endpoint-copy"><b>设置并记下 Token</b><span>WS 与 HTTP 分别设置，两个值可能不同</span></span>
                </li>
              </ol>
              <p class="endpoint-note">
                HTTP 不要用 3000，这个端口通常被本站占用。
              </p>
              <details class="step-more">
                <summary>
                  <span class="step-caret"><el-icon><ArrowRight /></el-icon></span>
                  {{ PROXY.name }} 面板配置细节
                </summary>
                <ol class="panel-steps">
                  <li
                    v-for="(step, index) in PROXY.steps"
                    :key="step.title"
                    class="panel-step"
                  >
                    <span class="panel-step-no">{{ index + 1 }}</span>
                    <div class="panel-step-copy">
                      <strong>{{ step.title }}</strong>
                      <p>{{ step.detail }}</p>
                    </div>
                  </li>
                </ol>
                <p class="warn">
                  {{ PROXY.warn }}
                </p>
              </details>
            </div>
          </li>

          <li class="step">
            <span class="step-no">3</span>
            <div class="step-body">
              <h3>添加连接并绑定角色</h3>
              <p>
                填 QQ 号、WS 地址 <code>ws://127.0.0.1:3001</code>、HTTP 地址
                <code>http://127.0.0.1:3002</code> 和协议端 Token。保存后绑定一个角色。
              </p>
              <button
                type="button"
                class="abtn is-lead"
                @click="openCreate"
              >
                <el-icon><Plus /></el-icon>添加 QQ 小号
              </button>
            </div>
          </li>

          <li class="step">
            <span class="step-no">4</span>
            <div class="step-body">
              <h3>启动并测试</h3>
              <p>
                适配器是个独立进程，得一直开着才能收发。点下面的按钮会打开一个命令行窗口，
                替你在项目根目录跑 <code>yarn onebot:run</code>；窗口里出现
                <code>onebot-connected</code> 就通了，再用另一个 QQ 号发消息测试。
              </p>
              <div class="run-row">
                <button
                  type="button"
                  class="abtn is-lead"
                  :disabled="adapterStarting || adapterStatus?.running"
                  @click="startAdapter"
                >
                  <el-icon><VideoPlay /></el-icon>
                  {{ adapterStatus?.running ? "已在运行" : adapterStarting ? "正在打开…" : "启动适配器" }}
                </button>
                <button
                  type="button"
                  class="tlink"
                  @click="copyCommand('yarn onebot:run')"
                >
                  <el-icon><CopyDocument /></el-icon>复制命令
                </button>
                <span
                  class="run-state"
                  :class="{ 'is-on': adapterStatus?.running }"
                >
                  <span class="dot" />{{ adapterStateText }}
                </span>
                <span
                  v-if="gateway"
                  class="run-state"
                  :class="gateway.reachable ? 'is-on' : 'is-warn'"
                >
                  <span class="dot" />{{ gateway.reachable
                    ? `网关 ${gateway.port} 已监听`
                    : `网关 ${gateway.port} 没人接` }}
                </span>
              </div>
              <p
                v-if="gateway && !gateway.reachable"
                class="run-warn"
              >
                适配器要连的 <code>{{ gateway.port }}</code> 端口没有进程应答 ——
                也就是协议端没启动（或它里面的 WS 节点没开）。回第 2 步点「启动 SnowLuma」，
                等面板能打开、日志里出现 <code>login detected</code>，这边会自己连上。
                期间适配器日志会一直刷 <code>code=1006</code>，那是它在按
                1/2/4/8/16/30 秒退避重试，不是坏了。
              </p>
              <p class="step-note">
                关掉那个命令行窗口就等于停。已经手动开着适配器时不要再点（会开出第二个，两个抢同一条连接）。
                窗口一闪就没的话，多半是 <code>yarn</code> 不在 PATH —— 按「复制命令」自己开终端跑，把报错贴出来。
              </p>
            </div>
          </li>
        </ol>

        <!-- ③ 排查：症状在前、原因在后，比一长串「如果…」好扫 -->
        <section class="fix-block">
          <div class="fix-block-h">
            <h3>连不上，按这个顺序查</h3>
            <span>八成是前三样</span>
          </div>
          <dl class="fix-list">
            <div class="fix-row">
              <dt>协议端日志里没有 <code>UIN=小号</code></dt>
              <dd>小号还没在官方 QQ 客户端里登上，或者那个窗口被关了。</dd>
            </div>
            <div class="fix-row">
              <dt>适配器日志一直刷 <code>code=1006</code></dt>
              <dd>3001 上没人监听：协议端根本没启动，或它里面的 WS 节点没开。先跑 <code>start.bat</code> 再看面板。</dd>
            </div>
            <div class="fix-row">
              <dt>适配器报连不上 3001</dt>
              <dd>协议端里 WS 节点没开，或端口不是 3001 —— 回第 2 步核对。</dd>
            </div>
            <div class="fix-row">
              <dt>能连上，但一条都不回</dt>
              <dd>没绑角色，或者角色还没配模型 API Key。</dd>
            </div>
            <div class="fix-row">
              <dt>发不出去 / 握手 401</dt>
              <dd>两个 Token 填反了（WS 和 HTTP 是两把不同的钥匙），或者 HTTP 端口和面板里不一致。</dd>
            </div>
            <div class="fix-row">
              <dt>群里太吵</dt>
              <dd>展开上面那一行，把「这个群怎么回」调成「仅被 @ 时回复」。</dd>
            </div>
            <div class="fix-row">
              <dt>想让她发表情 / 主动找话 / 刷 B站</dt>
              <dd>也都在行里：「这个角色」是角色级开关，「主人的 B站 口令」在这个群那一组。</dd>
            </div>
          </dl>
        </section>
      </div>
    </details>

    <!-- ── 连接设置 / 添加 ───────────────────────────────── -->
    <el-dialog
      v-model="editVisible"
      :title="editingId ? '连接设置' : '添加 QQ 小号'"
      width="640px"
      :close-on-click-modal="false"
    >
      <el-form
        label-position="top"
        class="cq-form"
        autocomplete="off"
        @submit.prevent="submitConnection(false)"
      >
        <div class="cq-sec is-first">
          <div class="cq-sec-h">
            <span>身份</span>
          </div>
          <div class="cq-id">
            <el-form-item
              label="QQ 号"
              required
            >
              <el-input
                v-model="form.qqNumber"
                :disabled="!!editingId"
                placeholder="小号的数字 QQ 号"
              />
            </el-form-item>
            <el-form-item label="显示名（可留空）">
              <el-input
                v-model="form.displayName"
                placeholder="例如：我的 QQ 小号"
              />
            </el-form-item>
          </div>
        </div>

        <div class="cq-sec">
          <div class="cq-sec-h">
            <span>协议端地址与 Token</span>
            <button
              v-if="!editingId"
              type="button"
              class="cq-fill"
              @click="fillDefaultUrls"
            >
              填入默认地址
            </button>
          </div>
          <p class="cq-hint">
            端口要和协议端面板里一致：收消息 3001，发消息 3002。<strong>别用 3000</strong>，那是本站 dev server 的端口。
            <em v-if="credLoading">正在读取已保存的值…</em>
          </p>
          <div class="cq-pair">
            <el-form-item label="WS 地址（收消息）">
              <el-input
                v-model="form.wsUrl"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用已保存的地址' : 'ws://127.0.0.1:3001'"
              />
            </el-form-item>
            <el-form-item label="WS Token">
              <el-input
                v-model="form.accessToken"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用原值' : '没设就留空'"
              />
            </el-form-item>
          </div>
          <div class="cq-pair">
            <el-form-item label="HTTP 地址（发消息）">
              <el-input
                v-model="form.httpUrl"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用已保存的地址' : 'http://127.0.0.1:3002'"
              />
            </el-form-item>
            <el-form-item label="HTTP Token">
              <el-input
                v-model="form.httpToken"
                type="password"
                show-password
                autocomplete="new-password"
                :disabled="credLoading"
                :placeholder="editingId ? '留空 = 沿用原值' : 'HTTP 节点的授权 Token'"
              />
            </el-form-item>
          </div>
          <el-form-item label="SnowLuma 面板密码（用来自动配节点）">
            <el-input
              v-model="form.snowlumaPassword"
              type="password"
              show-password
              autocomplete="new-password"
              :disabled="credLoading"
              :placeholder="editingId ? '留空 = 沿用原值' : '登录面板用的那个密码'"
            />
          </el-form-item>
          <p class="cq-hint">
            全新安装时这一格会被自动填好：忆灵空间替 SnowLuma 生成面板密码并记在这里，人不用手抄。
            同一串也会明写在「连接管理」里（等宽字体那行，可一键复制），这里改动它会跟着变。
            你在面板里手动改过密码，就要把新的填回来。点「启动 SnowLuma」时后台会用它登录面板，
            把这上面的地址和 Token 对齐到协议端节点里 —— 不用再自己开面板核对，也不会因为忘了密码卡在登录页。
            <strong>面板本身就是登录密码，不是 Token。</strong>
          </p>
          <p class="cq-warn">
            <el-icon><Warning /></el-icon>
            <span>
              Token 是密码框，浏览器可能自动填上你登录本站的账号密码 —— 那不是协议端令牌，保存前先清空再粘。
              <template v-if="!editingId">两个都要有：少了 WS 收不到，少了 HTTP 发不出去。</template>
            </span>
          </p>
        </div>

        <div class="cq-sec">
          <div class="cq-sec-h">
            <span>主人</span>
          </div>
          <el-form-item label="主人 QQ 号（可留空）">
            <el-input
              v-model="form.ownerQq"
              maxlength="15"
              placeholder="只有这个 QQ 能让她去刷 B站"
            />
          </el-form-item>
          <el-form-item label="主人称呼（可留空）">
            <el-input
              v-model="form.ownerName"
              maxlength="60"
              placeholder="例如：烟火清凉；留空则用 QQ 昵称"
            />
          </el-form-item>
          <p class="cq-hint">
            留空主人 QQ = 群里的 B站 指令不会生效。主人称呼会写进对话上下文，让她认得出你；留空时用 QQ 昵称。
          </p>
        </div>

        <div class="cq-sec">
          <div class="cq-sec-h">
            <span>群管理（可选）</span>
          </div>
          <el-form-item class="cq-check">
            <el-checkbox v-model="form.groupAnnouncementEnabled">
              允许群主/管理员让她拟群公告
            </el-checkbox>
          </el-form-item>
          <p class="cq-hint">
            开启后，群里只有<strong>群主或管理员</strong> @ 她并说「写个群公告：主题」，她才会拟稿；
            草稿回复后，管理员回复「确认发布」才真正发出。普通成员说什么都不会触发。
          </p>
          <p class="cq-warn">
            <el-icon><Warning /></el-icon>
            <span>
              前提：QQ 里先把这个小号设为群管理员，否则发布会被拒绝。
              本期只开放群公告，不开放踢人、禁言等操作。
            </span>
          </p>
        </div>
      </el-form>

      <template #footer>
        <div class="cq-foot">
          <!-- 删除放在设置里：这是连接级动作，不该挂在某一条绑定上 -->
          <button
            v-if="editingTarget"
            type="button"
            class="tlink is-danger"
            @click="removeConnection(editingTarget)"
          >
            <el-icon><Delete /></el-icon>删除这个号
          </button>
          <span
            v-else
            class="cq-foot-note"
          >首次使用仍需启动一次适配器</span>
          <span class="cq-foot-actions">
            <el-button @click="editVisible = false">
              取消
            </el-button>
            <el-button
              type="primary"
              :loading="saving"
              :disabled="credLoading"
              @click="submitConnection(true)"
            >
              保存并重新连接
            </el-button>
          </span>
        </div>
      </template>
    </el-dialog>

    <!-- ── 绑定角色 ─────────────────────────────────────── -->
    <el-dialog
      v-model="bindVisible"
      title="绑定角色"
      width="460px"
      :close-on-click-modal="false"
    >
      <el-form
        label-position="top"
        class="cq-form"
      >
        <el-form-item label="角色">
          <el-select
            v-model="bindForm.characterId"
            placeholder="选择要绑定的角色"
            style="width:100%"
          >
            <el-option
              v-for="character in characters"
              :key="character.id"
              :label="boundCharacterIds.has(character.id) ? `${character.name}（已绑定）` : character.name"
              :value="character.id"
              :disabled="boundCharacterIds.has(character.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="群号（可留空）">
          <el-input-tag
            v-model="bindForm.routingKeys"
            placeholder="留空 = 私聊 + 所有群都回复"
            :max="50"
            clearable
          />
        </el-form-item>
        <p class="cq-hint">
          填了群号就只在这些群里回复；可以填多个群号，回车或输入逗号确认一个。
          留空则私聊和所有群都会回复。群聊参与度、限流、B站 口令在清单里展开那一行改。
        </p>
        <p
          v-if="allCharactersBound"
          class="cq-hint"
        >
          角色都已经绑在这个号上了。要换群号或调群聊设置，回到清单里展开那一行改就行。
        </p>
      </el-form>

      <template #footer>
        <div class="cq-foot">
          <span class="cq-foot-note">绑完立刻生效，不用重启适配器</span>
          <span class="cq-foot-actions">
            <el-button @click="bindVisible = false">
              取消
            </el-button>
            <el-button
              type="primary"
              :loading="bindSaving"
              @click="submitBind"
            >
              绑定
            </el-button>
          </span>
        </div>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   按「绑定」组织：链路带（通没通）→ 绑定清单（一行一个角色×群）→ 连接管理 → 折叠的接入教程。
   层次只靠明度差和间距：底色 --bg、卡片 --surface、组内分块才用 --surface-2/3。
   全部规则挂在 .qq-a 下，既锁住作用域，也压过 main.css 的 .card/.btn (0,1,0)。
   ══════════════════════════════════════════════════════════════ */
.qq-a {
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}

#qq-steps { scroll-margin-top: 16px; }
.grow { flex: 1; }

/* ── 按钮：主操作实心，其余降成文字 ─────────────────── */
.btn.quiet {
  height: 32px;
  border-color: transparent;
  background: transparent;
  padding: 0 10px;
  color: var(--text-2);
  font-weight: 600;
}
.btn.quiet:hover {
  border-color: transparent;
  background: var(--surface-3);
  color: var(--brand-strong);
  text-decoration: none;
}
.btn.quiet.is-danger:hover { background: var(--red-soft); color: var(--red); }

/* ── 重连提示：只在等适配器时出现，平时不占版面 ─────── */
.reloadbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
  border-radius: var(--radius);
  background: var(--amber-soft);
  padding: var(--sp-3) var(--sp-4);
}
.reloadbar b { flex: none; color: #8f5c05; font-size: 14px; font-weight: 700; }
.reloadbar p { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.6; }
.reloadbar .btn { height: 32px; flex: none; border-color: transparent; background: var(--surface); }

/* 停止状态：不是故障（是用户自己停的），用中性灰而不是红/黄，免得和「断点」混为一谈 */
.reloadbar.is-paused { background: var(--surface-3); }
.reloadbar.is-paused b { color: var(--text); }

/* 额度用尽：链路全绿但她不回话，宁可红一条，也不要让人去翻日志 */
.limitbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
  border-radius: var(--radius);
  background: var(--red-soft);
  padding: var(--sp-3) var(--sp-4);
}
.limitbar b { flex: none; color: var(--red); font-size: 14px; font-weight: 700; }
.limitbar p { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.6; }
.limitbar .btn {
  height: 32px;
  flex: none;
  border-color: transparent;
  background: var(--surface);
  color: var(--text-2);
  text-decoration: none;
}

/* ── 清单头 ─────────────────────────────────────────── */
.list-head {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin: var(--sp-5) 0 var(--sp-3);
}
.list-head h2 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.list-head .count { color: var(--dim); font-size: 12px; }
.list-head .btn { align-self: center; margin-left: auto; }

/* ── 行：一行一条绑定 ───────────────────────────────── */
.rows { display: flex; flex-direction: column; gap: var(--sp-2); }

.row { border-radius: var(--radius); background: var(--surface); }

.row-main {
  display: grid;
  /* 名字/范围/参与度都归到第 2 列，右侧只留额度与展开箭头：
     多行时两边都是「谁、多少」，不必各行各对一列。 */
  grid-template-columns: 32px minmax(0, 1fr) auto 20px;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  padding: var(--sp-3) var(--sp-4);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background .14s var(--ease);
}
.row-main:hover { background: var(--surface-2); }
.row-main:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

.ava {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 14px;
  font-weight: 700;
}

.who { min-width: 0; }
.who b {
  display: block;
  overflow: hidden;
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.who-sub {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--sp-2);
  margin-top: 2px;
}
.who-sub .where {
  min-width: 0;
  overflow: hidden;
  color: var(--dim);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mode {
  display: inline-flex;
  height: 20px;
  flex: none;
  align-items: center;
  border-radius: 999px;
  background: var(--surface-3);
  padding: 0 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.mode.is-ambient { background: var(--brand-soft); color: var(--brand-strong); }
.mode.is-todo { background: var(--amber-soft); color: #8f5c05; }

.quota {
  justify-self: end;
  color: var(--dim);
  font-size: 12px;
  white-space: nowrap;
}
.quota b { color: var(--text); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }

/* 展开符号：就是 Element 的 ArrowRight（一个 >），不加容器。
   收起时 >，展开时转 90° 变成 v；hover 只换颜色，不多画一圈边框。 */
.caret {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  font-size: 12px;
  transition: transform .18s var(--ease), color .14s var(--ease);
}
.row.is-open .caret { transform: rotate(90deg); color: var(--text-2); }
.row-main:hover .caret { color: var(--brand-strong); }
.row.is-open .row-main { border-bottom-right-radius: 0; border-bottom-left-radius: 0; }

.row-body { display: none; border-top: 1px solid var(--line); padding: var(--sp-4); }
.row.is-open .row-body { display: block; }

.row-blank { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
.row-blank p { flex: 1 1 320px; margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.7; }

/* ── 连接管理：清单下面的一张紧凑卡片 ─────────────────
    chips 摆「是什么」（号、地址），按钮摆「怎么办」（启动、设置、排查）。
   启动按钮只在那个进程没跑时出现 —— 全通时只剩两个安静的文字按钮。 */
.admin {
  margin-top: var(--sp-3);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-3) var(--sp-4);
}
.admin-h { display: flex; align-items: baseline; gap: var(--sp-2); }
.admin-h h2 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.admin-sub { color: var(--dim); font-size: 12px; }
.admin-chips { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
.chip {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 0 10px;
  color: var(--dim);
  font-size: 12px;
}
.chip b { color: var(--text); font-weight: 600; }
.chip b.is-mono { font-family: var(--mono); font-weight: 500; }
a.chip.is-link { text-decoration: none; }
a.chip.is-link:hover { background: var(--surface-3); }
a.chip.is-link:hover b { color: var(--brand-strong); }
.admin-acts { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
.admin-acts .btn { height: 32px; }

/* 骨架：只占位，不描形状 */
.row.is-skeleton {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr) 120px;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
}
.sk { height: 12px; border-radius: 6px; background: var(--surface-3); }
.sk.is-ava { width: 32px; height: 32px; border-radius: var(--radius-sm); }
.sk.is-short { width: 80%; }

/* ── 读不到列表 ───────────────────────────────────── */
.errbar {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  border-radius: var(--radius);
  background: var(--red-soft);
  padding: var(--sp-4);
}
.errbar b { flex: none; color: var(--red); font-size: 14px; font-weight: 700; }
.errbar p { min-width: 0; flex: 1; margin: 0; color: var(--text-2); font-size: 14px; line-height: 1.6; }
.errbar .btn { height: 32px; flex: none; border-color: transparent; background: var(--surface); }

/* ── 空态：一条横幅，不做大卡 ───────────────────────
   四步在下面的教程里，这里再列一遍就是两套一样的步骤 */
.empty {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  border-radius: var(--radius);
  background: var(--surface);
  padding: var(--sp-4) var(--sp-5);
}
.empty-mark {
  display: grid;
  width: 40px;
  height: 40px;
  flex: none;
  place-items: center;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 18px;
}
.empty-copy { min-width: 0; flex: 1; }
.empty-copy h2 { margin: 0; color: var(--text); font-size: 16px; font-weight: 700; }
.empty-copy p { margin: 2px 0 0; color: var(--text-2); font-size: 14px; }
.empty .btn { flex: none; }

/* ── 接入四步：折起来，有号了就默认收起 ─────────────── */
.setup { margin-top: var(--sp-4); border-radius: var(--radius); background: var(--surface); }
.setup > summary {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  list-style: none;
  cursor: pointer;
}
.setup > summary::-webkit-details-marker { display: none; }
.setup > summary h2 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.setup > summary .sm { color: var(--dim); font-size: 12px; }
.setup > summary .grow { flex: 1; }
.setup > summary:hover h2 { color: var(--brand-strong); }
.setup .fold-hint { color: var(--dim); font-size: 12px; }
.setup .fold-caret {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  font-size: 12px;
  transition: transform .18s var(--ease), color .14s var(--ease);
}
.setup > summary:hover .fold-caret { color: var(--brand-strong); }
.setup[open] .fold-caret { transform: rotate(90deg); color: var(--text-2); }
.setup[open] .fold-hint { display: none; }
.setup-body { border-top: 1px solid var(--line); padding: 0 var(--sp-4) var(--sp-4); }
.guide-tools { display: flex; justify-content: flex-end; padding: var(--sp-3) 0 0; }

.guide-copy {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 0 10px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background .14s var(--ease), border-color .14s var(--ease), color .14s var(--ease);
}
.guide-copy:hover { border-color: var(--brand-line); background: var(--brand-soft); color: var(--brand-strong); }
.guide-copy .el-icon { font-size: 14px; }
.guide-copy:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* ── 四步 ───────────────────────────────────────────── */
.steps { display: flex; flex-direction: column; margin: 6px 0 0; padding: 0; list-style: none; }
.step {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  gap: 12px;
  border-top: 1px solid var(--line);
  padding: 16px 0;
}
.step:first-child { border-top: 0; padding-top: 10px; }
.step:last-child { padding-bottom: 0; }
/* 圆形序号：品牌软底 + 品牌色字，纯装饰，所以只有 24px */
.step-no {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 700;
}
.step-body { min-width: 0; }
.step-body h3 { margin: 0 0 6px; color: var(--text); font-size: 16px; font-weight: 700; line-height: 1.4; }
/* 正文字号 14、行宽 68ch：这几段是要照着做的，别拉成一行 100 多字 */
.step-body p { max-width: 68ch; margin: 0 0 8px; color: var(--text-2); font-size: 14px; line-height: 1.75; }
.step-body p:last-child { margin-bottom: 0; }
.step-body strong { color: var(--text); font-weight: 600; }
.endpoint-intro { margin-bottom: 10px !important; }
.step-note { color: var(--dim) !important; font-size: 12px !important; line-height: 1.7 !important; }
/* 行内链接：不整体 flex，否则那句长文案会变成一个独立 flex item，
   窄屏时链接和正文各占一行、缩进对不上。图标单独抬 2px 跟基线走。 */
.step-line a,
.step-body a { display: inline-flex; align-items: center; gap: 4px; color: var(--brand-strong); font-weight: 600; }
.step-line a:hover,
.step-body a:hover { text-decoration: underline; text-underline-offset: 3px; }
.step-line .el-icon { margin-right: 2px; font-size: 13px; vertical-align: -2px; }
.sep { margin: 0 5px; color: var(--faint); }

/* 第 4 步：启动按钮 + 复制命令 + 运行状态同一行 */
.run-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 10px 0 0; }
.run-state { display: inline-flex; align-items: center; gap: 6px; color: var(--dim); font-size: 12px; }
.run-state .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
.run-state.is-on { color: #0b7a54; }
.run-state.is-on .dot { background: var(--green); }
.run-state.is-warn { color: #8f5c05; }
.run-state.is-warn .dot { background: #d79a2b; }
/* 「自动找到」标：路径不是用户填的就说一声，省得他以为自己填过 */
.run-tag { margin-left: 2px; border-radius: 999px; background: var(--surface-2); padding: 1px 7px; color: var(--dim); font-size: 12px; }
/* 面板密码：一条虚线小砖，值用等宽字体、可整段选中。刻意不做成输入框 ——
   它在这里只是「给你看一眼、复制走」，改密码的入口是下方的「连接设置」。 */
.admin-pw {
  margin-top: var(--sp-3);
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-sm, 8px);
  background: var(--surface-2);
  padding: 6px 10px;
}
.admin-pw-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.admin-pw-label { color: var(--dim); font-size: 12px; }
.admin-pw-value {
  color: var(--text);
  font-family: var(--mono);
  font-size: 12.5px;
  letter-spacing: .2px;
  user-select: all;
}
.admin-pw-note { margin: 4px 0 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.admin-pw-empty { margin-left: 8px; color: var(--dim); font-size: 12px; }
.admin-pw-note code { color: var(--text-2); font-family: var(--mono); }
.admin-pw-note b { color: var(--text); font-weight: 600; }
/* 行内文字按钮：看着像链接，但仍是 button —— 键盘能 tab 到，也不会触发跳转 */
.admin-pw-link {
  border: 0;
  background: none;
  padding: 0;
  color: var(--brand-strong);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.admin-pw-link:hover { text-decoration: underline; text-underline-offset: 3px; }
/* 网关没接上：这不是错误弹窗该干的事，写成一块常驻的说明 */
.run-warn {
  margin: 10px 0 0;
  border-radius: var(--radius-sm);
  background: var(--amber-soft);
  padding: 10px 12px;
  color: #8f5c05;
  font-size: 12px;
  line-height: 1.8;
}
.run-warn code { border-radius: 4px; background: rgb(255 255 255 / 75%); padding: 1px 4px; }

/* 目录输入只在「找不到 start.bat」或点了「换目录」时出现 */
.home-edit { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: var(--sp-2); }
.home-input {
  min-width: 0;
  height: 34px;
  flex: 1 1 280px;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 0 10px;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
}
.home-input::placeholder { color: var(--dim); }
.home-input:focus { outline: 2px solid var(--brand); outline-offset: -2px; background: var(--surface-3); }

.endpoint-steps { display: grid; gap: 8px; max-width: 620px; margin: 0; padding: 0; list-style: none; }
.endpoint-steps li {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-height: 52px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 8px 12px;
}
.endpoint-index {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 700;
}
.endpoint-copy { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.endpoint-copy b { color: var(--text); font-size: 14px; font-weight: 600; }
.endpoint-copy > span { color: var(--dim); font-size: 12px; line-height: 1.5; }
.endpoint-note { margin-top: 8px !important; color: #8f5c05 !important; font-size: 12px !important; }

/* 折叠：默认只露一句话，想动手再展开 */
.step-more { margin-top: 10px; }
.step-more summary {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  padding: 6px 11px 6px 8px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}
.step-more summary::-webkit-details-marker { display: none; }
.step-more summary:hover { background: var(--surface-3); }
.step-caret {
  display: inline-flex;
  color: var(--dim);
  font-size: 12px;
  transition: transform .18s var(--ease), color .14s var(--ease);
}
.step-more summary:hover .step-caret { color: var(--brand-strong); }
.step-more[open] .step-caret { transform: rotate(90deg); color: var(--text-2); }
.panel-steps { display: flex; flex-direction: column; margin: 12px 0 0; padding: 0; list-style: none; }
.panel-step { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; padding: 0 0 14px; }
.panel-step:not(:last-child)::before {
  position: absolute;
  top: 25px;
  bottom: 0;
  left: 12px;
  width: 2px;
  background: var(--surface-3);
  content: "";
}
.panel-step-no {
  z-index: 1;
  display: grid;
  width: 26px;
  height: 26px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 12px;
  font-weight: 700;
}
.panel-step-copy { min-width: 0; padding-top: 2px; }
.panel-step-copy strong { color: var(--text); font-size: 14px; font-weight: 700; }
.panel-step-copy p { max-width: 66ch; margin: 3px 0 0; color: var(--text-2); font-size: 14px; line-height: 1.65; }

/* 警告块：软底 + 深一档的琥珀字（--amber 只有 4.26:1，不够 AA） */
.warn {
  display: flex;
  gap: 7px;
  max-width: 68ch !important;
  margin-top: 10px;
  border-radius: var(--radius-sm);
  background: var(--amber-soft);
  padding: 8px 11px;
  color: #8f5c05 !important;
  font-size: 12px !important;
  line-height: 1.7 !important;
}

/* ── 排查清单：症状在前、原因在后 ─────────────────── */
.fix-block { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 14px; }
.fix-block-h { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.fix-block-h h3 { margin: 0; color: var(--text-2); font-size: 14px; font-weight: 700; }
.fix-block-h span { color: var(--dim); font-size: 12px; }
.fix-list { display: flex; flex-direction: column; margin: 8px 0 0; }
/* 症状 / 原因两列：症状最长也就 12 个字，给 0.62 列就够 ——
   1:1 会在中间留一条 250px 的空沟，右边那列反而变窄 */
.fix-row {
  display: grid;
  grid-template-columns: minmax(0, 0.62fr) minmax(0, 1.38fr);
  gap: 8px 20px;
  align-items: baseline;
  border-top: 1px solid var(--line);
  padding: 9px 0;
}
.fix-row:first-child { border-top: 0; }
.fix-row dt { color: var(--text-2); font-size: 14px; font-weight: 600; }
.fix-row dd { margin: 0; color: var(--dim); font-size: 14px; line-height: 1.7; }

/* 行内代码：整页统一一处，别在各段里各写一遍 */
.qq-a code,
.cmd code {
  border-radius: 4px;
  background: var(--surface-3);
  padding: 1px 5px;
  color: var(--text-2);
  font-family: var(--mono);
  font-size: 12px;
}

/* 文字按钮：卡片上的动作一律降调，主色只留给 hover */
.abtn {
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  padding: 0 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.abtn .el-icon { color: var(--faint); font-size: 14px; }
.abtn:hover { background: var(--surface-2); color: var(--brand-strong); }
.abtn:hover .el-icon { color: var(--brand); }
.abtn.is-lead { margin-top: 4px; background: var(--surface-2); }

/* 危险动作：常态灰、hover 才红。删除不该和主操作一样响 */
.tlink {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 4px;
  border: 0;
  border-radius: var(--radius-xs, 6px);
  background: none;
  padding: 0 7px;
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.tlink .el-icon { font-size: 13px; }
.tlink.is-danger:hover { background: var(--red-soft); color: var(--red); }

/* ── 弹窗：三组（身份 / 地址与 Token / 群聊），每组一个小标题 ──────
   弹窗是 teleport 出去的，外壳样式在 main.css；这里只管插槽里自己的元素，
   Element 的 .el-form-item 要靠 :deep —— 插槽内容带本组件的 scope id，能命中。 */
.cq-form { display: flex; flex-direction: column; gap: 18px; }
.cq-form :deep(.el-form-item) { margin-bottom: 0; }
.cq-form :deep(.el-form-item__content) { min-width: 0; }
.cq-id { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 0 16px; }
.cq-pair { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 0 16px; }

/* 分组：一条 1px 的 --line 起头，比加卡片边框轻。
   组内 10、组间 18 —— 组距必须大于组内距，否则看起来是六个平行字段 */
.cq-sec { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--line); padding-top: 16px; }
.cq-sec.is-first { border-top: 0; padding-top: 0; }
.cq-sec-h { display: flex; align-items: baseline; gap: 10px; }
/* 小标题要压过字段标签（12/500）：14/700 + 同色，只差字号和字重 */
.cq-sec-h span { color: var(--text-2); font-size: 14px; font-weight: 700; }
.cq-fill { margin-left: auto; border: 0; background: none; padding: 0; color: var(--brand-strong); font-size: 12px; font-weight: 600; cursor: pointer; }
.cq-fill:hover { text-decoration: underline; }
.cq-hint { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }
.cq-hint strong { color: var(--text-2); font-weight: 600; }
.cq-hint em { color: var(--brand-strong); font-style: normal; }

.cq-warn {
  display: flex;
  gap: 7px;
  border-radius: var(--radius-sm);
  background: var(--amber-soft);
  padding: 8px 10px;
  color: #8f5c05;
  font-size: 12px;
  line-height: 1.7;
}
.cq-warn .el-icon { margin-top: 2px; flex: none; font-size: 14px; }

.cq-check :deep(.el-checkbox) { height: 20px; }

.cq-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cq-foot-note { color: var(--dim); font-size: 12px; text-align: left; }
.cq-foot-actions { display: flex; margin-left: auto; }

/* ── 窄屏 ───────────────────────────────────────────── */
@media (max-width: 860px) {
  /* 徽标已在名字下面，行头不再需要为它单开一行；右侧只留额度与箭头 */
  .row-main { grid-template-columns: 32px minmax(0, 1fr) auto 20px; row-gap: var(--sp-2); padding: var(--sp-3); }
  .caret { grid-column: 4; grid-row: 1; }
  .quota { grid-column: 3; grid-row: 1; }

  .empty { align-items: flex-start; flex-wrap: wrap; padding: var(--sp-4); }
  .empty-copy { flex-basis: calc(100% - 56px); }
  .empty .btn { margin-left: 56px; }

  .reloadbar { flex-wrap: wrap; }
  .reloadbar p { flex-basis: 100%; }
  .limitbar { flex-wrap: wrap; }
  .limitbar p { flex-basis: 100%; }
  .errbar { flex-wrap: wrap; }
  .errbar p { flex-basis: 100%; }

  .setup > summary { flex-wrap: wrap; }
  .setup > summary .sm { flex-basis: 100%; order: 3; }
  .step { gap: 10px; }
  .fix-row { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .endpoint-steps li { grid-template-columns: 24px minmax(0, 1fr); padding: 8px 10px; }
}

@media (max-width: 560px) {
  .cq-id,
  .cq-pair { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .cq-foot { flex-direction: column-reverse; align-items: stretch; gap: 10px; }
  .cq-foot-actions { justify-content: flex-end; }
  .cq-foot-note { text-align: center; }
}
</style>
