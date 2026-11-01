/**
 * 命令表同步：读 `bili schema`，把 CLI 的全部命令映射成面板的侧栏结构。
 *
 * 手写 `catalog.ts` 只保留「刷B站」入口和 `selfcheck` 这类本地面板项；真正的
 * bili 子命令以 schema 为准 —— 升级 bili-cli 后新增/改参数不用再改代码。
 * schema 挂了或结构变了就退回手写目录，面板不会白屏。
 */

import {
  BILI_CATALOG,
  type BiliCatalogGroup,
  type BiliCatalogItem,
  type BiliCatalogParam,
} from "./catalog";
import { biliJson } from "./runner";

const GROUP_NAMES: Record<string, string> = {
  auth: "账号", me: "账号", owner: "账号", user: "用户",
  feed: "发现", hot: "发现", search: "发现",
  video: "视频", comment: "评论", dm: "私信", dynamic: "动态",
  upload: "投稿", danmaku: "弹幕", asr: "转写", season: "合集",
  skills: "系统", mcp: "系统", schema: "系统",
};

const GROUP_ORDER = [
  "账号", "发现", "视频", "评论", "私信", "动态", "投稿", "合集", "弹幕", "转写", "用户", "系统",
];

/** 会往 B站 写东西的命令（命令面板默认加 --dry-run）。 */
const WRITE_VERBS = new Set([
  "post", "reply", "delete", "pin", "like", "fav", "coin", "triple", "send",
  "recall", "set", "upload", "edit", "install", "uninstall", "clear", "use",
  "vote", "rating", "reserve", "link", "follow", "remove",
]);

/** 这些不是内容写操作，加 --dry-run 反而会报参数错误。 */
const NON_WRITE_COMMANDS = new Set(["auth.login", "auth.logout", "asr.install"]);

const PARAM_LABELS: Record<string, string> = {
  engine: "引擎", kind: "类型", status: "状态", style: "样式",
  provider: "服务商", "base-url": "接口地址", base_url: "接口地址",
  model: "模型", device: "设备", who: "谁", uid: "UID",
  bvid: "BV 号", keyword: "关键词", text: "正文", num: "条数",
  page: "页码", pn: "页码", ps: "每页条数", order: "排序",
  unseen: "只看没看过", "max-chars": "正文字数", frames: "抽帧张数",
  zone: "分区", limit: "返回条数", "no-comment": "不开评论",
  "with-cover": "带封面", "dry-run": "只预览不发出",
};

/** 手写目录里标记 common 的命令，动态目录继续沿用，避免一次性把 100 条铺满侧栏。 */
const COMMON_IDS = new Set(
  BILI_CATALOG.flatMap((group) => group.items.filter((item) => item.common).map((item) => item.id)),
);

const CACHE_TTL_MS = 5 * 60 * 1000;
type Cache = { at: number; version: string | null; groups: BiliCatalogGroup[] };
let cache: Cache | null = null;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 命令标签：去掉括号补充，取第一句，最多 12 个字。 */
function shortLabel(help: string, raw: string): string {
  const normalized = help.replace(/\n/g, " ").replace(/[（(][^）)]*[）)]/g, "").trim();
  if (!normalized) return raw;
  const first = normalized.split(/[。；;：:，,]/)[0]?.trim().replace(/^[·\-\s]+/, "") ?? "";
  if (!first) return raw;
  return first.length > 12 ? first.slice(0, 12) + "…" : first;
}

function paramLabel(help: string, fallback: string): string {
  const preset = PARAM_LABELS[fallback];
  if (preset) return preset;
  const normalized = help
    .replace(/\n/g, " ")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/^(auto|hd|preview|all|default|both)[\s：:]*/i, "")
    .trim();
  const first = normalized.split(/[。；;：:，,]/)[0]?.trim() ?? "";
  if (!first || /^[\x00-\x7F]+$/.test(first)) return fallback;
  return first.length > 24 ? first.slice(0, 24) + "…" : first;
}

function isWriteCommand(raw: string): boolean {
  const id = raw.replace(/\s+/g, ".");
  if (NON_WRITE_COMMANDS.has(id)) return false;
  const parts = raw.split(/\s+/).slice(1);
  return parts.some((part) => WRITE_VERBS.has(part));
}

function mapParam(spec: unknown): BiliCatalogParam | null {
  const record = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
  const name = text(record.name);
  if (!name) return null;
  const kind = text(record.kind);
  const type = text(record.type);
  const help = text(record.help);
  const defaultValue = record.default;
  const flags = Array.isArray(record.flags)
    ? record.flags.filter((flag): flag is string => typeof flag === "string" && flag.trim().length > 0)
    : [];
  const isInt = type.includes("int");
  const isBool = type === "bool" || type === "boolean" || typeof defaultValue === "boolean";

  if (kind === "argument") {
    return {
      key: name,
      label: paramLabel(help, name),
      pos: true,
      type: isInt ? "int" : "text",
      default: defaultValue === null || defaultValue === undefined ? "" : String(defaultValue),
      ph: help.slice(0, 40) || name,
    };
  }

  const flag = flags[0];
  if (!flag) return null;
  if (isBool) {
    return {
      key: name,
      label: paramLabel(help, flag.replace(/^-+/, "")),
      flag,
      type: "bool",
      default: "",
      ph: help.slice(0, 40),
    };
  }
  return {
    key: name,
    label: paramLabel(help, flag.replace(/^-+/, "")),
    flag,
    type: isInt ? "int" : "text",
    default: defaultValue === null || defaultValue === undefined ? "" : String(defaultValue),
    ph: help.slice(0, 40),
  };
}

/** 把 `bili schema` 的 data 部分映射成目录；没有命令时返回 null。 */
export function mapSchemaToGroups(data: unknown): { version: string | null; groups: BiliCatalogGroup[] } | null {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const commands = Array.isArray(record.commands) ? record.commands : [];
  if (commands.length === 0) return null;

  const buckets = new Map<string, BiliCatalogItem[]>();
  for (const rawItem of commands) {
    const item = (rawItem && typeof rawItem === "object" ? rawItem : {}) as Record<string, unknown>;
    const raw = text(item.command).replace(/^bili\s+/, "");
    if (!raw) continue;
    const argv = raw.split(/\s+/).filter(Boolean);
    const group = GROUP_NAMES[argv[0] ?? ""] ?? argv[0] ?? "其他";
    const params = (Array.isArray(item.params) ? item.params : [])
      .map(mapParam)
      .filter((param): param is BiliCatalogParam => Boolean(param));
    const id = argv.join(".");
    const entry: BiliCatalogItem = {
      id,
      label: shortLabel(text(item.help), raw),
      argv,
      write: isWriteCommand(raw),
      params,
      common: COMMON_IDS.has(id),
    };
    const bucket = buckets.get(group) ?? [];
    bucket.push(entry);
    buckets.set(group, bucket);
  }

  const ordered = [...buckets.keys()]
    .sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a);
      const bi = GROUP_ORDER.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.localeCompare(b);
    })
    .map((group) => ({ group, items: buckets.get(group) ?? [] }));

  // 「刷B站」是面板自己的入口，不在 bili schema 里；保留在最前面。
  const dutyGroup = BILI_CATALOG.find((group) => group.group === "刷B站");
  const groups: BiliCatalogGroup[] = dutyGroup
    ? [{ group: dutyGroup.group, items: [...dutyGroup.items] }, ...ordered]
    : ordered;

  // 升级自检也是本地面板项，挂到「系统」组最前面。
  const selfcheck = BILI_CATALOG
    .flatMap((group) => group.items)
    .find((item) => item.id === "selfcheck");
  if (selfcheck) {
    const system = groups.find((group) => group.group === "系统");
    if (system) system.items = [selfcheck, ...system.items];
    else groups.push({ group: "系统", items: [selfcheck] });
  }

  return {
    version: typeof record.version === "string" ? record.version : null,
    groups,
  };
}

/** 读 schema（5 分钟缓存）；失败时回退手写目录。 */
export async function loadBiliCatalog(): Promise<{
  groups: BiliCatalogGroup[];
  version: string | null;
  fromSchema: boolean;
}> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return { groups: cache.groups, version: cache.version, fromSchema: true };
  }

  try {
    const payload = await biliJson(["schema"], { timeoutMs: 60_000 });
    const data = (payload && typeof payload === "object" ? payload as Record<string, unknown> : {}).data;
    const mapped = mapSchemaToGroups(data);
    if (mapped) {
      cache = { at: now, version: mapped.version, groups: mapped.groups };
      return { ...mapped, fromSchema: true };
    }
  } catch {
    // CLI 没装、超时或 schema 结构变了：用手写目录兜底。
  }

  return { groups: BILI_CATALOG, version: null, fromSchema: false };
}
