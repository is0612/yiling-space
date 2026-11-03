import { inject, provide, ref, type InjectionKey } from "vue";
import { ElMessage } from "element-plus";
import type { BiliAdapterStatus } from "./types";

/**
 * 值班适配器在不在跑 —— B站 值班的第三层开关。
 *
 * 这一层以前完全不可见，于是出现最容易被误判成「功能坏了」的一种局面：
 * 配额开着（perDay=5）、谷时窗口也开着（peakValley=true），但终端里 `yarn bili:run`
 * 根本没起 —— 没有任何东西会到点判断「现在是不是窗口」，一轮都不会发生，
 * 而页面只会说「当前不在谷时窗口内」（它算的是「此刻是不是窗口」，不是「有没有人在等窗口」）。
 *
 * 和 useBiliEnv 的分工：那个问「这台机器能不能跑 bili」，这个问「有没有人在替它盯着窗口」。
 * 两者都不成立时，先说环境 —— 没装 CLI，起了适配器也只会每分钟报错一次。
 */
export type BiliAdapterStore = ReturnType<typeof createAdapter>;

const ADAPTER_KEY: InjectionKey<BiliAdapterStore> = Symbol("bili-adapter");

/** 点「启动适配器」后等它写状态文件的轮询：终端要到下个 tick 才真正跑起来。 */
const LAUNCH_POLL_MS = 800;
const LAUNCH_POLL_TIMES = 6;

function createAdapter() {
  const adapter = ref<BiliAdapterStatus | null>(null);
  const loading = ref(false);
  const launching = ref(false);

  /** 探测失败（网络/权限）当成「不知道」，不冒充「没在跑」—— 否则会误导人再起一个实例。 */
  async function loadAdapter() {
    loading.value = true;
    try {
      adapter.value = await $fetch<BiliAdapterStatus>("/api/admin/bili/adapter");
    } catch {
      adapter.value = null;
    } finally {
      loading.value = false;
    }
  }

  function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function launch() {
    if (launching.value) return;
    launching.value = true;
    try {
      const result = await $fetch<{ ok: boolean; pid?: number; message?: string }>(
        "/api/admin/bili/adapter/launch",
        { method: "POST" },
      );
      if (!result.ok) {
        ElMessage.error(result.message || "启动失败，请在项目根目录手动运行 yarn bili:run。");
        return;
      }
      ElMessage.success(result.message || "已开一个终端跑 yarn bili:run，窗口别关。");
      // 终端起来到写状态文件有几百毫秒延迟：只探一次会读到「没在跑」，反而让人再点一遍
      for (let attempt = 0; attempt < LAUNCH_POLL_TIMES; attempt += 1) {
        await sleep(LAUNCH_POLL_MS);
        await loadAdapter();
        if (adapter.value?.running) return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "启动失败。";
      ElMessage.error(message);
    } finally {
      launching.value = false;
    }
  }

  return { adapter, loading, launching, loadAdapter, launch };
}

export function provideBiliAdapter(): BiliAdapterStore {
  const store = createAdapter();
  provide(ADAPTER_KEY, store);
  return store;
}

export function useBiliAdapter(): BiliAdapterStore {
  const store = inject(ADAPTER_KEY, null);
  if (!store) throw new Error("useBiliAdapter() 必须在值班台页面子树里调用。");
  return store;
}
