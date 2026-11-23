import type { ImageReplyDecision } from "./image-generation";
import { IMAGE_OFFER_TTL_MS } from "./image-offer";

export type ImageAttemptRecord = {
  status: "generated" | "generation_failed" | "missing_prompt" | "blocked";
  reason?: string;
  trigger?: string;
  sourceMessageId?: string;
  authorOpenId?: string;
  promptSource?: "model" | "request_subject" | "confirmed_offer";
  todayCount?: number | null;
  limit?: number;
};
export type ImageGenerationRecord = {
  prompt: string; model: string; provider: string; generatedAt: string; mode: "text_to_image" | "image_to_image";
};
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** A synchronous generation adapter has no unseen queue to tell a user to wait for. */
export function imageStatusReply(history: readonly { role: string; metadata: unknown; occurredAt?: Date | string }[]): string {
  const latest = history.find(row => row.role === "ASSISTANT" && (() => {
    const m = record(row.metadata); return m.imageAttempt || m.imageOffer || m.image || record(m.replyDelivery).image;
  })());
  const metadata = record(latest?.metadata);
  const delivery = record(record(metadata.replyDelivery).image);
  const attempt = record(metadata.imageAttempt);
  if (delivery.status === "sent") return "最近一张图片已经确认发出，目前没有新的出图任务在后台运行。";
  if (delivery.status === "unknown") return "最近一次图片的发送结果还未确认，我不能说它已经送达，目前没有后台重发任务。";
  if (delivery.status === "failed") return "最近一次图片没有成功发送，目前没有后台重发任务在运行。";
  if (attempt.status === "blocked") return blockedImageReply(String(attempt.reason ?? "confirmation_required"), attempt.todayCount as number | null, attempt.limit as number | undefined);
  if (attempt.status === "generation_failed") return "上一次图片生成失败了，目前没有新的出图任务在运行。";
  if (metadata.image) return "最近一次图片已经生成，但没有确认送达的记录，目前没有后台重发任务。";
  if (metadata.imageOffer) {
    const at = latest?.occurredAt instanceof Date ? latest.occurredAt.getTime() : latest?.occurredAt ? Date.parse(latest.occurredAt) : NaN;
    if (Number.isFinite(at) && Date.now() - at > IMAGE_OFFER_TTL_MS) return "之前的画图提议已经过期，目前没有生成任务在运行。";
    return "还没有开始生成，目前只是待确认的画图提议。";
  }
  return "这边还没有启动新的画图任务，也没有图片正在后台排队。";
}

export function blockedImageReply(reason: string, count?: number | null, limit?: number): string {
  switch (reason) {
    case "daily_limit": return `这次没有开始画图：今天的出图额度已用完${typeof count === "number" && typeof limit === "number" ? `（已生成 ${count} 张，上限 ${limit} 张）` : ""}。`;
    case "declined": return "上一次画图提议已取消，目前没有生成任务在运行。";
    case "disabled": return "这次没有开始画图：画图开关目前关闭。";
    case "missing_config": return "这次没有开始画图：画图模型尚未配置完整。";
    case "quota_unavailable": return "这次没有开始画图：暂时无法确认剩余出图额度。";
    case "voice_conflict": return "这一轮选择了语音，没有同时启动画图。";
    case "unsafe_prompt": return "这次没有生成图片：当前画图功能不生成聊天记录、聊天界面截图或对话成员占位符。请改成独立的画面描述。";
    case "missing_prompt": return "这次还没有开始生成图片，请明确要画的主体或场景。";
    case "offer_expired": return "之前的画图提议已经过期，这次还没有开始生成。请重新说一下要画什么。";
    case "ambiguous_request": return "这一轮有多个画图要求，我还没有开始。请先确定一个画面。";
    case "generation_failed": return "这次图片生成没有成功，目前没有后台重试任务。";
    default: return "这次还没有开始生成图片。我没找到可确认的画图内容，请直接说要画什么。";
  }
}

/**
 * 给聊天提示词的「每日上限」字段。
 *
 * `limit = 0` 在配置里表示**不限张数**，不是「上限 0 张」。以前把这个 0 原样塞给
 * 模型，它读成「额度用完了」，再顺着自己上几轮的错话编出「今天两张已经出完，还在冷却」。
 * 不限时干脆不给这个字段：没有数字可引用，就不该报数。
 */
export function imageExecutionLimitForPrompt(limit: number): { dailyLimit: number } | Record<string, never> {
  return Number.isFinite(limit) && limit > 0 ? { dailyLimit: limit } : {};
}

/** Only an actual directed request receives a deterministic blocked response; ordinary chat stays ordinary. */
export function imageDecisionReply(decision: ImageReplyDecision): string | null {
  return decision.status === "blocked" && decision.requested
    ? blockedImageReply(decision.blockedReason ?? "confirmation_required", decision.todayCount, decision.limit) : null;
}
