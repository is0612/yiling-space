/**
 * Session guard for the whole app. /login and /register are the only public pages; everything else
 * requires an authenticated (or explicitly enabled local-development) identity. Administrator-only
 * pages are additionally gated on the session role.
 */
const ADMIN_ONLY_PATHS = [/^\/users/, /^\/settings/, /^\/tasks/, /^\/bili/, /^\/qq/];
const PUBLIC_PATHS = new Set(["/login", "/register"]);

export default defineNuxtRouteMiddleware(async (to) => {
  const { state, refresh, isAdmin } = useAuthSession();
  if (!state.value.loaded) {
    const headers = import.meta.server ? useRequestHeaders(["cookie"]) : undefined;
    await refresh(headers);
  }

  const isPublic = PUBLIC_PATHS.has(to.path);
  if (!state.value.user && !isPublic) {
    return navigateTo("/login");
  }
  if (state.value.user && isPublic) {
    return navigateTo("/");
  }
  if (ADMIN_ONLY_PATHS.some((pattern) => pattern.test(to.path)) && !isAdmin.value) {
    return navigateTo("/");
  }
});
