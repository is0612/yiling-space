import { requireAdminActor } from "../../../../../utils/auth";
import { readSnowlumaStatus, saveSnowlumaHome } from "../../../../../utils/channel-adapter/onebot/runtime";

/**
 * 记住 SnowLuma 装在哪。换盘、换机器时在页面上填一次就够，
 * 不用去改 .env 再重启 nuxt —— 那一步门槛比这个功能本身还高。
 *
 * 存 `.data/snowluma-home.json`（`.data/` 已在 .gitignore 里，跟加密密钥同级）。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const body = await readBody<{ home?: unknown }>(event).catch(() => null);
  const home = typeof body?.home === "string" ? body.home : "";
  const saved = await saveSnowlumaHome(home);
  if (!saved.ok) {
    throw createError({ statusCode: 400, statusMessage: saved.message ?? "目录不可用。" });
  }

  const status = await readSnowlumaStatus();
  return { message: `已记住 ${saved.home}。`, snowluma: status };
});
