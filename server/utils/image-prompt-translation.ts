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
 */
import { callRawModel } from "./raw-llm";

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
 * 模型常见的三种跑偏都要在这里收掉：包 ``` 代码块、加一句「翻译结果：」、
 * 或者干脆把中文解释也带上（带中文就整行作废，否则等于把噪声塞进 CLIP）。
 */
export function cleanTagLine(raw: string): string | null {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  text = text.replace(/^```[a-z]*\s*/iu, "").replace(/```$/u, "").trim();
  text = text.replace(/^(?:positive|negative|正向|负面|正向提示词|负面提示词|翻译|translation|tags?|结果|输出)\s*[:：]\s*/iu, "").trim();
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

/**
 * 解析「POSITIVE: … / NEGATIVE: …」两行协议。
 *
 * 不用 JSON：这种短任务里让模型输出 JSON，它常顺手带上 markdown 围栏和解释，
 * 而有标签前缀的纯文本既好解析、出错也容易看出来（缺行 → 直接判失败）。
 */
export function parseTagTranslation(raw: string): { positive: string; negative: string } | null {
  const lines = String(raw ?? "").split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  let positiveRaw = "";
  let negativeRaw = "";
  for (const line of lines) {
    if (/^(?:positive|正向)\s*[:：]/iu.test(line)) positiveRaw = line;
    else if (/^(?:negative|负面)\s*[:：]/iu.test(line)) negativeRaw = line;
    // 没有前缀的第一行当正向：模型偶尔会省掉标签直接给标签串
    else if (!positiveRaw && !negativeRaw) positiveRaw = line;
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

export type TagTranslationInput = {
  positive: string;
  negative: string;
  model: string;
  apiKey: string;
  apiBaseUrl?: string;
};

/**
 * 翻一次，带进程内缓存。任何失败都返回 null（调用方退回原文），不抛。
 *
 * 缓存键是「正 + 负」的原文：形象档案和这一轮的场景都没变时，重复出的图不用再翻一遍。
 */
export async function translateImagePromptToTags(input: TagTranslationInput): Promise<{ positive: string; negative: string } | null> {
  const positive = String(input.positive ?? "").trim();
  const negative = String(input.negative ?? "").trim();
  if (!positive && !negative) return null;

  const cacheKey = `${positive}\u0001${negative}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const raw = await callRawModel({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `POSITIVE:\n${positive || "（无）"}\n\nNEGATIVE:\n${negative || "（无）"}`,
      model: input.model,
      apiKey: input.apiKey,
      apiBaseUrl: input.apiBaseUrl,
      temperature: 0.2,
      // 只要两行标签：给宽预算但关掉思考，省掉「想半天再输出」的那几秒。
      maxTokens: 1200,
      thinking: false,
      timeoutCapMs: 20_000,
    });
    const parsed = parseTagTranslation(raw);
    if (!parsed) {
      console.warn("[image] 提示词翻译结果不可用，这次按原文送引擎", { chars: raw.length });
      return null;
    }
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(cacheKey, parsed);
    return parsed;
  } catch (error) {
    console.warn("[image] 提示词翻译失败，这次按原文送引擎", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** 给测试用：别让缓存串到别的用力里。 */
export function clearTagTranslationCache(): void {
  cache.clear();
}
