import assert from "node:assert/strict";
import { diagnoseMemoryReach, type MemoryReachInput } from "../server/utils/memory-reach-diagnosis";

const stored = (overrides: Partial<NonNullable<MemoryReachInput["stored"]>> = {}): MemoryReachInput["stored"] =>
  ({ status: "ACTIVE", deletedAt: null, inReadableScope: true, ...overrides });

const cases: Array<[string, MemoryReachInput, string]> = [
  ["查不到", { stored: null, inCandidates: false, rank: undefined, inPrompt: false }, "missing"],
  ["已软删", { stored: stored({ deletedAt: new Date() }), inCandidates: false, rank: undefined, inPrompt: false }, "missing"],
  ["范围不可读", { stored: stored({ inReadableScope: false }), inCandidates: false, rank: undefined, inPrompt: false }, "not_in_scope"],
  ["已替代", { stored: stored({ status: "SUPERSEDED" }), inCandidates: true, rank: 2, inPrompt: false }, "not_in_scope"],
  ["候选外", { stored: stored(), inCandidates: false, rank: undefined, inPrompt: false }, "keyword_miss"],
  ["命中未进", { stored: stored(), inCandidates: true, rank: undefined, inPrompt: false }, "keyword_miss"],
  ["被挤掉", { stored: stored(), inCandidates: true, rank: 9, inPrompt: false }, "budget_dropped"],
  ["已放入", { stored: stored(), inCandidates: true, rank: 1, inPrompt: true }, "selected"],
];

for (const [label, input, verdict] of cases) {
  const result = diagnoseMemoryReach(input);
  assert.equal(result.verdict, verdict, `${label}：期望 ${verdict}，实际 ${result.verdict}`);
  assert(result.reason.length > 0 && result.reason.length <= 80, `${label}：结论要有可读理由且不啰嗦`);
}

// 已放入时不该再被后面几档覆盖：检索成功被误报成「挤掉」会让排查走反方向。
assert.equal(diagnoseMemoryReach({ stored: stored(), inCandidates: false, rank: undefined, inPrompt: true }).verdict, "selected");
// 已替代的记忆即使意外进了候选，也要先说状态，不能只说「没命中」。
assert.match(diagnoseMemoryReach({ stored: stored({ status: "INVALIDATED" }), inCandidates: true, rank: 3, inPrompt: false }).reason, /INVALIDATED/);
// 排在被挤掉时要把位次写进去，否则用户不知道该往前挪多少。
assert.match(diagnoseMemoryReach({ stored: stored(), inCandidates: true, rank: 12, inPrompt: false }).reason, /第 12 位/);

console.log("记忆可达性判定通过：查不到/软删/范围外/状态失效/候选外/未命中/被挤掉/已放入，且已放入优先于后续档位。");
