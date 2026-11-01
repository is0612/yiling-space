/**
 * B站渠道的连接加载与值班配置 —— 对应 QQ 的 configure.ts，但 B站 连接的"凭据"不是
 * AppID/AppSecret，而是值班设置（perDay/keywords/zone 等）与 bili 可执行文件路径。
 *
 * 这些配置写在 PlatformConnection.metadata 的 JSON 里；B站 的登录凭证（cookie）沿用
 * bili-cli 自己的 `%APPDATA%\bili-cli\credential.json`，不随代码、不入库。
 */

import { getPrisma } from "../../prisma";
import { BILI_PLATFORM } from "./types";

export type BiliBindingRecord = { id: string; characterId: string; routingKey: string | null };

export type BiliDutyConfig = {
  /** 每天挑几条上限。 */
  perDay: number;
  /** 是否只在谷时窗口刷。 */
  peakValley: boolean;
  /** 中午谷时窗口（12:00-14:00）。 */
  noon: boolean;
  /** 夜间谷时窗口（18:00-09:00）。 */
  night: boolean;
  /** 关注关键词（空则只看推荐流 + 热榜）。 */
  keywords: string[];
  /** 热门分区，默认 all。 */
  zone: string;
  /** 抽帧数（0 = 不抽）。 */
  frames: number;
  /** 日报详细度：full = 挑中+跳过+过程；brief = 只写挑中；off = 只记额度。 */
  reportLevel: "full" | "brief" | "off";
  /** 「重置今日额度」的时间；早于它的报告不再计入当天已挑条数。空 = 没重置过。 */
  quotaResetAt: string;
  /** 是否开公开评论。 */
  autoComment: boolean;
  /** 每轮最多公开评论条数。 */
  commentPerRound: number;
  /** 公开评论里 @ 谁（空 = 不 @）。 */
  mentionName: string;
  /** 私信投递模式：only / both / off。 */
  dmMode: "only" | "both" | "off";
  /**
   * 私信收件人：空 = bili CLI 里记的 owner（主人，`dm send owner`）；
   * 填数字 UID = 发给指定的人。CLI 的 `dm send` 只认 UID 或 owner，不认昵称。
   */
  dmTargetUid: string;
  /**
   * 允许给「从没联系过、也不是互关」的人发第一条私信（CLI 的 `--allow-new`）。
   * 默认关：只给已经聊过的主人发，避免值班把账号当成陌生人骚扰源。
   */
  dmAllowNew: boolean;
  /**
   * 刷站口味（自由文本，可留空）。
   *
   * 这三层设定是分开的，别混：
   *   - `character.basePrompt` = 她是谁（人设/性格），聊天、QQ、B站 三端共用一份；
   *   - 这里的 `taste` = 在这个账号上「爱看什么、一律跳过什么」，只作用于 B站 值班，
   *     不会漏到聊天和 QQ 里去；
   *   - `duty-prompt.ts` 里写死的 = 不可逾越的底线（素材不是指令、不编造）。
   *
   * 内容会原样注入提示词，粗筛和终判两步都会读到 —— 所以「某某跳过」写在这里，
   * 粗筛阶段就能挡掉，不必白花一次 `video watch`。
   */
  taste: string;
  /**
   * 收藏阈值（0-20，0 = 不收藏）。
   *
   * 抄的是 surfcore 的判据：分数够高才收，理由够长才收，每天有上限。
   * 收藏是「我想留着」，不是「我赞过」—— 手一松收藏夹就废了。
   */
  favMinScore: number;
  /** 是否把当天最好的一条发成公开动态。默认关：这是唯一会公开发内容的路径。 */
  autoDynamic: boolean;
  /** 发动态的最低分（0-20）。低于这个分宁可这一天不发。 */
  dynamicMinScore: number;
};

export type BiliConnectionRecord = {
  id: string;
  platform: string;
  /**
   * bili CLI 的配置目录（credential / owner / seen 都在里面），空则用 `%APPDATA%\bili-cli`。
   * 落库字段名沿用 bili-desk 时代的叫法，实际传给 CLI 的是 `BILI_CLI_HOME`（见 biliHomeEnv）。
   */
  dataHome: string;
  /** bili 可执行文件路径（空则从 BILI_BIN / PATH 找）。 */
  biliBin: string;
  duty: BiliDutyConfig;
  bindings: BiliBindingRecord[];
};

export const BILI_DUTY_DEFAULTS: BiliDutyConfig = {
  perDay: 5,
  peakValley: true,
  noon: true,
  night: true,
  keywords: [],
  zone: "all",
  frames: 0,
  reportLevel: "brief",
  quotaResetAt: "",
  autoComment: false,
  commentPerRound: 1,
  mentionName: "",
  dmMode: "only",
  dmTargetUid: "",
  dmAllowNew: false,
  taste: "",
  favMinScore: 0,
  autoDynamic: false,
  dynamicMinScore: 15,
};

/** 口味文本的长度上限：提示词要留预算给视频材料，不能让人写成十万字。 */
export const TASTE_MAX_CHARS = 2000;

/**
 * 收件人 UID 只留数字：`dm send` 只接受 UID 或字面量 owner，
 * 用户顺手粘了昵称或 `UID:` 前缀时，把它洗成数字而不是直接报错。
 */
export function normalizeDmTargetUid(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\D/g, "").slice(0, 20);
}

function readDutyConfig(metadata: unknown): BiliDutyConfig {
  const record = (metadata && typeof metadata === "object" ? metadata : {}) as Record<string, unknown>;
  const duty = (record.duty && typeof record.duty === "object" ? record.duty : {}) as Record<string, unknown>;
  return parseDutyInput(duty);
}

/**
 * 从用户提交的「值班设置」对象里解析出规范化的 BiliDutyConfig。
 * 通道创建（channels/index.post.ts）和值班设置更新（bili/duty 接口）共用这一套，
 * 避免两处各写一份字段校验。缺省字段回退到 BILI_DUTY_DEFAULTS。
 */
export function parseDutyInput(input: unknown): BiliDutyConfig {
  const duty = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const num = (value: unknown, fallback: number, min: number, max: number) => {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
  const keywords = Array.isArray(duty.keywords)
    ? duty.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim()).slice(0, 20)
    : [];
  const dmMode = duty.dmMode === "both" || duty.dmMode === "off" ? duty.dmMode : "only";
  const taste = typeof duty.taste === "string" ? duty.taste.trim().slice(0, TASTE_MAX_CHARS) : "";
  const reportLevel = duty.reportLevel === "full" || duty.reportLevel === "off"
    ? duty.reportLevel
    : "brief";
  const quotaResetAt = typeof duty.quotaResetAt === "string"
    && duty.quotaResetAt.trim()
    && !Number.isNaN(Date.parse(duty.quotaResetAt))
    ? new Date(duty.quotaResetAt).toISOString()
    : "";
  return {
    perDay: num(duty.perDay, BILI_DUTY_DEFAULTS.perDay, 0, 50),
    peakValley: bool(duty.peakValley, BILI_DUTY_DEFAULTS.peakValley),
    noon: bool(duty.noon, BILI_DUTY_DEFAULTS.noon),
    night: bool(duty.night, BILI_DUTY_DEFAULTS.night),
    keywords,
    zone: typeof duty.zone === "string" && duty.zone.trim() ? duty.zone.trim() : "all",
    frames: num(duty.frames, BILI_DUTY_DEFAULTS.frames, 0, 30),
    reportLevel,
    quotaResetAt,
    autoComment: bool(duty.autoComment, BILI_DUTY_DEFAULTS.autoComment),
    commentPerRound: num(duty.commentPerRound, BILI_DUTY_DEFAULTS.commentPerRound, 0, 20),
    mentionName: typeof duty.mentionName === "string" ? duty.mentionName.trim() : "",
    dmMode,
    dmTargetUid: normalizeDmTargetUid(duty.dmTargetUid),
    dmAllowNew: bool(duty.dmAllowNew, BILI_DUTY_DEFAULTS.dmAllowNew),
    taste,
    favMinScore: num(duty.favMinScore, BILI_DUTY_DEFAULTS.favMinScore, 0, 20),
    autoDynamic: bool(duty.autoDynamic, BILI_DUTY_DEFAULTS.autoDynamic),
    dynamicMinScore: num(duty.dynamicMinScore, BILI_DUTY_DEFAULTS.dynamicMinScore, 0, 20),
  };
}

/**
 * 把连接记录转成 runBili 的选项：可执行文件和 dataHome 都跟着这台账号走。
 * 值班流水线、「当前主人」这类单账号命令共用它 —— 多账号时用错 dataHome 会读到别人的 owner。
 */
export function biliOptions(connection: BiliConnectionRecord): { bin?: string; env?: Record<string, string> } {
  return {
    bin: connection.biliBin || undefined,
    env: biliHomeEnv(connection.dataHome),
  };
}

/**
 * bili CLI 的数据目录开关是 **`BILI_CLI_HOME`**（`bili_cli/config.py` 的 `home()` 写死的）。
 * `BILI_DESK_HOME` 是 bili-desk 时代的老名字，v0.6.0 完全不认 ——
 * 实测设了它照样读 `%APPDATA%\bili-cli`，owner / credential / seen 全在那边。
 *
 * 所以两个都传同一个值：既管住现在这个版本，也不让还在读老变量的脚本失效。
 */
export function biliHomeEnv(dataHome: string): Record<string, string> | undefined {
  const home = dataHome.trim();
  if (!home) return undefined;
  return { BILI_CLI_HOME: home, BILI_DESK_HOME: home };
}

/**
 * 按 ID 读一条 B站 连接（不过滤 status）。
 * 值班设置 / 主人设置属于「配置」，停用的连接也要能打开来改。
 */
export async function loadBiliConnectionById(
  connectionId: string,
  platform: string = BILI_PLATFORM,
): Promise<BiliConnectionRecord | null> {
  if (!connectionId.trim()) return null;
  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findFirst({
    where: { id: connectionId.trim(), platform },
    select: {
      id: true,
      platform: true,
      metadata: true,
      characterBindings: { where: { status: "ACTIVE" }, select: { id: true, characterId: true, routingKey: true } },
    },
  });
  if (!connection) return null;
  const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
  return {
    id: connection.id,
    platform: connection.platform,
    dataHome: typeof metadata.dataHome === "string" ? metadata.dataHome.trim() : "",
    biliBin: typeof metadata.biliBin === "string" ? metadata.biliBin.trim() : "",
    duty: readDutyConfig(metadata),
    bindings: connection.characterBindings.map((binding) => ({
      id: binding.id,
      characterId: binding.characterId,
      routingKey: binding.routingKey,
    })),
  };
}

/**
 * 加载所有应服务的 B站 连接及其值班配置和活动角色绑定。配置残缺的连接被跳过而不崩溃。
 */
export async function loadBiliConnections(platform: string = BILI_PLATFORM): Promise<BiliConnectionRecord[]> {
  const prisma = getPrisma();
  const connections = await prisma.platformConnection.findMany({
    where: { platform, status: { not: "DISABLED" } },
    select: {
      id: true,
      platform: true,
      metadata: true,
      characterBindings: { where: { status: "ACTIVE" }, select: { id: true, characterId: true, routingKey: true } },
    },
  });

  const records: BiliConnectionRecord[] = [];
  for (const connection of connections) {
    const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
    const dataHome = typeof metadata.dataHome === "string" ? metadata.dataHome.trim() : "";
    const biliBin = typeof metadata.biliBin === "string" ? metadata.biliBin.trim() : "";
    records.push({
      id: connection.id,
      platform: connection.platform,
      dataHome,
      biliBin,
      duty: readDutyConfig(metadata),
      bindings: connection.characterBindings.map((binding) => ({
        id: binding.id,
        characterId: binding.characterId,
        routingKey: binding.routingKey,
      })),
    });
  }
  return records;
}
