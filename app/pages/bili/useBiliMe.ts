import { inject, provide, ref, type InjectionKey } from "vue";
import type { BiliMe } from "./types";

/**
 * 当前扫码登录的 B站 账号（`bili me show`）。
 *
 * 和 auth/login、auth/status 一样走 bili CLI 的默认数据目录，
 * 所以这里读到的一定是刚扫的那个号。没登录时接口返回 ok:false，静默当成 null —— 未登录是常态。
 *
 * 二维码生成与轮询在 BiliLoginDialog 里；这里只管「登录之后是谁」。
 */
export type BiliMeStore = ReturnType<typeof createMe>;

/** 登录换了人，外面的今日数据也得重算 —— 由页面在 provide 时挂进来。 */
export type BiliMeHandlers = {
  onLoggedIn: () => void | Promise<void>;
};

const ME_KEY: InjectionKey<BiliMeStore> = Symbol("bili-me");

function createMe(handlers: BiliMeHandlers) {
  const loginVisible = ref(false);
  const meProfile = ref<BiliMe | null>(null);
  const meLoading = ref(true);

  async function loadMe() {
    meLoading.value = true;
    try {
      const result = await $fetch<{ ok: boolean; me: BiliMe | null }>("/api/admin/bili/me");
      meProfile.value = result.ok ? result.me : null;
    } catch {
      meProfile.value = null;
    } finally {
      meLoading.value = false;
    }
  }

  /** 扫码成功：换人了，头像和今日数据都要重算。 */
  async function handleLoggedIn() {
    await loadMe();
    await handlers.onLoggedIn();
  }

  return { loginVisible, meProfile, meLoading, loadMe, handleLoggedIn };
}

export function provideBiliMe(handlers: BiliMeHandlers): BiliMeStore {
  const store = createMe(handlers);
  provide(ME_KEY, store);
  return store;
}

export function useBiliMe(): BiliMeStore {
  const store = inject(ME_KEY, null);
  if (!store) throw new Error("useBiliMe() 必须在值班台页面子树里调用。");
  return store;
}
