/**
 * 角色的梗语录：她会**原样说出来**的那几句口头禅。
 *
 * 和 `stickers.ts` 同构（清单 + 缓存 + 挑选），但有三处刻意的不同：
 *
 * 1. **不排队剔除，只压后**。表情包刚用过的那张直接剔掉；梗不能那么干 ——
 *    一个角色可能只有三条梗，剔掉一条就是「今天没梗可说」。
 * 2. **没说过（`useCount === 0`）的排最前**。贴纸是靠「没用过的先露面」让新素材
 *    有出场机会；梗的诉求更直接：刚加完一句，用户想马上听见她说，等三天就以为坏了。
 * 3. **冷却按时间算，不按消息条数**。条数要在每轮回复时维护一个计数器，
 *    而 `lastUsedAt` 本来就要写（统计用），顺手就能当冷却依据。
 */

export type CatchphraseCatalogEntry = {
  id: string;
  /** 台账，模型原样使用。 */
  phrase: string;
  /** 什么时候说，进提示词。 */
  usage: string;
  /** 说过几次。用于「没说过的最先露面」，不进提示词。 */
  useCount?: number;
  /** 上次说的时刻（毫秒）。冷却靠它算，不进提示词。 */
  lastUsedAtMs?: number | null;
};

/**
 * 同一句梗的冷却：两小时内不再主动说。
 *
 * 这个数值不是拍的 —— 网页对话一小时大概几十轮，如果只隔三五轮就允许复用，
 * 「不烧心吗」一天能出现十几次，角色立刻变成复读机。两小时足够让它像口头禅
 * 而不像卡带。宁可长一点：梗的价值在于「哎她又说这句了」，不在于出现频率。
 */
export const CATCHPHRASE_COOLDOWN_MS = 2 * 60 * 60 * 1000;

/** 从群里捡回来的梗要等用户点头。这三档是 `character_catchphrases.status` 的全部取值。 */
export const CATCHPHRASE_STATUS = {
  /** 刚捡回来，还没确认。不进候选池。 */
  pending: "PENDING",
  /** 正常可用。手动加的直接是这个。 */
  active: "ACTIVE",
  /** 用户否掉了。**不删行** —— 删了下一轮扫描会再捡回来。 */
  rejected: "REJECTED",
} as const;

export type CatchphraseStatus = (typeof CATCHPHRASE_STATUS)[keyof typeof CATCHPHRASE_STATUS];

/**
 * 一次最多塞几条进提示词。
 *
 * 梗是一句话，token 很便宜，所以上限比表情包（12）宽松。但也不能无限：
 * 40 条梗全塞进去，模型挑的时候会犹豫，反而不如 15 条挑得准。
 */
export const CATCHPHRASE_PROMPT_LIMIT = 15;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; entries: CatchphraseCatalogEntry[] }>();

const CATCHPHRASE_CATALOG_SELECT = {
  id: true,
  phrase: true,
  usage: true,
  useCount: true,
  lastUsedAt: true,
} as const;

type CatchphraseRow = {
  id: string;
  phrase: string;
  usage: string;
  useCount: number;
  lastUsedAt: Date | null;
};

export function invalidateCatchphraseCache(characterId?: string): void {
  if (characterId) cache.delete(characterId);
  else cache.clear();
}

/**
 * 一个角色**能用**的梗清单：停用的、待确认的、被否掉的都不在这里。
 *
 * 库查不动就当没有 —— 梗不是主流程，不该让整条回复因为一张表读失败而崩掉（同 stickers）。
 */
export async function loadCatchphraseCatalog(
  characterId: string,
  prisma?: {
    characterCatchphrase: {
      findMany: (args: { where: { characterId: string; enabled?: boolean; status?: string }; orderBy?: unknown; select?: unknown }) => Promise<readonly CatchphraseRow[]>;
    };
  },
): Promise<CatchphraseCatalogEntry[]> {
  const cached = cache.get(characterId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;

  let rows: readonly CatchphraseRow[] = [];
  try {
    const where = { characterId, enabled: true, status: CATCHPHRASE_STATUS.active };
    rows = prisma
      ? await prisma.characterCatchphrase.findMany({
          where,
          orderBy: { createdAt: "asc" },
          select: CATCHPHRASE_CATALOG_SELECT,
        })
      : await defaultCatchphraseQuery(characterId);
  } catch {
    rows = [];
  }

  const entries: CatchphraseCatalogEntry[] = rows.map((row) => ({
    id: row.id,
    phrase: row.phrase,
    usage: row.usage,
    useCount: row.useCount,
    lastUsedAtMs: row.lastUsedAt ? row.lastUsedAt.getTime() : null,
  }));
  cache.set(characterId, { at: Date.now(), entries });
  return entries;
}

async function defaultCatchphraseQuery(characterId: string): Promise<readonly CatchphraseRow[]> {
  const { getPrisma } = await import("./prisma");
  return getPrisma().characterCatchphrase.findMany({
    where: { characterId, enabled: true, status: CATCHPHRASE_STATUS.active },
    orderBy: { createdAt: "asc" },
    select: CATCHPHRASE_CATALOG_SELECT,
  }) as Promise<readonly CatchphraseRow[]>;
}

/**
 * 挑这一轮给她看的梗。
 *
 * 分三档，依次排：
 *   ① 没说过（`useCount === 0`）—— 刚加的，用户等着听；
 *   ② 可以再说（过了冷却）—— 打乱，避免总是同一批排在前面；
 *   ③ 还在冷却 —— 只能垫底。**不剔除**：全在冷却时还得有梗可说，
 *      否则「冷却」会变成「禁言」。
 *
 * 打乱而不是按 `useCount` 严格升序：严格升序每次都给出同一批「最冷的」，
 * 而梗不像表情包需要平均分配 —— 用户最喜欢的那个梗就该多说几次。
 * `random` 可注入，测试里用固定序列断言顺序。
 */
export function pickCatchphraseCatalog(
  entries: readonly CatchphraseCatalogEntry[],
  limit = CATCHPHRASE_PROMPT_LIMIT,
  now = Date.now(),
  random: () => number = Math.random,
): CatchphraseCatalogEntry[] {
  const fresh: CatchphraseCatalogEntry[] = [];
  const ready: CatchphraseCatalogEntry[] = [];
  const cooling: CatchphraseCatalogEntry[] = [];

  for (const entry of entries) {
    const used = (entry.useCount ?? 0) > 0;
    const lastUsed = entry.lastUsedAtMs ?? null;
    const isCooling = lastUsed !== null && now - lastUsed < CATCHPHRASE_COOLDOWN_MS;
    if (isCooling) cooling.push(entry);
    else if (used) ready.push(entry);
    else fresh.push(entry);
  }

  return [...shuffle(fresh, random), ...shuffle(ready, random), ...shuffle(cooling, random)].slice(0, limit);
}

/** Fisher-Yates。不改原数组：清单对象是缓存里那一份，就地打乱会让缓存本身变成乱序。 */function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = result[index]!;
    result[index] = result[target]!;
    result[target] = current;
  }
  return result;
}

export type CatchphrasePromptEntry = {
  id: string;
  phrase: string;
  usage?: string;
  /** 还在冷却里。提示词用它说「这句刚说过，除非没别的合适否则别再说」。 */
  justSaid?: boolean;
};

/**
 * 转成进提示词的形状。
 *
 * 台词一个字都不动：截断在这里是致命的 —— 「xxx 不烧心吗」被切成两半，
 * 模型会照着残句说，或者干脆不说。长度上限在写入时就把住了（200 字符）。
 */
export function toCatchphrasePromptEntries(
  entries: readonly CatchphraseCatalogEntry[],
  now = Date.now(),
): CatchphrasePromptEntry[] {
  return entries.map((entry) => {
    const lastUsed = entry.lastUsedAtMs ?? null;
    return {
      id: entry.id,
      phrase: entry.phrase,
      ...(entry.usage.trim() ? { usage: entry.usage.trim() } : {}),
      ...(lastUsed !== null && now - lastUsed < CATCHPHRASE_COOLDOWN_MS ? { justSaid: true } : {}),
    };
  });
}

/**
 * 记一次使用：计次 + 盖时间戳（冷却的依据）。
 *
 * 用 `updateMany ... where characterId` 而不是 `update where id`：模型返回的 id
 * 来自提示词，理论上可能被上一轮的清单串味（换角色、删了又加）。带上 characterId
 * 就绝不会写到别人头上。
 *
 * 失败静默：回复已经发出去了，这时候抛错只会让调用方把一条成功的回复判成失败。
 */
export async function markCatchphrasesUsed(
  characterId: string,
  ids: readonly string[],
  now = new Date(),
): Promise<void> {
  const unique = [...new Set(ids)].slice(0, 5);
  if (!unique.length) return;
  try {
    const { getPrisma } = await import("./prisma");
    await getPrisma().characterCatchphrase.updateMany({
      // 带上 status：待确认 / 已否掉的梗不该被记账（它们压根没进过候选池）。
      where: { characterId, status: CATCHPHRASE_STATUS.active, id: { in: unique } },
      data: { useCount: { increment: 1 }, lastUsedAt: now },
    });
    invalidateCatchphraseCache(characterId);
  } catch {
    // 记账不是主流程，吞掉。
  }
}

/** 捡回来时的依据。弹窗要回答「她凭什么觉得这是梗」，只给台词是答不上的。 */
export type CatchphraseEvidence = {
  /** 从哪个群捡的（群号或会话标题）。 */
  groupLabel?: string;
  /** 观察窗口内出现几次。 */
  count?: number;
  /** 几个人说过。一个人反复说同一句是口吃，不是梗。 */
  speakers?: number;
  /** 原话几条，最多 3 条。 */
  samples?: string[];
};

export type CatchphraseDto = {
  id: string;
  phrase: string;
  usage: string;
  enabled: boolean;
  /** PENDING 的只在弹窗里出现；REJECTED 的页面上完全不显示。 */
  status: CatchphraseStatus;
  evidence: CatchphraseEvidence | null;
  useCount: number;
  lastUsedAt: string | null;
  source: string;
  /** 是否还在冷却里。页面据此标「刚说过，暂时不会再用」，省得用户以为关了没生效。 */
  cooling: boolean;
  createdAt: string;
};

export function toCatchphraseDto(
  row: {
    id: string;
    phrase: string;
    usage: string;
    enabled: boolean;
    status?: string | null;
    evidence?: unknown;
    useCount: number;
    lastUsedAt: Date | null;
    source?: string | null;
    createdAt: Date;
  },
  now = Date.now(),
): CatchphraseDto {
  return {
    id: row.id,
    phrase: row.phrase,
    usage: row.usage,
    enabled: row.enabled,
    // 老数据没有 status（迁移前建的）一律当 ACTIVE：它们是用户手填的。
    status: (row.status || CATCHPHRASE_STATUS.active) as CatchphraseStatus,
    evidence: readEvidence(row.evidence),
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    source: row.source || "manual",
    cooling: row.lastUsedAt !== null && now - row.lastUsedAt.getTime() < CATCHPHRASE_COOLDOWN_MS,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * evidence 是 Json 列，读回来是 unknown。这里只挑认识的字段 ——
 * 直接把它扔给前端，页面上一个多余的键就可能把 `samples.map` 变成崩溃。
 */
function readEvidence(value: unknown): CatchphraseEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const evidence: CatchphraseEvidence = {};
  if (typeof record.groupLabel === "string" && record.groupLabel.trim()) {
    evidence.groupLabel = record.groupLabel.trim().slice(0, 120);
  }
  if (typeof record.count === "number" && Number.isFinite(record.count)) evidence.count = Math.round(record.count);
  if (typeof record.speakers === "number" && Number.isFinite(record.speakers)) evidence.speakers = Math.round(record.speakers);
  if (Array.isArray(record.samples)) {
    const samples = record.samples
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .map((item) => item.trim().slice(0, 200))
      .slice(0, 3);
    if (samples.length) evidence.samples = samples;
  }
  return Object.keys(evidence).length ? evidence : null;
}
