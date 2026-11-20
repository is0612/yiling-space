import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";
import { downloadSafeMedia } from "./safe-media-download";
import { validatePublicWebpageUrl } from "./read-public-webpage";

export type BrowserObservation = { url: string; title: string; text: string; truncated: boolean; links: string[];
  screenshot: string; blockedRequests: number; limitation: string };
const LIMITATION = "独立无登录只读会话；仅指定来源的 GET，跨站资源、提交、弹窗、下载和 WebSocket 已阻止，部分页面可能显示不完整。";
const rootMime = ["text/html", "application/xhtml+xml", "text/plain"];
const resourceMime = [...rootMime, "text/css", "text/javascript", "application/javascript", "application/json", "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml", "image/x-icon", "font/woff", "font/woff2", "application/font-woff"];
let observing = false;

export function authorizeBrowserUrl(raw: string, origin: string) {
  const url = validatePublicWebpageUrl(raw);
  if (url.origin !== origin) throw new Error("BROWSER_ORIGIN_NOT_AUTHORIZED");
  return url;
}

function browserExecutable() {
  const candidates = process.platform === "win32" ? [
    path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  ] : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
  const found = candidates.find(file => path.isAbsolute(file) && fs.existsSync(file));
  if (!found) throw new Error("BROWSER_NOT_INSTALLED");
  return found;
}

export async function observePublicBrowser(raw: string): Promise<BrowserObservation> {
  const requested = validatePublicWebpageUrl(raw);
  if (observing) throw new Error("BROWSER_BUSY");
  observing = true;
  let browser: Browser | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const authorizeTarget = (url: URL) => {
      try { authorizeBrowserUrl(url.toString(), requested.origin); }
      catch { throw new Error("WEB_ORIGIN_NOT_AUTHORIZED"); }
    };
    const operation = async () => {
      const first = await downloadSafeMedia(requested.toString(), { prefix: "WEB", timeoutMs: 8000, maxBytes: 512 * 1024,
        allowedMimeTypes: rootMime, authorizeUrl: authorizeTarget });
      const initial = validatePublicWebpageUrl(first.finalUrl);
      browser = await chromium.launch({ executablePath: browserExecutable(), headless: true, chromiumSandbox: true, timeout: 8000,
        env: Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
        args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-breakpad", "--no-first-run"] });
      if (expired) { await browser.close(); throw new Error("BROWSER_TIMEOUT"); }
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", permissions: [],
        viewport: { width: 1280, height: 800 }, storageState: { cookies: [], origins: [] } });
      await context.routeWebSocket("**/*", socket => socket.close());
      let bytes = first.buffer.length, count = 0, active = 0, blocked = 0;
      await context.route("**/*", async route => {
        const request = route.request();
        let reserved = false;
        try {
          const url = authorizeBrowserUrl(request.url(), requested.origin);
          if (expired || request.method() !== "GET" || ++count > 40 || active >= 4 || bytes > 4 * 1024 * 1024
            || request.isNavigationRequest() && (request.frame() !== context.pages()[0]?.mainFrame() || url.toString() !== initial.toString())) throw Error();
          active++; reserved = true;
          const response = request.isNavigationRequest() ? first : await downloadSafeMedia(url.toString(), {
            prefix: "WEB", timeoutMs: 5000, maxBytes: 256 * 1024, allowedMimeTypes: resourceMime,
            authorizeUrl: authorizeTarget,
          });
          if (!request.isNavigationRequest()) bytes += response.buffer.length;
          if (bytes > 4 * 1024 * 1024) throw Error();
          // Do not forward cookies, authorization, Set-Cookie, downloads, or page-supplied headers.
          await route.fulfill({ status: response.status, body: response.buffer, headers: { "content-type": response.mime,
            "content-security-policy": "form-action 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'self'", "cache-control": "no-store" } });
        } catch { blocked++; await route.abort().catch(() => {}); }
        finally { if (reserved) active--; }
      });
      const page = await context.newPage();
      context.on("page", extra => { if (extra !== page) void extra.close(); });
      page.on("dialog", dialog => { void dialog.dismiss(); });
      page.on("download", download => { void download.cancel(); });
      await page.goto(initial.toString(), { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(600);
      const snapshot = await page.evaluate(() => ({ title: document.title.slice(0, 300),
        text: (document.body?.innerText || "").slice(0, 6001),
        hrefs: Array.from(document.querySelectorAll("a[href]")).slice(0, 100).map(anchor => (anchor as HTMLAnchorElement).href) }));
      const links: string[] = [];
      for (const href of snapshot.hrefs) {
        try { const link = authorizeBrowserUrl(href, requested.origin).toString(); if (!links.includes(link)) links.push(link); } catch { /* not authorized */ }
        if (links.length === 8) break;
      }
      const screenshot = await page.screenshot({ type: "png", animations: "disabled", timeout: 5000 });
      return { url: initial.toString(), title: snapshot.title, text: snapshot.text.slice(0, 6000), truncated: snapshot.text.length > 6000,
        links, screenshot: `data:image/png;base64,${screenshot.toString("base64")}`, blockedRequests: blocked, limitation: LIMITATION };
    };
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { expired = true; void browser?.close(); reject(new Error("BROWSER_TIMEOUT")); }, 25000);
    })]);
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "";
    const message = rawMessage === "WEB_ORIGIN_NOT_AUTHORIZED" ? "BROWSER_ORIGIN_NOT_AUTHORIZED" : rawMessage;
    throw new Error(["BROWSER_NOT_INSTALLED", "BROWSER_TIMEOUT", "BROWSER_ORIGIN_NOT_AUTHORIZED", "WEB_INVALID_URL", "WEB_BLOCKED_HOST"].includes(message) ? message : "BROWSER_OBSERVE_FAILED");
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => {});
    observing = false;
  }
}
