import type { Page } from "playwright-core";
import { openIsolatedPage } from "./browser-observe";
import { validatePublicWebpageUrl } from "./read-public-webpage";

export type BrowserAction =
  | { kind: "click"; selector: string }
  | { kind: "click_text"; text: string }
  | { kind: "fill"; selector: string; value: string }
  | { kind: "scroll"; y: number }
  | { kind: "scroll"; direction: "down" | "up" | "top" | "bottom" };

export type BrowserActionResult = { steps: Array<{ action: string; ok: boolean; detail?: string }>; url: string;
  title: string; text: string; screenshot: string; blockedRequests: number; limitation: string; submitted: boolean };
export type BrowserProposal = { actions: BrowserAction[]; submitSelector: string | null };

const MAX_ACTIONS = 10;
const LIMITATION = "独立无登录会话：只允许本页点击、填写与滚动；任何发送、提交、跳转、上传、下载和跨站资源都被阻止。";

/** A rejection that names the offending step, so the model can correct it instead of guessing. */
export class BrowserActionError extends Error {
  constructor(message: string) { super(message); this.name = "BrowserActionError"; }
}

const SHAPES = '{"kind":"click","selector":"#id"}、{"kind":"click_text","text":"按钮文字"}、{"kind":"fill","selector":"#id","value":"内容"}、{"kind":"scroll","y":600}';

/**
 * Parses the requested steps. A final `{"kind":"submit","selector":"#id"}` is not an ordinary step: it is split out
 * so the first approval can fill and screenshot the form without ever sending it.
 */
export function parseBrowserProposal(value: unknown): BrowserProposal {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACTIONS) {
    throw new BrowserActionError(`actions 必须是 1–${MAX_ACTIONS} 步的数组。`);
  }
  const submitIndex = value.findIndex(item => (item as Record<string, unknown> | null)?.kind === "submit");
  if (submitIndex !== -1 && submitIndex !== value.length - 1) {
    throw new BrowserActionError("submit 只能是最后一步，前面用来填写和点击。");
  }
  const steps = submitIndex === -1 ? value : value.slice(0, -1);
  let submitSelector: string | null = null;
  if (submitIndex !== -1) {
    const row = value[submitIndex] as Record<string, unknown>;
    const selector = typeof row.selector === "string" ? row.selector.trim() : "";
    if (!selector) throw new BrowserActionError("submit 需要 selector（提交按钮的选择器）。");
    if (selector.length > 200 || /[{}]/.test(selector)) throw new BrowserActionError("submit 的 selector 最多 200 字符，且不能含花括号。");
    submitSelector = selector;
  }
  if (!steps.length && !submitSelector) throw new BrowserActionError("至少需要一步操作。");
  return { actions: steps.map((item, index) => parseOne(item, index)), submitSelector };
}

/** Steps only; kept for callers that cannot submit (observation and read-only previews). */
export function parseBrowserActions(value: unknown): BrowserAction[] {
  return parseBrowserProposal(value).actions;
}

function parseOne(item: unknown, index: number): BrowserAction {
    const where = `第 ${index + 1} 步`;
    const row = item as Record<string, unknown> | null;
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new BrowserActionError(`${where}不是对象；每步形如 ${SHAPES}。`);
    const kind = row.kind;
    if (kind === "click" || kind === "fill") {
      const selector = typeof row.selector === "string" ? row.selector.trim() : "";
      if (!selector) throw new BrowserActionError(`${where}缺少 selector（CSS 选择器）。`);
      if (selector.length > 200 || /[{}]/.test(selector)) throw new BrowserActionError(`${where}的 selector 最多 200 字符，且不能含花括号；用 #id 或 .class 这类简单选择器。`);
      if (kind === "click") return { kind, selector } as BrowserAction;
      const text = typeof row.value === "string" ? row.value : typeof row.value === "number" ? String(row.value) : "";
      if (text.length > 2000) throw new BrowserActionError(`${where}的 value 最多 2000 字符。`);
      return { kind, selector, value: text } as BrowserAction;
    }
    if (kind === "click_text") {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (!text) throw new BrowserActionError(`${where}缺少 text（要点击的可见文字）。`);
      if (text.length > 120) throw new BrowserActionError(`${where}的 text 最多 120 字符。`);
      return { kind, text } as BrowserAction;
    }
    if (kind === "scroll") {
      // Accept "600" as well as 600: the tool layer hands arguments over as JSON text and models often quote numbers.
      // A direction without coordinates is fine — scroll position carries no data, so a viewport-sized step is safe.
      const raw = typeof row.y === "string" ? Number(row.y.trim()) : row.y;
      if (raw === undefined || raw === null || raw === "") {
        const direction = typeof row.direction === "string" ? row.direction.trim().toLowerCase() : "down";
        if (!["down", "up", "top", "bottom"].includes(direction)) {
          throw new BrowserActionError(`${where}的 direction 只能是 down / up / top / bottom，或者直接给 y（0–20000）。`);
        }
        return { kind, direction } as unknown as BrowserAction;
      }
      const y = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : NaN;
      if (!Number.isFinite(y) || y < 0 || y > 20000) throw new BrowserActionError(`${where}的 y 必须是 0–20000 的数字，收到 ${JSON.stringify(row.y)}。`);
      return { kind, y } as BrowserAction;
    }
    throw new BrowserActionError(`${where}的 kind 只能是 click / click_text / fill / scroll / submit，收到 ${JSON.stringify(kind)}；每步形如 ${SHAPES}。`);
}

export function describeBrowserAction(action: BrowserAction) {
  if (action.kind === "click") return `点击 ${action.selector}`;
  if (action.kind === "click_text") return `点击文字「${action.text}」`;
  if (action.kind === "fill") return `填写 ${action.selector}（${action.value.length} 字）`;
  if ("direction" in action) return `向${action.direction === "up" ? "上" : action.direction === "top" ? "顶部" : action.direction === "bottom" ? "底部" : "下"}滚动`;
  return `滚动到 ${action.y}px`;
}

/**
 * Runs one approved list of actions. Refusals are per-step: a selector that matches nothing stops the run
 * instead of silently continuing, because later steps would then act on an unexpected page.
 */
async function runActions(page: Page, actions: BrowserAction[]) {
  const steps: BrowserActionResult["steps"] = [];
  for (const action of actions) {
    const label = describeBrowserAction(action);
    try {
      if (action.kind === "click" || action.kind === "fill") {
        const target = page.locator(action.selector);
        if (await target.count() !== 1) throw new Error("选择器没有唯一匹配到元素");
        const handle = target.first();
        if (!await handle.isVisible()) throw new Error("元素不可见");
        if (action.kind === "click") {
          const blockedType = await handle.evaluate(element => {
            const input = element as HTMLInputElement;
            const tag = element.tagName.toLowerCase();
            if (tag === "input" && (input.type === "file" || input.type === "password")) return input.type;
            if (tag === "button" && (input.type === "submit" || !input.type)) return "submit";
            if (tag === "input" && input.type === "submit") return "submit";
            return "";
          });
          if (blockedType) throw new Error(`已阻止${blockedType === "file" ? "文件上传" : blockedType === "password" ? "密码输入框" : "提交按钮"}`);
          await handle.click({ timeout: 5000 });
        } else {
          const blocked = await handle.evaluate(element => {
            const input = element as HTMLInputElement;
            if (input.disabled || input.readOnly) return "只读或禁用";
            if (input.type === "password") return "密码输入框";
            if (input.type === "file") return "文件上传";
            if (!["input", "textarea"].includes(element.tagName.toLowerCase()) && !(element as HTMLElement).isContentEditable) return "不是可填写元素";
            return "";
          });
          if (blocked) throw new Error(`已阻止：${blocked}`);
          await handle.fill(action.value, { timeout: 5000 });
        }
      } else if (action.kind === "click_text") {
        const candidate = page.getByText(action.text, { exact: true });
        if (await candidate.count() !== 1) throw new Error("没有唯一匹配这段文字的元素");
        const handle = candidate.first();
        if (!await handle.isVisible()) throw new Error("元素不可见");
        await handle.click({ timeout: 5000 });
      } else {
        const target = "direction" in action
          ? await page.evaluate(direction => {
            if (direction === "top") return 0;
            if (direction === "bottom") return document.body.scrollHeight;
            const step = window.innerHeight;
            return Math.max(0, window.scrollY + (direction === "up" ? -step : step));
          }, action.direction)
          : action.y;
        await page.evaluate(y => window.scrollTo({ top: y, behavior: "instant" }), target);
      }
      await page.waitForTimeout(300);
      // Filled values are the thing being confirmed later, so keep them (bounded) in the stored result.
      steps.push({ action: label, ok: true, ...(action.kind === "fill" ? { detail: `= ${action.value.slice(0, 160)}` } : {}) });
    } catch (error) {
      steps.push({ action: label, ok: false, detail: error instanceof Error ? error.message.slice(0, 160) : "执行失败" });
      break;
    }
  }
  return steps;
}

/**
 * Fills the page. With `submitSelector` the run also clicks the submit button — only the second approval passes it,
 * and only same-origin submissions are let through by the session.
 */
export async function executeBrowserActions(rawUrl: string, actions: BrowserAction[], submitSelector?: string | null): Promise<BrowserActionResult> {
  validatePublicWebpageUrl(rawUrl);
  const session = await openIsolatedPage(rawUrl, { timeoutMs: submitSelector ? 40000 : 30000, allowSubmit: Boolean(submitSelector) });
  try {
    const steps = await runActions(session.page, actions);
    const before = await session.snapshot();
    if (!submitSelector) return { steps, ...before, blockedRequests: session.stats.blocked, limitation: LIMITATION, submitted: false };
    if (steps.some(step => !step.ok)) {
      steps.push({ action: `提交 ${submitSelector}`, ok: false, detail: "前面的步骤未完成，已取消提交" });
      return { steps, ...before, blockedRequests: session.stats.blocked, limitation: LIMITATION, submitted: false };
    }
    const label = `提交 ${submitSelector}`;
    try {
      const target = session.page.locator(submitSelector);
      if (await target.count() !== 1) throw new Error("提交按钮没有唯一匹配");
      const element = target.first();
      if (!await element.isVisible()) throw new Error("提交按钮不可见");
      const formAction = await element.evaluate(node => {
        const form = (node as HTMLElement).closest("form");
        return form ? (form as HTMLFormElement).action : location.href;
      });
      // A form that posts elsewhere is exactly the case the two-phase approval exists for; refuse it instead.
      const resolved = new URL(formAction, before.url);
      if (resolved.origin !== new URL(before.url).origin) throw new Error("表单会提交到其他网站，已阻止");
      session.armSubmit();
      await element.click({ timeout: 8000 });
      await session.page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      await session.page.waitForTimeout(500);
      steps.push({ action: label, ok: true });
      const after = await session.snapshot();
      return { steps, ...after, blockedRequests: session.stats.blocked, limitation: LIMITATION, submitted: true };
    } catch (error) {
      steps.push({ action: label, ok: false, detail: error instanceof Error ? error.message.slice(0, 160) : "提交失败" });
      return { steps, ...before, blockedRequests: session.stats.blocked, limitation: LIMITATION, submitted: false };
    }
  } finally {
    await session.close();
  }
}
