import assert from "node:assert/strict";
import { extractRetrievalTerms, rankMemoryCandidates, rankSnapshotCandidates } from "../server/utils/memory-retrieval";

const query = "用户喜欢科幻电影和太空题材";
const terms = extractRetrievalTerms(query);
assert(terms.includes("科幻") && terms.includes("电影"), "Chinese topic bigrams should be extracted for keyword retrieval.");
assert(terms.includes("科幻电影") && terms.includes("太空题材"), "Short Chinese topic phrases should be kept as high-value signals.");
assert(!terms.includes("用户") && !terms.includes("喜欢"), "Generic query-intent words should not dilute content matching.");

const englishTerms = extractRetrievalTerms("What did we discuss about science fiction movies");
assert(englishTerms.includes("science") && englishTerms.includes("fiction") && englishTerms.includes("movies"));
assert(!englishTerms.includes("what") && !englishTerms.includes("did") && !englishTerms.includes("we") &&
  !englishTerms.includes("about") && !englishTerms.includes("discuss"),
  "Common English query-intent words should not dominate retrieval.");
const preferenceTerms = extractRetrievalTerms("What do I like about science fiction?");
assert(preferenceTerms.includes("science") && preferenceTerms.includes("fiction") && !preferenceTerms.includes("like"),
  "English preference verbs should not outweigh the actual topic.");

const memories = [
  { id: "memory-film", content: "用户明确说喜欢科幻电影，尤其是太空探索题材。", updatedAt: "2026-10-20T10:00:00.000Z" },
  { id: "memory-topic-match", content: "用户还提到太空题材纪录片，以及科幻游戏。", updatedAt: "2026-10-24T10:00:00.000Z" },
  { id: "memory-food", content: "用户不喜欢香菜，点餐时偏好清淡口味。", updatedAt: "2026-10-23T10:00:00.000Z" },
];

const rankedMemories = rankMemoryCandidates(query, memories, 2);
assert.equal(rankedMemories.length, 2, "Retrieval should respect the requested result limit.");
assert.equal(rankedMemories[0]?.id, "memory-film", "A candidate matching both specific topic phrases should outrank a newer partial match.");
assert(rankedMemories.every((item) => item.relevanceScore > 0));
assert(rankedMemories[0]?.matchedTerms.includes("科幻电影"), "Matched terms should expose the specific phrase that improved ranking.");
assert(!rankMemoryCandidates("本周天气如何", memories).length, "Unrelated content should not be returned as relevant memory.");

const snapshots = [
  { id: "snapshot-1", summary: "本周期讨论了科幻电影与太空探索，并约好一起看一部新片。", periodEnd: "2026-10-21T00:00:00.000Z" },
  { id: "snapshot-2", summary: "用户询问了周末做饭和清淡饮食的建议。", periodEnd: "2026-10-22T00:00:00.000Z" },
  { id: "snapshot-3", summary: "记录了太空题材纪录片的推荐清单。", periodEnd: "2026-10-23T00:00:00.000Z" },
];
const rankedSnapshots = rankSnapshotCandidates("我们之前聊过什么科幻电影", snapshots);
assert.equal(rankedSnapshots[0]?.id, "snapshot-1", "Snapshots with overlapping specific topics should rank first.");
assert.equal(rankSnapshotCandidates("完全无关的海边天气", snapshots).length, 0, "Unrelated snapshots should be excluded.");

console.log("Memory retrieval tests passed: Chinese intent-word filtering, English stopwords, phrase-aware weighting, result limits, and unrelated-context exclusion.");
