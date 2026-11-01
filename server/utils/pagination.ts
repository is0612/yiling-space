import { createError } from "h3";

/**
 * 列表接口的统一分页口径。
 *
 * 约定：`?page=1&pageSize=20`，返回 `{ items, total, page, pageSize, totalPages, hasMore }`。
 * 后端只负责「别让一次查询无限大」，前端切片还是靠这几个数字自己算。
 *
 * 为什么要统一：审计日志、任务、消息这三张表只增不减，一旦上服务器，
 * 全量返回迟早会把内存和响应时间一起拖死。分页参数写错时直接 400，
 * 比悄悄退化成默认值更容易发现前端 bug。
 */

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;

function readPositiveInt(value: unknown, fallback: number, label: string, maximum: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw createError({ statusCode: 400, statusMessage: `${label} 参数无效。` });
  }
  const number = Number(raw.trim());
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw createError({ statusCode: 400, statusMessage: `${label} 必须在 1 到 ${maximum} 之间。` });
  }
  return number;
}

export type PageQuery = {
  page: number;
  pageSize: number;
  /** 直接喂给 Prisma 的 `skip` */
  skip: number;
};

/**
 * 读分页入参。
 *
 * `legacySizeKey` 给老接口留兼容位：审计页原来用 `?limit=30`，任务页也用 `limit`，
 * 现在仍接受它，但语义就是 pageSize（旧参数没有 page，等于第一页取 N 条）。
 */
export function readPageQuery(
  query: Record<string, unknown>,
  options: { defaultPageSize?: number; maxPageSize?: number; legacySizeKey?: string } = {},
): PageQuery {
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
  const defaultPageSize = Math.min(options.defaultPageSize ?? DEFAULT_PAGE_SIZE, maxPageSize);
  const page = readPositiveInt(query.page, 1, "page", MAX_PAGE);
  const sizeValue = query.pageSize ?? (options.legacySizeKey ? query[options.legacySizeKey] : undefined);
  const pageSize = readPositiveInt(sizeValue, defaultPageSize, "pageSize", maxPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
};

/** 把「本页数据 + 总数」拼成统一返回体。空库时 totalPages 仍是 1，前端不必特判 0。 */
export function buildPage<T>(items: T[], total: number, page: number, pageSize: number): PageResult<T> {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { items, total, page, pageSize, totalPages, hasMore: page < totalPages };
}
