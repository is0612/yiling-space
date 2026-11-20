import { createError, readBody, setHeader } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { observePublicBrowser } from "../../../utils/browser-observe";
import { auditLocalObserve } from "../../../utils/local-observe";

export default defineEventHandler(async event => {
  const actor = await requireAdminActor(event);
  const body = await readBody<{ url?: unknown }>(event);
  if (typeof body?.url !== "string" || !body.url.trim() || body.url.length > 2048) throw createError({ statusCode: 400, message: "请填写有效网页地址。" });
  setHeader(event, "Cache-Control", "no-store");
  try {
    const result = await observePublicBrowser(body.url);
    auditLocalObserve(actor.user.id, "browser.observe", { origin: new URL(result.url).origin, status: "success", blocked: result.blockedRequests });
    return result;
  } catch (error) {
    const code = error instanceof Error ? error.message : "BROWSER_OBSERVE_FAILED";
    auditLocalObserve(actor.user.id, "browser.observe", { status: "failed", code });
    const messages: Record<string, string> = {
      BROWSER_NOT_INSTALLED: "未找到 Chrome 或 Edge，请先在本机安装浏览器。",
      BROWSER_BUSY: "另一项网页观察正在进行，请稍后重试。",
      WEB_INVALID_URL: "只支持公开网站地址，不允许本机、私网、凭据或自定义端口。",
      WEB_BLOCKED_HOST: "该网址解析到非公开网络，已阻止。",
      BROWSER_ORIGIN_NOT_AUTHORIZED: "页面跳转到了另一个网站，请明确指定目标网址后再观察。",
      BROWSER_TIMEOUT: "网页观察超时，浏览器会话已关闭。",
    };
    throw createError({ statusCode: code === "BROWSER_BUSY" ? 409 : 400, message: messages[code] ?? "网页无法完成观察，独立浏览器会话已关闭。" });
  }
});
