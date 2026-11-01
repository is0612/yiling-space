/**
 * 主动找话的提示词，分两步。
 *
 * 「想」（生成目的）与「说」（写正文）不能合成一步：合成后每次 tick 都要现想现说，
 * 于是必然「刚聊完又凑上来」「同一句话反复说」。有池子才有「攒着想问的事轮到了」。
 */

import type { ProactiveSettings } from "./proactive-settings";

/** 开口的方式。分类不是为了好看：不同 kind 的语气和边界完全不同（索取 ≠ 倾诉）。 */
export const PROACTIVE_KINDS = {
  SHARE: "想分享点东西",
  ASK: "想问清楚一件事",
  INVITE: "想拉他一起做点什么",
  CONFIDE: "想说点心里话",
  CURIOUS: "对某件事好奇，想问",
  FOLLOWUP: "想追问上次没说完的事",
} as const;

export type ProactiveKind = keyof typeof PROACTIVE_KINDS;

export const PROACTIVE_KIND_KEYS = Object.keys(PROACTIVE_KINDS) as ProactiveKind[];

export function isProactiveKind(value: unknown): value is ProactiveKind {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROACTIVE_KINDS, value);
}

export type ProactiveMaterials = {
  /** 长期记忆（按重要度 × 新鲜度挑过的几条）。 */
  memories: string[];
  /** 最近私聊里双方说过的话，只用来判断「刚聊到哪」。 */
  recentChat: string[];
};

/** 目的生成的系统提示词：人设 + 三条硬边界。 */
export function buildIntentSystemPrompt(characterName: string, persona: string): string {
  return [
    `你是「${characterName}」。下面是你的设定：`,
    "",
    persona.slice(0, 12_000),
    "",
    "## 现在要做什么",
    "从你记得的事情里，挑出几件「你真的想跟他说、但还没说」的事。这是你自己的想法，不是给他做任务清单。",
    "",
    "## 三条硬边界",
    "1. 不许编。素材里没有的事，一个字都不许出现。想不出就少给几条，给空数组也没关系。",
    "2. 同一件事不要拆成两条。「想问他在做什么工作」和「想了解他的职业」是一件事。",
    "3. 不要写「我该关心他」这类正确但空的话 —— 那是任务，不是目的。",
  ].join("\n");
}

export function buildIntentUserPrompt(materials: ProactiveMaterials): string {
  const memoryBlock = materials.memories.length
    ? materials.memories.map((line) => `- ${line}`).join("\n")
    : "（暂时没有值得说的记忆）";
  const chatBlock = materials.recentChat.length
    ? materials.recentChat.map((line) => `- ${line}`).join("\n")
    : "（最近没聊过）";

  return [
    "## 我记得的事",
    memoryBlock,
    "",
    "## 最近聊到的",
    chatBlock,
    "",
    "挑 1-3 件我现在真的想开口说的事，按想说的程度排序。每条给四个字段：",
    `- kind：${PROACTIVE_KIND_KEYS.map((key) => `${key}（${PROACTIVE_KINDS[key]}）`).join(" / ")}`,
    "- goal：一句话，用我自己的口吻写，不要写成第三人称描述",
    "- confidence：0 到 1，这事到底是不是我真想说的（凑数的给低分）",
    "- urgency：0 到 1，放久了会不会失效（「他今天说的那个事」该高一点）",
    "",
    "只输出一个 JSON 数组，不要任何别的文字。例如：",
    '{"kind":"ASK","goal":"想问问他昨天说的那个项目到底卡在哪","confidence":0.7,"urgency":0.6}',
    "（上面是一条示例的字段形状，不是内容；照这个形状输出数组。）",
  ].join("\n");
}

export type ParsedIntent = {
  kind: ProactiveKind;
  goal: string;
  confidence: number;
  urgency: number;
};

function readConfidence(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, Math.round(n * 100) / 100));
}

/**
 * 校验模型给的目的列表：只认清单里的 kind、非空且不长的 goal，同 kind 同文本只留第一条。
 * 「像不像人话」不在这里判 —— 那是 confidence 和 minConfidence 门槛的事。
 */
export function parseIntents(payload: unknown, limit = 3): ParsedIntent[] {
  if (!Array.isArray(payload)) return [];
  const seen = new Set<string>();
  const result: ParsedIntent[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    const goal = typeof record.goal === "string" ? record.goal.trim().replace(/\s+/g, " ") : "";
    if (!isProactiveKind(kind) || !goal) continue;
    const goalText = goal.slice(0, 160);
    const key = `${kind}:${goalText}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      kind,
      goal: goalText,
      confidence: readConfidence(record.confidence, 0.5),
      urgency: readConfidence(record.urgency, 0.5),
    });
    if (result.length >= limit) break;
  }
  return result;
}

/** 写正文的系统提示词：人设 + 语气示例（示例只对齐怎么说，不改变输出格式）。 */
export function buildMessageSystemPrompt(characterName: string, persona: string, styleExamples?: string): string {
  const lines = [
    `你是「${characterName}」。下面是你的设定：`,
    "",
    persona.slice(0, 12_000),
  ];
  const style = (styleExamples ?? "").trim();
  if (style) {
    lines.push(
      "",
      "## 你平时说话的样子（只学语气，不要照抄句子）",
      style.slice(0, 4_000),
    );
  }
  lines.push(
    "",
    "## 现在要做什么",
    "你要主动给他说一句话。这是你先开的口，不是回复他。",
    "",
    "- 不超过 30 个字。说完就停，不要凑长度。",
    "- 直接开口，不要解释「我为什么找你」，也不要寒暄铺垫。",
    "- 绝对不要提「记忆」「系统」「资料」「刚才看到」这类暴露机制的话。",
    "- 没有具体的事可说，就只输出一个减号 `-`，宁可不发。",
    "- 只输出这句话本身，不要引号、不要前缀、不要括号里的动作说明。",
  );
  return lines.join("\n");
}

export function buildMessageUserPrompt(
  intent: { goal: string; kind: ProactiveKind },
  materials: ProactiveMaterials,
): string {
  const background = materials.memories.slice(0, 4);
  return [
    `我想说的是：${intent.goal}`,
    `开口方式：${PROACTIVE_KINDS[intent.kind]}`,
    "",
    ...(background.length ? ["背景（只是背景，不要整段复述）：", ...background.map((line) => `- ${line}`), ""] : []),
    "写那一句话。",
  ].join("\n");
}

/** 清理模型给的正文：去引号、去前缀、去换行，认 `-` 为「不说」。 */
export function parseMessage(reply: string): string {
  let text = (reply || "").trim();
  if (!text) return "";
  text = text.replace(/^(正文|消息|私信)\s*[：:]\s*/, "");
  text = text.replace(/^["'「『（(]+/, "").replace(/["'」』）)]+$/, "");
  text = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!text || /^[-—–]+$/.test(text)) return "";
  return text.slice(0, 200);
}

/** 供提示词用的设置摘要（让她知道现在是几点、能不能打扰）。 */
export function describeQuietWindow(settings: ProactiveSettings): string {
  return `${settings.quietStart}–${settings.quietEnd} 不打扰`;
}
