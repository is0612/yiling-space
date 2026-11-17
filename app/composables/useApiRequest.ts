import { createRequestClient, type RawFetch } from "~/utils/request";

/** Call synchronously in setup; keep this instance across nested awaits. Never cache globally. */
export function useApiRequest() {
  const fetchJson = (import.meta.server ? useRequestFetch() : $fetch) as unknown as RawFetch;
  return createRequestClient(fetchJson);
}
