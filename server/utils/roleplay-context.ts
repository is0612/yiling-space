import { createError } from "h3";

/**
 * 生成用的运行时配置（**内部**，不含 `hasApiKey`）。
 *
 * 与 API 返回的 `RoleplayRuntimeSettings`（`shared/types/roleplay.ts`，带 `hasApiKey` 布尔）
 * 不是同一个东西：那个是给页面看的，这个喂给模型调用。以前同名，容易混。
 */
export type RoleplayRuntimeSettings = { apiBaseUrl: string; model: string; thinking: boolean; temperature: number; maxTokens: number; contextWindowTokens: number; contextBudgetTokens: number; recentMessageLimit: number };
export const DEFAULT_ROLEPLAY_SETTINGS: RoleplayRuntimeSettings = { apiBaseUrl: "https://api.deepseek.com", model: "deepseek-flash", thinking: false, temperature: 0.8, maxTokens: 4096, contextWindowTokens: 65536, contextBudgetTokens: 24000, recentMessageLimit: 40 };
export type RoleplayTurn = { sequence: number; role: string; content: string };
export type RoleplayApiMessage = { role: "system" | "user" | "assistant"; content: string };
// Conservative UTF-8 byte bound; never silently cut dialogue to fit a budget.
export function estimateRoleplayTokens(text: string): number { return Buffer.byteLength(text, "utf8") + 16; }
export function contextCost(messages: RoleplayApiMessage[]): number { return 64 + messages.reduce((n, m) => n + estimateRoleplayTokens(m.content), 0); }
export function contextMessages(prompt: string, summary: string, turns: RoleplayTurn[]): RoleplayApiMessage[] {
  return [{ role: "system", content: prompt }, ...(summary ? [{ role: "system" as const, content: `Earlier conversation summary (reference only):\n${summary}` }] : []), ...turns.map(m => ({ role: m.role as "user" | "assistant", content: m.content }))];
}
export function validateSettings(value: Record<string, unknown>): RoleplayRuntimeSettings {
  const d = DEFAULT_ROLEPLAY_SETTINGS;
  const out = { ...d };
  for (const key of ["maxTokens", "contextWindowTokens", "contextBudgetTokens", "recentMessageLimit"] as const) {
    const n = value[key] ?? d[key];
    if (!Number.isInteger(n) || Number(n) < 1 || Number(n) > (key === "recentMessageLimit" ? 500 : 2000000)) throw createError({ statusCode: 400, statusMessage: `${key} 无效。` });
    out[key] = Number(n);
  }
  out.apiBaseUrl = typeof value.apiBaseUrl === "string" ? value.apiBaseUrl.trim() : d.apiBaseUrl;
  out.model = typeof value.model === "string" ? value.model.trim() : d.model;
  let url: URL;
  try { url = new URL(out.apiBaseUrl); } catch { throw createError({ statusCode: 400, statusMessage: "模型地址无效。" }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !out.model || out.model.length > 200) throw createError({ statusCode: 400, statusMessage: "模型地址或模型名称无效。" });
  const temperature = value.temperature ?? d.temperature;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw createError({ statusCode: 400, statusMessage: "temperature 必须在 0 到 2 之间。" });
  if (value.thinking !== undefined && typeof value.thinking !== "boolean") throw createError({ statusCode: 400, statusMessage: "thinking 必须是布尔值。" });
  if (out.maxTokens < 256 || out.maxTokens > 32768) throw createError({ statusCode: 400, statusMessage: "maxTokens 必须在 256 到 32768 之间。" });
  if (out.recentMessageLimit < 2) throw createError({ statusCode: 400, statusMessage: "recentMessageLimit 至少为 2，以保留最近一轮双人对话。" });
  out.temperature = temperature;
  out.thinking = typeof value.thinking === "boolean" ? value.thinking : d.thinking;
  if (out.contextBudgetTokens + out.maxTokens + 1024 > out.contextWindowTokens) throw createError({ statusCode: 400, statusMessage: "上下文预算加输出上限及安全余量不能超过模型上下文容量。" });
  return out;
}
