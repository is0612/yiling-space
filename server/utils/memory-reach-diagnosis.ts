/**
 * 「这条记忆为什么没进提示词」的判定，抽成纯函数。
 *
 * 诊断脚本要能说清四档，但如果判定逻辑写在脚本里，它就只能靠人眼看输出，
 * 改了检索顺序也没人会发现判定已经对不上。这里只处理已知事实，不查库：
 *
 *   missing         —— 这条记忆在库里就不存在
 *   not_in_scope    —— 存在，但不在本次可读范围
 *   keyword_miss    —— 在可读范围里，但和问句没有共同词（词面检索拿不到）
 *   budget_dropped  —— 命中了，但被条数或 token 预算挤掉
 *   selected        —— 已放进提示词
 *
 * 「已放入但模型没用」不在这里：那要看模型自报引用，属于回合详情。
 */

export type MemoryReachInput = {
  /** 库里的状态；null 表示查不到这条记录。 */
  stored: { status: string; deletedAt: Date | null; inReadableScope: boolean } | null;
  /** 是否在候选集里（可读范围内的近期窗口 + 主题补查）。 */
  inCandidates: boolean;
  /** 相关度全量排序里的位次（1 起）；undefined = 关键词没命中。 */
  rank: number | undefined;
  /** 是否进了最终提示词。 */
  inPrompt: boolean;
};

export type MemoryReachVerdict =
  | "missing"
  | "not_in_scope"
  | "keyword_miss"
  | "budget_dropped"
  | "selected";

export type MemoryReachDiagnosis = {
  verdict: MemoryReachVerdict;
  /** 给人看的一句话，可以直接进命令行或面板。 */
  reason: string;
};

export function diagnoseMemoryReach(input: MemoryReachInput): MemoryReachDiagnosis {
  const { stored } = input;
  if (!stored || stored.deletedAt) return { verdict: "missing", reason: "库里没有这条记忆（或已被删除）。" };
  if (!stored.inReadableScope) return { verdict: "not_in_scope", reason: "这条记忆在别的范围里，本轮读不到。" };
  if (stored.status !== "ACTIVE") return { verdict: "not_in_scope", reason: `这条记忆状态是 ${stored.status}，不参与检索。` };
  if (input.inPrompt) return { verdict: "selected", reason: "已放入提示词。" };
  // 进了提示词已经是上一档；这里只可能是没进。
  if (!input.inCandidates) return { verdict: "keyword_miss", reason: "不在本轮候选集里：问句和它没有共同词，也不在近期窗口内。" };
  if (input.rank === undefined) return { verdict: "keyword_miss", reason: "关键词没命中：问句和这条记忆没有共同词。" };
  return {
    verdict: "budget_dropped",
    reason: `关键词命中，相关度排第 ${input.rank} 位，但被条数或 token 预算挤掉。`,
  };
}
