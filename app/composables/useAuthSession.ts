export type AuthUser = {
  id: string;
  username: string;
  displayName: string | null;
  role?: "ADMIN" | "USER";
};

export type AuthSessionState = {
  loaded: boolean;
  mode: "session" | "local-dev" | "anonymous";
  user: AuthUser | null;
  reason?: string | null;
};

const EMPTY_STATE: AuthSessionState = { loaded: false, mode: "anonymous", user: null, reason: null };

export function useAuthSession() {
  const state = useState<AuthSessionState>("auth-session", () => ({ ...EMPTY_STATE }));

  async function refresh(headers?: Record<string, string>) {
    try {
      const response = await $fetch<Omit<AuthSessionState, "loaded">>("/api/auth/session", headers ? { headers } : undefined);
      state.value = { loaded: true, ...response, reason: response.reason ?? null };
    } catch {
      state.value = { loaded: true, mode: "anonymous", user: null, reason: "request_failed" };
    }
    return state.value;
  }

  async function logout() {
    try {
      await $fetch("/api/auth/logout", { method: "POST" });
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
