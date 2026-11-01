/**
 * 宽松 JSON 解析：模型经常带 ```json 围栏，或在前后加一句解释。
 *
 * 原来长在 `channel-adapter/bili/cards.ts` 里，主动机制也要解 JSON 数组，
 * 所以抽出来共用；那里保留同名导出，调用点和测试都不用改。
 */
export function parseJsonLoose(text: string, options: { expect?: "object" | "array" } = {}): unknown {
  const cleaned = (text || "").trim();
  if (!cleaned) return null;
  const unfenced = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    // 落到下面的截取
  }
  /**
   * 切括号的顺序要跟调用方要的东西一致。
   *
   * 默认数组优先，是因为这套解析最早服务于「挑几条 BV 号」。但要对象时反过来：
   * `好的：{"reply":"嗯","faces":[3]}` 这种既没围栏、前面又有废话的文本，
   * 先找 `[` 会切出 `[3]`，解出来是个数组，调用方拿 `asRecord` 一过就变成 null ——
   * 明明能救回来的对象，反而判成「不是 JSON」。所以顺序要能选，且要对象时
   * 切出数组就继续试下一个括号，别拿它交差。
   */
  const pairs = options.expect === "object"
    ? ([["{", "}"], ["[", "]"]] as const)
    : ([["[", "]"], ["{", "}"]] as const);
  for (const [open, close] of pairs) {
    const start = unfenced.indexOf(open);
    const end = unfenced.lastIndexOf(close);
    if (start >= 0 && end > start) {
      try {
        const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
        if (options.expect === "object" && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))) {
          continue;
        }
        return parsed;
      } catch {
        // 继续试下一个括号
      }
    }
  }
  return null;
}
