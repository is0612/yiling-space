const path = require("node:path");

/** Installed launches cannot opt into the source development server. */
function resolveDesktopWebMode({ packaged, production = false, dev = false }) {
  if (production && dev) throw new Error("desktop_web_mode_conflict");
  if (packaged && dev) throw new Error("desktop_installed_dev_refused");
  return packaged || production ? "production" : "development";
}

function desktopWebPlan({ root, port, dataDir, env, mode, identityControl = false }) {
  if (!["development", "production"].includes(mode)) throw new Error("desktop_web_mode_invalid");
  const development = mode === "development";
  if (development && (identityControl || env.YILING_DESKTOP_PACKAGED === "1")) throw new Error("desktop_installed_dev_refused");
  return {
    args: development
      ? [path.join(root, "node_modules", "@nuxt", "cli", "bin", "nuxi.mjs"), "dev", "--host", "127.0.0.1", "--port", String(port), "--no-fork", "--no-open"]
      : [path.join(root, "scripts", "local-production-entry.mjs")],
    env: {
      ...env,
      NODE_ENV: mode,
      NITRO_HOST: "127.0.0.1",
      PORT: String(port),
      YILING_DATA_DIR: dataDir,
      YILING_DESKTOP_IDENTITY_CONTROL: identityControl ? "1" : "0",
      YILING_SESSION_COOKIE: env.YILING_SESSION_COOKIE || "yiling_session_desktop",
      // The desktop supervisor owns the consumers and QQ stack in both modes.
      YILING_ONEBOT_AUTOSTART: "0",
    },
  };
}
module.exports = { resolveDesktopWebMode, desktopWebPlan };
