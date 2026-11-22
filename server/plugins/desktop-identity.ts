import path from "node:path";
import privateAuth from "../../scripts/desktop-auth-ipc.cjs";
import { createDesktopIdentityService, type DesktopIdentityContext } from "../utils/desktop-identity";
import { SESSION_COOKIE_NAME } from "../utils/auth";

function refused(code: string): never { throw Object.assign(new Error(code), { code }); }

/** No routes are registered. Only the inherited, authenticated Node parent channel can call this. */
export default defineNitroPlugin((nitro) => {
  if (process.env.YILING_DESKTOP_PACKAGED !== "1" || process.env.YILING_DESKTOP_IDENTITY_CONTROL !== "1" || process.env.YILING_DB_RUNTIME !== "embedded" || typeof process.send !== "function") return;
  const dataDir = process.env.YILING_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) refused("desktop_identity_data_dir_invalid");
  let service: ReturnType<typeof createDesktopIdentityService> | null = null;
  const peer = privateAuth.createDesktopAuthPeer(process, {
    role: "child",
    handle: async (method: string, value: unknown) => {
      if (method === "initialize") {
        if (service) refused("desktop_identity_already_initialized");
        if (!value || typeof value !== "object" || Array.isArray(value)) refused("desktop_identity_context_invalid");
        const input = value as { identity?: DesktopIdentityContext; freshUserId?: string };
        if (!input.identity || (input.freshUserId !== undefined && typeof input.freshUserId !== "string")) refused("desktop_identity_context_invalid");
        service = createDesktopIdentityService({ dataDir, identity: input.identity, freshUserId: input.freshUserId });
        return service.initialize();
      }
      if (!service) refused("desktop_identity_not_initialized");
      if (method === "status") return { ...await service.getStatus(), cookieName: SESSION_COOKIE_NAME };
      if (method === "issue") return service.issueSession();
      if (method === "unbind") return service.unbind();
      if (method === "revoke") return service.revokeCurrentSession();
      if (method === "bind") {
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { token?: unknown }).token !== "string") refused("desktop_identity_session_invalid");
        const bound = await service.bindFromSession((value as { token: string }).token);
        if (bound.state !== "bound") refused("desktop_identity_bind_refused");
        return { ok: true };
      }
      refused("desktop_identity_method_refused");
    },
  });
  nitro.hooks.hook("close", async () => {
    try { await service?.revokeCurrentSession(); } catch { /* fail closed on next binding validation; never revoke another session */ }
    peer.dispose();
  });
});
