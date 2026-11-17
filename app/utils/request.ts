import type { FetchOptions } from "ofetch";

export type RawFetch = <T>(url: string, options?: FetchOptions<"json">) => Promise<T>;
export type RequestConfig = {
  /** Internal API path without the /api prefix. */
  url: string;
  method?: "get" | "post" | "put" | "patch" | "delete";
  data?: unknown;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
  timeout?: number;
};
export type ApiRequest = <T>(config: RequestConfig) => Promise<T>;

/** Pure transport factory. The caller owns the request-scoped fetch instance. */
export function createRequestClient(fetchJson: RawFetch): ApiRequest {
  return <T>(config: RequestConfig): Promise<T> => {
    if (!config.url.startsWith("/") || config.url.startsWith("//") || /^\/api(?:\/|$)/u.test(config.url) || /[?#\\]/u.test(config.url)) {
      throw new Error("API path must start with / and omit /api, query and fragment.");
    }
    const options: FetchOptions<"json"> = { retry: 0 };
    if (config.method) options.method = config.method.toUpperCase() as FetchOptions<"json">["method"];
    if (config.data !== undefined) options.body = config.data;
    if (config.params) options.query = config.params;
    if (config.signal) options.signal = config.signal;
    if (config.timeout !== undefined) options.timeout = config.timeout;
    return fetchJson<T>(`/api${config.url}`, options);
  };
}
