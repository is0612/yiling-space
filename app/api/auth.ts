import type { ApiRequest } from "../utils/request";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string | null;
  role?: "ADMIN" | "USER";
};

export type AuthMode = "session" | "local-dev" | "anonymous";

export type AuthSessionState = {
  loaded: boolean;
  mode: AuthMode;
  user: AuthUser | null;
  reason?: string | null;
};

export type AuthSessionPayload = Omit<AuthSessionState, "loaded">;

/**
 * 认证接口：会话读取、登录、注册与退出。
 *
 * SSR 阶段的 cookie 由注入的请求实例自动转发，这里不单独处理请求头。
 */
export function createAuthApi(request: ApiRequest) {
  function getSession(): Promise<AuthSessionPayload> {
    return request<AuthSessionPayload>({ url: "/auth/session", method: "get" });
  }

  function login(payload: { username: string; password: string }): Promise<unknown> {
    return request<unknown>({ url: "/auth/login", method: "post", data: payload });
  }

  function register(payload: { email: string; password: string; displayName?: string }): Promise<unknown> {
    return request<unknown>({ url: "/auth/register", method: "post", data: payload });
  }

  function logout(): Promise<unknown> {
    return request<unknown>({ url: "/auth/logout", method: "post" });
  }

  return { getSession, login, register, logout };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
