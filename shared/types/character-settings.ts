/**
 * 角色设置域（记忆归档 / 口头禅 / 表情库 / 用量 / 助手探针 / 主动行为）的共享契约。
 *
 * `ProactiveSettings` 与 `GroupInitiativeSettings` 不在这里重复定义 —— 它们属于角色本体，
 * 已经在 `shared/types/character.ts` 里，这里只 re-export 方便调用方就近取。
 */

import type { Character, GroupInitiativeSettings, ProactiveSettings } from "./character";

/** 记忆归档设置：生效值 + 待生效值 + 清理策略。 */
export type MemorySettings = {
  snapshotIntervalDays: number;
  activeSnapshotIntervalDays: number;
  pendingSnapshotIntervalDays: number | null;
  timezone: string;
  anchorAt: string;
  rawMessageRetentionDays: number;
  rawMessageCleanupEnabled: boolean;
  autoSnapshotEnabled: boolean;
  changePolicy: "NEXT_CYCLE" | "IMMEDIATE_RECALC";
  nextSnapshotAt: string | null;
  updatedAt: string;
  cancelledPendingJobs?: number;
};

/** 最近一次原始消息清理的结果；没有清理过时为 null。 */
export type MemoryCleanupSummary = {
  at: string;
  cutoff: string | null;
  deletedMessages: number | null;
  contextMessages: number | null;
  contextCutoff: string | null;
};

/** 提交修改（**请求**）：只带会被改的字段，不需要生效值。 */
export type MemorySettingsPatch = {
  snapshotIntervalDays: number;
  timezone: string;
  anchorAt: string;
  rawMessageRetentionDays: number;
  rawMessageCleanupEnabled: boolean;
  autoSnapshotEnabled: boolean;
  changePolicy: "NEXT_CYCLE" | "IMMEDIATE_RECALC";
};

export type CatchphraseEvidence = {
  groupLabel?: string;
  count?: number;
  speakers?: number;
  samples?: string[];
};

export type CatchphraseItem = {
  id: string;
  phrase: string;
  usage: string;
  status: "PENDING" | "ACTIVE" | "REJECTED";
  enabled: boolean;
  evidence: CatchphraseEvidence | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
  /** 后端算好的「还在冷却里」，页面不自己算。 */
  cooling: boolean;
};

export type CatchphraseScanResult = {
  scanned: number;
  candidates: number;
  created: number;
  skipped: number;
};

export type StickerItem = {
  id: string;
  name: string;
  usage: string;
  enabled: boolean;
  mimeType: string;
  sizeBytes: number;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  source: string;
  qqEmojiId: string | null;
  deletedAt: string | null;
};

/** 贴图操作对 QQ 侧的影响（推送表情 / 失败原因）。 */
export type QqSideEffect = { ok: boolean; emojiId?: string; error?: string; skipped?: boolean };

export type StickerStats = { total: number; disabled: number; untagged: number; qqLinked: number };

export type StickerList = {
  items: StickerItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stats: StickerStats;
};

export type StickerSortKey = "recent" | "oldest" | "mostUsed" | "lastUsed" | "fresh";

export type StickerSyncReport = {
  ok: boolean;
  connectionId: string;
  qqTotal: number;
  localTotal: number;
  imported: number;
  adopted: number;
  importedFailed: number;
  rebound: number;
  restored: number;
  trashed: number;
  retriedDelete: number;
  retryDeleteFailed: number;
  pushed: number;
  pushFailed: number;
  pushMissingFile: number;
  namesSynced: number;
  nameSyncFailed: number;
  importOverflow: number;
  pushOverflow: number;
  warnings: string[];
};

export type StickerTrashItem = StickerItem & { deletedAt: string };

export type StickerTrashPayload = {
  items: StickerTrashItem[];
  purged: number;
  retentionDays: number;
};

export type StickerUsageSuggestion = { usage: string; source: "vision" | "name" };
export type StickerRelabelResult = { skipped: boolean; message?: string; sticker?: StickerItem };

export type DailyUsage = {
  day: string;
  usage: {
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    calls: number;
    byKind: Record<string, { totalTokens: number; calls: number }>;
  };
  quota: { limit: number; used: number; remaining: number; exceeded: boolean };
};

export type ModelCatalogResult = {
  ok: boolean;
  models: string[];
  message: string;
  unsupported?: boolean;
};

export type ConnectionProbeResult = {
  ok: boolean;
  message: string;
  elapsedMs?: number;
  detail?: string;
  model?: string;
  voice?: string;
};

/** 对话页里的四个后台助手；知识助手没有连通性探针。 */
export type AssistantKind = "memory" | "context" | "knowledge" | "social";
export type AssistantWithProbe = Exclude<AssistantKind, "knowledge">;

export type GroupInitiativeSnapshot = {
  settings: GroupInitiativeSettings;
  status: {
    canSendNow: boolean;
    reason: string;
    reasonLabel: string;
    groups: Array<{
      groupId: string;
      idleMinutes: number;
      sentToday: number;
      lastInitiativeAt: string | null;
      canSendNow: boolean;
      reason: string;
      reasonLabel: string;
    }>;
  };
};

export type ProactiveSnapshot = {
  settings: ProactiveSettings;
  group: GroupInitiativeSnapshot;
  status: {
    sentToday: number;
    pendingCount: number;
    recipient: string | null;
    lastSentAt: string | null;
    gapRemainingMinutes: number;
    quietNow: boolean;
    quotaExceeded: boolean;
    canSendNow: boolean;
    reason: string;
    reasonLabel: string;
  };
  recent: Array<{
    id: string;
    kind: string;
    goal: string;
    status: string;
    content: string | null;
    confidence: number;
    sentAt: string | null;
  }>;
};

export type ProactiveTryResult = {
  status: string;
  reason: string;
  reasonLabel: string;
  content: string | null;
  detail: string | null;
};

export type GroupProactiveTryResult = ProactiveTryResult & { groupId: string | null };

/**
 * 替换导入时清掉的本机内容，只统计随卡走的那一层。
 * 会话原文、渠道绑定、表情包图片与条目、其他用户的私人范围都不在内。
 */
export type ImportedCharacterRemoved = {
  memories: number;
  events: number;
  eventDays: number;
  snapshots: number;
  journals: number;
  journalRevisions: number;
  catchphrases: number;
  interactionGuidance: number;
  channelPolicies: number;
  expressionHabits: number;
  goals: number;
  preferences: number;
  visualOutfits: number;
  visualVersions: number;
  visualAssets: number;
  /** 成长数据（知识 / 社交 / 反思 / 成长事件）清掉的行数合计。 */
  growthRows: number;
};

/** 导入角色的结果：成功时带回整份角色 + 本次新增/计数的泛型载荷。 */
export type ImportedCharacterResult<
  TAdded = Record<string, unknown>,
  TCounts = Record<string, unknown>,
  TRemoved = ImportedCharacterRemoved,
> = {
  character: Character;
  /** new = 新建；merge = 并进已有角色；replace = 以卡为准重灌。 */
  mode: "new" | "merge" | "replace";
  counts: TCounts;
  added: TAdded;
  /** 只有 replace 才带：清掉了本机多少内容。 */
  removed?: TRemoved;
  warnings?: string[];
};
