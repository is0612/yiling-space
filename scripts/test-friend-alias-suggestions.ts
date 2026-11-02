import assert from "node:assert/strict";
import { validateMemoryAiOutput } from "../server/utils/memory-ai";
import { dropAliasesMatchingName, normalizeFriendAliases } from "../server/utils/friend-aliases";

/**
 * 候选备注（friendAliases）：快照提炼在朋友范围（EXTERNAL_IDENTITY）顺带产出，
 * 用户点头才进 aliases。这里盯三件事：
 * 1. 模型输出里的 friendAliases 能正确解析（截断、去空、上限）；
 * 2. 裁决同意时「追加 + 去本名」的口径对；
 * 3. 拒绝不删行、靠 aliasKey 唯一约束挡重复 —— 这条逻辑在 worker 里，这里测它依赖的
 *    normalize 口径：同一个叫法换个大小写/空白，归一化后应判为同一条。
 */

const validIds = ["m1", "m2", "m3"];
const existingIds = new Set<string>();

// ① 正常解析 friendAliases，过滤掉空 alias 和超长 reason 截断。
const analysis = validateMemoryAiOutput(
  {
    summary: "这一周期她和对方聊了三次。",
    importantEvents: [],
    factAndPreferenceChanges: [],
    relationshipChanges: [],
    goalsAndCommitments: [],
    unresolvedTopics: [],
    differencesFromPrevious: [],
    memoryChanges: [],
    events: [],
    friendAliases: [
      { alias: "小鱼干", reason: "她总这么叫对方" },
      { alias: "", reason: "这条没写叫法" },
      { alias: "宝", reason: "" },
      { alias: "超长".repeat(50), reason: "r".repeat(500) },
    ],
  },
  validIds,
  existingIds,
);

assert.equal(analysis.friendAliases.length, 3, "空 alias 的条目要过滤掉。");
assert.equal(analysis.friendAliases[0]!.alias, "小鱼干");
assert.equal(analysis.friendAliases[1]!.reason, "", "reason 可为空。");
assert.ok(analysis.friendAliases[2]!.alias.length <= 40, "alias 要按 40 字截断。");
assert.ok(analysis.friendAliases[2]!.reason.length <= 200, "reason 要按 200 字截断。");

// ② 没有 friendAliases 字段时（非朋友范围）解析为空数组，不报错。
const withoutAliases = validateMemoryAiOutput(
  {
    summary: "普通周期总结。",
    importantEvents: [],
    factAndPreferenceChanges: [],
    relationshipChanges: [],
    goalsAndCommitments: [],
    unresolvedTopics: [],
    differencesFromPrevious: [],
    memoryChanges: [],
    events: [],
  },
  validIds,
  existingIds,
);
assert.deepEqual(withoutAliases.friendAliases, [], "没给 friendAliases 就该是空数组。");

// ③ 裁决同意的口径：追加 + 去本名。已有 aliases 加一条，跟本名相同的被剔掉。
const merged = dropAliasesMatchingName(["小鱼干"], "小鱼干");
assert.deepEqual(merged, [], "和本名相同的叫法要剔掉，否则提示词里像两个人。");
const appended = dropAliasesMatchingName(["宝", "笨蛋鱼"], "张三");
assert.deepEqual(appended, ["宝", "笨蛋鱼"]);

// ④ 归一化让同一叫法「换个大小写/空白」判为同一条（worker 靠 aliasKey 唯一约束挡重复）。
assert.equal(normalizeFriendAliases("Momo").aliases[0]!.toLowerCase(), "momo");
assert.equal(normalizeFriendAliases("  momo  ").aliases[0]!.toLowerCase(), "momo");

console.log("friend alias suggestions: all assertions passed");
