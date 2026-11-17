import type { FetchOptions } from "ofetch";

type RawFetch = <T>(url: string, options?: FetchOptions<"json">) => Promise<T>;

export type RequestConfig = {
  /** 不带 `/api` 前缀，由这里统一拼。 */
  url: string;
  method?: "get" | "post" | "put" | "patch" | "delete";
  /** 请求体，对应 ofetch 的 body。 */
  data?: unknown;
  /** URL 查询参数，对应 ofetch 的 query。 */
  params?: Record<string, unknown>;
};

/**
 * 全站请求入口：axios 风格的 `{ url, method, data, params }`。
 *
 * SSR 阶段走 `useRequestFetch()` 带上登录态；错误继续抛给调用方，
 * 由 `readApiErrorMessage` 统一翻译。
 */
export function request<T>(config: RequestConfig): Promise<T> {
  // Nuxt 的 $fetch 类型带路由推导，和"任意字符串路径"不兼容；这里只借用它的运行时能力。
  const fetchJson = (import.meta.server ? useRequestFetch() : $fetch) as unknown as RawFetch;
  const options: FetchOptions<"json"> = {};
  if (config.method) options.method = config.method.toUpperCase() as FetchOptions<"json">["method"];
  if (config.data !== undefined) options.body = config.data;
  if (config.params) options.query = config.params;
  return fetchJson<T>(`/api${config.url}`, options);
}
