import type { BiliAccount } from "./types";

/**
 * B站值班台的纯函数工具 —— 时间格式化、报告解析、封面占位色。
 * 都是纯函数，放在这里而不是 composable 里：谁要用谁 import，不需要响应式。
 */

/** 把 $fetch 抛出来的错误翻成人话：优先用服务端的 statusMessage。 */
export function readErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

export function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 秒数拆成「数值 + 单位」两段：26px 数字后面跟 12px 单位。 */
export function dur(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return { v: "—", u: "" };
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return { v: String(s), u: "秒" };
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return { v: String(m), u: rest ? `分 ${rest} 秒` : "分钟" };
}

export function windowLabel(window: "noon" | "night" | null) {
  if (window === "noon") return "中午 12–14 点";
  if (window === "night") return "夜间 18–次日 9 点";
  return "—";
}

export function windowActiveLabel(account: BiliAccount) {
  return account.nextWindow ? `下次窗口 ${windowLabel(account.nextWindow)}` : "当前不在谷时窗口内";
}

/** 报告正文里「过程记录」的分隔标记，和服务端 duty-pipeline 落库时写的保持一致。 */
export const REPORT_NOTES_MARK = "--- 过程记录 ---";

export function parsePickedVideos(content: string): Array<{ bvid: string; text: string }> {
  // 先切掉过程记录，否则它会粘在最后一条视频的正文后面
  const body = content.split(REPORT_NOTES_MARK)[0] ?? content;
  const blocks = body.split(/\n(?=###\s)/).filter((block) => block.trim());
  const result: Array<{ bvid: string; text: string }> = [];
  for (const block of blocks) {
    const match = block.match(/^###\s*(\S+)\s*([\s\S]*)$/);
    if (!match) continue;
    result.push({ bvid: match[1]!, text: match[2]!.trim() });
  }
  return result;
}

/** 这一轮为什么一条都没挑中 —— 报告里附的过程记录（风控、限流、模型报错等）。 */
export function parseReportNotes(content: string): string[] {
  const index = content.indexOf(REPORT_NOTES_MARK);
  if (index < 0) return [];
  return content
    .slice(index + REPORT_NOTES_MARK.length)
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

export function isPicked(result: string) {
  return result === "picked";
}

/** 封面还没加载出来时的占位渐变（按序号轮换，同一行每次刷新颜色不变）。 */
const COVER_GRADIENTS = [
  ["#3f6091", "#21324d"],
  ["#5d3f86", "#382253"],
  ["#2f6b5e", "#1a3b34"],
  ["#8a5a2b", "#4a2e16"],
];

export function coverStyle(cached: boolean, index: number) {
  if (cached) return {};
  const [c1, c2] = COVER_GRADIENTS[index % COVER_GRADIENTS.length]!;
  return { "--c1": c1, "--c2": c2 };
}
