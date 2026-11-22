export function shouldRepairRepeatedReply(reply: string, recent: readonly { role: string; content: string }[], currentMessage: string): boolean {
  const text = reply.trim();
  if (text.length < 16 || /(?:请|麻烦|帮我|给我|你能|你可以|能不能|可以)?(?:再说|复述|重发|再发|再念|再读)(?:一遍|一次|一下|刚才|上一|那句|这句)|(?:请|帮我|给我|你)(?:重复)(?:一遍|一次|一下|刚才|上一|那句|这句)|(?:把|将).{0,40}(?:原样|重复|再说).{0,8}(?:一遍|一次|发来)|原样(?:说|发)|(?:please )?repeat (?:that|it|the)|say (?:it|that) again/iu.test(currentMessage)) return false;
  return recent.filter(row => row.role === "ASSISTANT").slice(-3).some(row => row.content.trim() === text);
}

/** Only generated bracket tokens are normalized; stored originals are untouched. */
export function normalizeStickerContext(text: string): string {
  return text.replace(/\[表情包[:：][^\[\]]{0,2000}\]/gu, "[表情包]");
}
