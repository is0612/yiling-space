import type { ApiRequest } from "../utils/request";
import type { OverviewPayload } from "../utils/overview";

/**
 * 工作台总览接口：角色卡片、归档倒计时与停滞检测。
 *
 * 只读一次全量快照；倒计时与排序都在页面里按本地时间算。
 */
export function createOverviewApi(request: ApiRequest) {
  function getOverview(): Promise<OverviewPayload> {
    return request<OverviewPayload>({ url: "/overview", method: "get" });
  }

  return { getOverview };
}

export type OverviewApi = ReturnType<typeof createOverviewApi>;
