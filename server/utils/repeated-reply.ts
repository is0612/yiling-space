/**
 * 复读检测：拦「同一句话再说一遍」。
 *
 * 两档判定，都是踩出来的：
 * ① **严格相等 / 归一化后相等**（≥16 字）：只改标点、空白、全半角的复读，
 *    逐字比较抓不到，但听感上一模一样 —— 归一化后相等就拦。
 * ② **bigram Dice ≥ 0.85**（归一化后 ≥20 字）：换语气词、插两三个字的
 *    「换皮复读」。阈值按 2026-11-26 的真实案例校准：认错句式换标点重发
 *    Dice 0.877，同话题正常推进最高 0.16，留了一档 margin。
 *
 * 为什么短句永远放行：确认链（「行 那就画」「行 这就画」）相似度再高也是
 * 正常承接，归一化长度门槛把它们整段排除，不碰阈值。
 */
const REPEAT_EXPLICIT_REQUEST = /(?:请|麻烦|帮我|给我|你能|你可以|能不能|可以)?(?:再说|复述|重发|再发|再念|再读)(?:一遍|一次|一下|刚才|上一|那句|这句)|(?:请|帮我|给我|你)(?:重复)(?:一遍|一次|一下|刚才|上一|那句|这句)|(?:把|将).{0,40}(?:原样|重复|再说).{0,8}(?:一遍|一次|发来)|原样(?:说|发)|(?:please )?repeat (?:that|it|the)|say (?:it|that) again/iu;

const REPEAT_MIN_CHARS = 16;
/** 归一化相等的最小长度：与原文门槛同线，短句换标点不算复读。 */
const REPEAT_MIN_NORMALIZED_EQUAL = 16;
/** 相似度档只覆盖长回复；低于此长度一律走相等判断。 */
const REPEAT_MIN_NORMALIZED_SIMILAR = 20;
const REPEAT_DICE_THRESHOLD = 0.85;

/**
 * 全半角、大小写、标点、空白抹掉，只留可比对的字面。
 *
 * 必须保留 `\p{S}`：`+` `#` `%` 这类符号可能承载语义（C++ / C#、涨了 5%），
 * 一并删掉会把语义相反的句子归一成同一串，正常纠正会被误判成复读。
 */
function normalizeReplyText(text: string): string {
  return text.normalize("NFKC").replace(/[\s\p{P}]+/gu, "").toLowerCase();
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  for (let index = 0; index < text.length - 1; index += 1) set.add(text.slice(index, index + 2));
  return set;
}

/** Sørensen–Dice：2|A∩B| / (|A|+|B|)，比 Jaccard 对「插几个字」更宽松一档。 */
function bigramDice(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const gramsA = bigrams(a);
  const gramsB = bigrams(b);
  let intersection = 0;
  for (const gram of gramsA) if (gramsB.has(gram)) intersection += 1;
  return (2 * intersection) / (gramsA.size + gramsB.size);
}

export function shouldRepairRepeatedReply(reply: string, recent: readonly { role: string; content: string }[], currentMessage: string): boolean {
  const text = reply.trim();
  if (text.length < REPEAT_MIN_CHARS || REPEAT_EXPLICIT_REQUEST.test(currentMessage)) return false;
  const normalized = normalizeReplyText(text);
  return recent.filter(row => row.role === "ASSISTANT").slice(-3).some(row => {
    const other = row.content.trim();
    if (other === text) return true;
    const otherNormalized = normalizeReplyText(other);
    // 只改标点/空白/全半角的复读：原文不相等，归一化后逐字相同。
    if (normalized.length >= REPEAT_MIN_NORMALIZED_EQUAL && normalized === otherNormalized) return true;
    // 换语气词、插几个字的复读：长回复才比相似度，短确认链不进来。
    if (normalized.length < REPEAT_MIN_NORMALIZED_SIMILAR || otherNormalized.length < REPEAT_MIN_NORMALIZED_SIMILAR) return false;
    return bigramDice(normalized, otherNormalized) >= REPEAT_DICE_THRESHOLD;
  });
}

/** Only generated bracket tokens are normalized; stored originals are untouched. */
export function normalizeStickerContext(text: string): string {
  return text.replace(/\[表情包[:：][^\[\]]{0,2000}\]/gu, "[表情包]");
}
