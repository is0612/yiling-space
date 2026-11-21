/**
 * 表情包列表的排序与分页参数。
 *
 * 列表原来一次全给，由页面自己 `sort` + `slice` —— 攒到几十上百张以后，
 * 首屏要等全量 JSON 下来才画得出第一屏，排序也只在浏览器里做（换个排序等于重排整份数组）。
 * 现在把这两件事下推给数据库：接口收 `sort` / `page` / `pageSize`，页面只拿当前这一窗。
 *
 * 这里只放纯函数：解析 query、把排序键翻成 Prisma 的 `orderBy`。
 * 数页、回夹页码要 `total`，那部分留在接口里（需要查库）。
 */

/** 页面上的五档排序。值就是接口参数，改文案不用改这里。 */
export const STICKER_SORTS = ["recent", "oldest", "mostUsed", "lastUsed", "fresh"] as const;

/** 默认一页 12 张：与页面原来的分页档位一致，一屏两列刚好。 */
export const STICKER_PAGE_SIZE_DEFAULT = 12;
/** 上限 100：再大就不是「分页」了，补场景那边按 100 一页翻页取完。 */
export const STICKER_PAGE_SIZE_MAX = 100;

export function normalizeStickerSort(value: unknown): StickerSortKey {
  return STICKER_SORTS.includes(value as StickerSortKey) ? (value as StickerSortKey) : "recent";
}

function positiveInt(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export type StickerListParams = {
  sort: StickerSortKey;
  /** 请求的页码。可能超过实际页数，由接口查完 `total` 后再回夹。 */
  page: number;
  pageSize: number;
  /** 只看还没写「什么时候用」的 —— 「逐张补场景」要先拿到全量未打标的，而不是当前页。 */
  untaggedOnly: boolean;
};

export function parseStickerListParams(query: Record<string, unknown>): StickerListParams {
  return {
    sort: normalizeStickerSort(query.sort),
    page: positiveInt(query.page, 1),
    pageSize: positiveInt(query.pageSize, STICKER_PAGE_SIZE_DEFAULT, STICKER_PAGE_SIZE_MAX),
    untaggedOnly: query.untagged === "1" || query.untagged === "true",
  };
}

/**
 * 排序键 → Prisma `orderBy`。
 *
 * 每档都补一个 `id` 兜底：`useCount` 为 0 的一大把，值相等时 Postgres 不保证顺序，
 * 翻页就会出现「同一张出现在第 1 页和第 2 页、另一张谁也见不到」。
 *
 * `lastUsed` 用 `nulls: "last"` —— 一次没用过的 `lastUsedAt` 是 null，
 * 默认 Postgres 把 null 当最大值排在最前，那这一档就变成「先看没用的」了。
 */
export function stickerOrderBy(sort: StickerSortKey) {
  switch (sort) {
    case "oldest":
      return [{ createdAt: "asc" as const }, { id: "asc" as const }];
    case "mostUsed":
      return [{ useCount: "desc" as const }, { createdAt: "desc" as const }, { id: "desc" as const }];
    case "lastUsed":
      return [
        { lastUsedAt: { sort: "desc" as const, nulls: "last" as const } },
        { createdAt: "desc" as const },
        { id: "desc" as const },
      ];
    case "fresh":
      // 「一直没用过的」：次数升序就够 0 在前，同档里新的先露面（和原来页面里的顺序一致）。
      return [{ useCount: "asc" as const }, { createdAt: "desc" as const }, { id: "desc" as const }];
    case "recent":
    default:
      return [{ createdAt: "desc" as const }, { id: "desc" as const }];
  }
}

/** 页数。0 条也算一页：页面拿到 totalPages=1 才画得出「第 1/1 页」而不是「第 1/0 页」。 */
export function totalPagesOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 把请求页码夹进真实范围：删到最后一页只剩一两张时，页码会越界。 */
export function clampPage(page: number, totalPages: number): number {
  return Math.min(Math.max(1, page), totalPages);
}
