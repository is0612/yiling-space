/** Current user wording only; never call this on vision captions, quotes or background. */
export function isExplicitMediaQuestion(text: string, hasQuotedImage = false): boolean {
  const compact = text.trim().replace(/\s+/gu, "");
  if (hasQuotedImage && /^(?:这个|这张|这个呢|这张呢|你看|你看这个|你看这里|这里|看看|看看这个|看一下|这是什么|这是啥|什么意思|啥意思|这个什么意思|这个啥意思)[，。.!！?？]*$/u.test(compact)) return true;
  return /(?:图里|图片里|这张图|这个图|这张表情|这个表情|表情包|图片).{0,16}(?:什么|啥|意思|写|内容|解释|描述|看得|看清|看见|看到)/u.test(compact)
    || /(?:看看|看一下|解释|描述|识别|读一下).{0,8}(?:这张|这个图|图里|图片|表情)/u.test(compact)
    || /(?:你画的|你刚才画的|自己画的).{0,8}(?:图|图片).{0,8}(?:什么|啥|样|看|内容)/u.test(compact);
}

/** A request to inspect the latest generated result, not a general capability question. */
export function isLatestGeneratedImageQuestion(text: string): boolean {
  if (/(第一次|最早|以前|原来|上次|之前那)/u.test(text)) return false;
  return /(?:你(?:自己|刚才|刚刚|这次)?(?:画|出|生成)(?:的|出来的)?(?:这|那)?(?:张)?(?:图|图片)|自己画的图)/u.test(text)
    && /(什么样|啥样|有什么|内容|画面|描述|看一下|看看|看一眼)/u.test(text);
}

/** Reading the actual prompt needs asset evidence but never an extra vision call. */
export function isLatestGeneratedPromptQuestion(text: string): boolean {
  if (/(第一次|最早|以前|原来|上次|之前那)/u.test(text)) return false;
  return /(?:你(?:刚刚|刚才|这次)?(?:画|生成)(?:这个|这张|的图|出来的图)|(?:刚才|这次)(?:那|这)?张图).{0,12}(?:提示词|prompt)/iu.test(text);
}

/** One shared attempt budget for inbound pictures, quoted pictures and generated-image inspection. */
export type MediaVisionBudget = { readonly remaining: number; consume(count?: number): boolean };
export function createMediaVisionBudget(limit = 3): MediaVisionBudget {
  let remaining = Math.max(0, Math.floor(limit));
  return { get remaining() { return remaining; }, consume(count = 1) {
    if (!Number.isSafeInteger(count) || count < 1 || count > remaining) return false;
    remaining -= count;
    return true;
  } };
}
