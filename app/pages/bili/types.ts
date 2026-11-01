/**
 * B站值班台的数据类型 —— 从页面里拆出来，侧栏 / 概览 / 命令台 / 各弹窗共用一份。
 *
 * 这些形状对应服务端 `/api/admin/bili/*` 的返回，改动时两边一起看：
 *   dashboard → server/api/admin/bili/dashboard.get.ts
 *   catalog   → server/api/admin/bili/catalog.get.ts
 *   run       → server/api/admin/bili/run.post.ts
 *   me        → server/api/admin/bili/me.get.ts
 */

export type BiliReport = { id: string; roundIndex: number; pickedCount: number; content: string; createdAt: string };

export type BiliSeen = { bvid: string; title: string; author: string; result: string; reason: string; score: number | null; seenAt: string };

export type BiliBinding = {
  bindingId: string; characterId: string; characterName: string;
  pickedToday: number; remaining: number; perDay: number;
  reports: BiliReport[]; seenToday: BiliSeen[];
};

export type BiliAccount = {
  connectionId: string; displayName: string; dataHome: string; biliBin: string;
  duty: {
    perDay: number; peakValley: boolean; noon: boolean; night: boolean;
    keywords: string[]; zone: string; frames: number;
    /** 日报详细度：full / brief / off。 */
    reportLevel: "full" | "brief" | "off";
    /** 上次重置今日额度的时间；早于它的报告不计入已挑条数。 */
    quotaResetAt: string;
    autoComment: boolean; commentPerRound: number; mentionName: string;
    dmMode: "only" | "both" | "off";
    /** 私信收件人 UID，空 = 主人（bili CLI 的 owner）。 */
    dmTargetUid: string;
    /** 允许给陌生人发第一条私信（CLI 的 --allow-new）。 */
    dmAllowNew: boolean;
    /** 刷站口味（自由文本），只作用于 B站 值班，不影响聊天与 QQ。 */
    taste: string;
    /** 收藏阈分，0 = 不收藏。 */
    favMinScore: number;
    /** 是否把当天最好的一条发成公开动态。 */
    autoDynamic: boolean;
    dynamicMinScore: number;
  };
  nextWindow: "noon" | "night" | null;
  bindings: BiliBinding[];
};

export type DashboardData = { today: string; accounts: BiliAccount[] };

export type BiliCatalogParam = {
  key: string; label: string; pos?: boolean; flag?: string;
  type?: "text" | "int" | "bool" | "select"; default?: string; choices?: string[]; ph?: string;
};

export type BiliCatalogItem = {
  id: string; label: string; argv: string[]; write?: boolean; kind?: string;
  params?: BiliCatalogParam[]; common?: boolean;
};

export type BiliCatalogGroup = { group: string; items: BiliCatalogItem[] };

export type BiliRunResult = {
  code: number | null; json: unknown; stdout: string; stderr: string;
  elapsed: number; argv: string[]; timedOut: boolean;
};

export type RunLogEntry = { id: string; label: string; argv: string[]; at: string; ok: boolean; seconds: number };

/** `bili me show` 归一化后的账号资料（服务端 parseBiliMe 产出）。 */
export type BiliMe = {
  mid: string; name: string; face: string; level: number; sign: string; homeUrl: string;
};

/** `bili owner show` 的当前主人。 */
export type BiliOwner = { mid: string; name: string };
