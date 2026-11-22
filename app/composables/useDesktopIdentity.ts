import type { DesktopBindResult, DesktopIdentityStatus, DesktopReconnectResult } from "~/types/desktop";

/**
 * 桌面身份状态：仅安装版通过 preload 私有桥提供。
 * 状态是展示与入口开关，不是授权依据；服务端仍按 Cookie 会话鉴权。
 * 所有状态放在 useState，避免 SSR 下模块级单例串号。
 */
export function useDesktopIdentity() {
  const status = useState<DesktopIdentityStatus | null>("desktop-identity-status", () => null);
  const hasBridge = useState<boolean>("desktop-identity-bridge", () => false);
  const busy = useState<boolean>("desktop-identity-busy", () => false);
  const { refresh: refreshAuthSession } = useAuthSession();

  const enabled = computed(() => hasBridge.value && status.value?.enabled === true);
  const state = computed(() => status.value?.state ?? null);
  const bound = computed(() => enabled.value && status.value?.state === "bound");
  const canBind = computed(() => enabled.value && (status.value?.state === "unbound" || status.value?.state === "revoked"));

  function bridge() {
    return import.meta.client ? window.yilingDesktop : undefined;
  }

  async function refreshStatus() {
    const api = bridge();
    hasBridge.value = Boolean(api?.identityStatus);
    if (!api?.identityStatus) {
      status.value = null;
      return null;
    }
    try {
      status.value = await api.identityStatus();
    } catch {
      // 桥存在但状态读取失败：不把失败当成"可用"，保持关闭。
      status.value = null;
    }
    return status.value;
  }

  async function bindCurrentAccount(): Promise<DesktopBindResult> {
    const api = bridge();
    if (!api?.bindCurrentAccount) return { ok: false };
    busy.value = true;
    try {
      const result = await api.bindCurrentAccount();
      await refreshStatus();
      return result ?? { ok: false };
    } finally {
      busy.value = false;
    }
  }

  async function reconnectIdentity(): Promise<DesktopReconnectResult> {
    const api = bridge();
    if (!api?.reconnectIdentity) return { ok: false };
    busy.value = true;
    try {
      const result = await api.reconnectIdentity();
      if (result?.ok) await refreshAuthSession();
      await refreshStatus();
      return result ?? { ok: false };
    } finally {
      busy.value = false;
    }
  }

  async function quit() {
    await bridge()?.quit?.();
  }

  if (import.meta.client) {
    // 只在客户端挂载后读桥；服务端渲染期间不访问 window。
    onMounted(() => {
      void refreshStatus();
    });
  }

  return {
    status,
    enabled,
    state,
    bound,
    canBind,
    busy,
    refreshStatus,
    bindCurrentAccount,
    reconnectIdentity,
    quit,
  };
}
