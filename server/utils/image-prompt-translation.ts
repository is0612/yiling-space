/**
 * 把绘图提示词翻成英文 Danbooru 标签 —— **只给本机 Anima 用**。
 *
 * 为什么要多花一次模型调用：
 *
 *   MiniMax 那类云端模型读得懂中文，所以「她写中文画面描述 → 直接发过去」一直是对的。
 *   Anima 训练在英文标签上，中文会被整段忽略 —— 更糟的是，形象档案里的中文外貌描述
 *   （【人物】那段）是**服务端拼进去的**，聊天模型根本看不到，也就没法自己顺手翻掉。
 *   结果就是：场景对了，人不像她。
 *
 * 谁来翻：用这个角色自己的聊天模型翻。一次几百 token，比一张图便宜两个数量级，
 * 而且它写标签的格式（1girl, long blue hair, …）本来就在同一个语言空间里。
 *
 * 三个刻意的取舍：
 *   1. **只管本地引擎**。云端走中文通得更自然，多翻一次只会让画面偏离原描述。
 *   2. **只在真的有中文时翻**。模型已经按标签写了就原样发，别做无谓的改写。
 *   3. **翻失败就退回原文**。宁可图差一点，也不能因为翻译接口抖一下就整轮不出图。
 *
 * 2026-11-24 补的两层保险：解析宽容 + 失败重试一次。
 * 那次「四个人鱼」的现场是 `[image] 提示词翻译结果不可用，这次按原文送引擎` ——
 * 模型其实答了，只是没按两行协议写（给了 JSON 或先来一句解释），旧解析器把整段
 * 判废，中文原样进了 CLIP。一次翻译几毛钱都不到，重问一次比出一张随机图便宜得多。
 */
import { callRawModel } from "./raw-llm";
import { parseJsonLoose } from "./loose-json";

/** 缓存上限。同一角色的形象档案很少变，翻一次能复用很多张图。 */
const MAX_CACHE = 64;
const cache = new Map<string, { positive: string; negative: string }>();

/** 提示词里还有中文（Anima 读不懂的部分）。 */
export function needsTagTranslation(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(String(text ?? ""));
}

/**
 * 模型输出的一行 → 干净标签。
 *
 * 模型常见的跑偏都要在这里收掉：包 ``` / ```json 代码块、加一句「翻译结果：」、
 * 加列表符号、或者干脆把中文解释也带上（带中文就整行作废，否则等于把噪声塞进 CLIP）。
 */
export function cleanTagLine(raw: string): string | null {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  text = text.replace(/^```(?:json)?\s*/iu, "").replace(/```$/u, "").trim();
  text = text.replace(/^[-*•]\s*/u, "").trim();
  text = text.replace(/^(?:positive|negative|正向|负面|正向提示词|负面提示词|翻译|translation|tags?|结果|输出)\s*[:：=]\s*/iu, "").trim();
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "").trim();
  if (!text) return null;
  // 带中文就是不合格：这段最终会送进 CLIP，中文字符只会变成噪声。
  if (needsTagTranslation(text)) return null;
  const normalized = text
    .replace(/[，、；]/gu, ",")
    .replace(/\s+/gu, " ")
    .replace(/\s*,\s*/gu, ", ")
    .replace(/,{2,}/gu, ",")
    .replace(/^,|,$/gu, "")
    .trim();
  return normalized.length >= 2 ? normalized : null;
}

/** 模型爱把标签名换着写，这里统一收口。 */
const LABELED_LINE = /^(positive\s*prompt|negative\s*prompt|正向提示词|负面提示词|positive|negative|正向|负面)\s*[:：=]\s*(.*)$/iu;
const NEGATIVE_LABEL = /^(?:negative|负面|negative\s*prompt)$/iu;

function readObjectField(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/**
 * 解析翻译结果，认三种形状：
 *
 *   1. 两行协议 `POSITIVE: … / NEGATIVE: …`（首选，短任务里最稳）；
 *   2. JSON 对象 `{"positive": "…", "negative": "…"}` —— 聊天模型被 JSON 契约
 *      训练狠了，明明要两行也常顺手回一个 JSON，还可能带 ```json 围栏和一句废话；
 *   3. 只有一串标签、没有任何标签名 —— 当正向用。前面那句「翻译结果：」要跳过，
 *      不能因为它解不出来就把整段判废。
 *
 * 不用 `JSON.parse` 裸解：`parseJsonLoose` 专门处理围栏和前后废话，且 `expect: "object"`
 * 不会把正文里的 `[3]` 当成结果。
 */
export function parseTagTranslation(raw: string): { positive: string; negative: string } | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  const object = parseJsonLoose(text, { expect: "object" });
  if (object && typeof object === "object" && !Array.isArray(object)) {
    const record = object as Record<string, unknown>;
    const positive = cleanTagLine(readObjectField(record, ["positive", "POSITIVE", "正向", "positivePrompt", "prompt", "tags"]));
    if (positive) {
      return { positive, negative: cleanTagLine(readObjectField(record, ["negative", "NEGATIVE", "负面", "negativePrompt"])) ?? "" };
    }
  }

  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  let positiveRaw = "";
  let negativeRaw = "";
  const unlabeled: string[] = [];
  for (const line of lines) {
    const unfenced = line.replace(/^```(?:json)?\s*/iu, "").replace(/```$/u, "").replace(/^[-*•]\s*/u, "").trim();
    if (!unfenced || unfenced === "```") continue;
    const matched = LABELED_LINE.exec(unfenced);
    if (matched) {
      if (NEGATIVE_LABEL.test(matched[1]!)) negativeRaw = matched[2]!;
      else positiveRaw = matched[2]!;
    } else {
      unlabeled.push(unfenced);
    }
  }
  // 没有标签名时，取第一条**真的能当标签用**的行：跳过「翻译结果：」「好的，这是：」这类废话。
  if (!positiveRaw) {
    const usable = unlabeled.find(line => cleanTagLine(line) !== null);
    if (usable) positiveRaw = usable;
  }
  const positive = cleanTagLine(positiveRaw);
  if (!positive) return null;
  return { positive, negative: cleanTagLine(negativeRaw) ?? "" };
}

const SYSTEM_PROMPT = [
  "You convert a Chinese visual description into English Danbooru-style tags for an anime image model (Anima).",
  "Output exactly two lines and nothing else:",
  "POSITIVE: <lowercase English tags separated by commas>",
  "NEGATIVE: <lowercase English tags separated by commas, or empty>",
  "Rules: translate meaning, never transliterate; keep character identity details (hair colour, eye colour, hairstyle, body type, signature features), clothing, pose, scene, composition, lighting and style; drop any instruction about how to use reference images or about drawing tools; no Chinese characters anywhere; no explanations, quotes or extra labels.",
  "Use the model's standard composition tags instead of literal translations: `portrait`, `upper body`, `cowboy shot`, `full body` for 头像 / 半身 / 七分身 / 全身; `looking back`, `from behind`, `looking at viewer` for 回眸 / 背影 / 看向镜头.",
  "Never add quality tags (masterpiece, best quality, score_*): the application prepends its own.",
].join("\n");

/**
 * 第二次机会：把第一次的坏输出原样贴回去，只要求重写成两行。
 * 比「再问一遍同样的问题」有效 —— 模型能看见自己刚才跑偏成什么样。
 */
const REPAIR_SYSTEM_PROMPT = [
  "You repair a failed translation into English Danbooru tags for an anime image model (Anima).",
  "The previous answer could not be parsed. Output exactly two lines, nothing else, no JSON, no code fences, no explanation:",
  "POSITIVE: <lowercase English tags separated by commas>",
  "NEGATIVE: <lowercase English tags separated by commas, or empty>",
  "Keep character identity details, clothing, pose, scene, composition, lighting and style; no Chinese characters anywhere.",
  "Never add quality tags (masterpiece, best quality, score_*): the application prepends its own.",
].join("\n");

export type TagTranslationInput = {
  positive: string;
  negative: string;
  model: string;
  apiKey: string;
  apiBaseUrl?: string;
};

type Attempt = { ok: true; raw: string } | { ok: false; error: string };

/**
 * 翻一次，带进程内缓存；第一次拿不到可用结果时**重问一次**，仍失败才返回 null。
 *
 * 缓存键是「正 + 负」的原文：形象档案和这一轮的场景都没变时，重复出的图不用再翻一遍。
 * 失败不进缓存 —— 模型抖一下不该让接下来几十张图都用中文硬送引擎。
 */
export async function translateImagePromptToTags(input: TagTranslationInput): Promise<{ positive: string; negative: string } | null> {
  const positive = String(input.positive ?? "").trim();
  const negative = String(input.negative ?? "").trim();
  if (!positive && !negative) return null;

  const cacheKey = `${positive}\u0001${negative}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const ask = async (systemPrompt: string, userPrompt: string, maxTokens: number, timeoutCapMs: number): Promise<Attempt> => {
    try {
      const raw = await callRawModel({
        systemPrompt,
        userPrompt,
        model: input.model,
        apiKey: input.apiKey,
        apiBaseUrl: input.apiBaseUrl,
        temperature: 0.2,
        // 只要两行标签：给宽预算但关掉思考，省掉「想半天再输出」的那几秒。
        maxTokens,
        thinking: false,
        timeoutCapMs,
      });
      return { ok: true, raw };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const originalPrompt = `POSITIVE:\n${positive || "（无）"}\n\nNEGATIVE:\n${negative || "（无）"}`;
  const first = await ask(SYSTEM_PROMPT, originalPrompt, 1200, 20_000);
  let parsed = first.ok ? parseTagTranslation(first.raw) : null;
  if (!parsed) {
    // 第一次是解析不出来还是压根没回来，日志要分开说，别都记成「结果不可用」。
    console.warn("[image] 提示词翻译第一次没拿到可用结果，重问一次", first.ok
      ? { chars: first.raw.length, head: first.raw.slice(0, 80) }
      : { error: first.error.slice(0, 120) });
    const repairPrompt = [
      originalPrompt,
      "",
      "PREVIOUS ANSWER (could not be parsed, rewrite it as exactly two labeled lines):",
      (first.ok ? first.raw : "(no answer)").slice(0, 600),
    ].join("\n");
    const repaired = await ask(REPAIR_SYSTEM_PROMPT, repairPrompt, 600, 12_000);
    parsed = repaired.ok ? parseTagTranslation(repaired.raw) : null;
    if (!parsed) {
      console.warn("[image] 提示词翻译重试后仍不可用，这次按原文送引擎", repaired.ok
        ? { chars: repaired.raw.length, head: repaired.raw.slice(0, 80) }
        : { error: repaired.error.slice(0, 120) });
      return null;
    }
  }

  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, parsed);
  return parsed;
}

/** 给测试用：别让缓存串到别的用力里。 */
export function clearTagTranslationCache(): void {
  cache.clear();
}
