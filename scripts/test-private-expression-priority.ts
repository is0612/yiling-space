import assert from "node:assert/strict";
import { selectExpressionHabitsForPrompt, type ExpressionHabitSearchRecord } from "../server/utils/expression-habit-retrieval";
const general: ExpressionHabitSearchRecord[] = Array.from({ length: 12 }, (_, index) => ({
  id: `a-${index}`, kind: "TONE", content: "通用风格参考，不要求每次使用。".repeat(4), context: "", status: "ACTIVE", revision: 1, chatScope: "ALL",
}));
const privateRule: ExpressionHabitSearchRecord = { id: "z-private", kind: "WORDING", content: "私聊遵守当前用户已确认的标点要求。", context: "", status: "ACTIVE", revision: 1, chatScope: "PRIVATE" };
const groupRule: ExpressionHabitSearchRecord = { ...privateRule, id: "z-group", chatScope: "GROUP", content: "群聊采用已确认的公开称呼。" };
const rows = [...general, privateRule, groupRule];
const privateSelected = selectExpressionHabitsForPrompt("晚安", rows, 400, undefined, "PRIVATE");
assert.equal(privateSelected[0]?.id, privateRule.id, "Scene-specific confirmed rules must survive a crowded generic catalog");
assert(!privateSelected.some(item => item.id === groupRule.id));
const groupSelected = selectExpressionHabitsForPrompt("晚安", rows, 400, undefined, "GROUP");
assert.equal(groupSelected[0]?.id, groupRule.id);
assert(!groupSelected.some(item => item.id === privateRule.id), "Private guidance cannot leak into a group");
assert(!selectExpressionHabitsForPrompt("晚安", rows, 400).some(item => item.id === privateRule.id), "Unspecified scene does not grant a private rule");
assert(!selectExpressionHabitsForPrompt("晚安", [{ ...privateRule, status: "PENDING" }], 400, undefined, "PRIVATE").length);
assert(!selectExpressionHabitsForPrompt("晚安", [privateRule], 0, undefined, "PRIVATE").length, "Scene priority never bypasses the budget");
console.log("Private expression scene priority and isolation passed (no database or model).");
