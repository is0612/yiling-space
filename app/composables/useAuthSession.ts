import { createAuthApi, type AuthSessionState } from "~/api/auth";

const EMPTY_STATE: AuthSessionState = { loaded: false, mode: "anonymous", user: null, reason: null };

export function useAuthSession() {
  const state = useState<AuthSessionState>("auth-session", () => ({ ...EMPTY_STATE }));
  // SSR 阶段由注入的请求实例转发 cookie，不再手动透传请求头。
  const api = createAuthApi(useApiRequest());

  async function refresh() {
    try {
      const response = await api.getSession();
      state.value = { loaded: true, ...response, reason: response.reason ?? null };
    } catch {
      state.value = { loaded: true, mode: "anonymous", user: null, reason: "request_failed" };
    }
    return state.value;
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      state.value = { loaded: true, mode: "anonymous", user: null, reason: null };
      await navigateTo("/login");
    }
  }

  const isAuthenticated = computed(() => Boolean(state.value.user));
  const displayName = computed(() => state.value.user?.displayName || state.value.user?.username || "管理员");
  const isLocalDevIdentity = computed(() => state.value.mode === "local-dev");
  const isAdmin = computed(() => state.value.user?.role === "ADMIN" || state.value.mode === "local-dev");

  return { state, refresh, logout, isAuthenticated, displayName, isLocalDevIdentity, isAdmin };
}
