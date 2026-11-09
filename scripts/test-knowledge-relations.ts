import assert from "node:assert/strict";
import { filterKnowledgeRelatedItemIds } from "../server/utils/knowledge-ai";

const allowed = ["item-a", "item-b", "item-c"];
assert.deepEqual(filterKnowledgeRelatedItemIds(["item-a", "forged-id", "item-b", "item-a"], allowed), ["item-a", "item-b"]);
assert.deepEqual(filterKnowledgeRelatedItemIds(["other-character-item"], allowed), []);
assert.deepEqual(filterKnowledgeRelatedItemIds(["item-a", 42, null, {}, "item-c"], allowed), ["item-a", "item-c"]);
assert.deepEqual(filterKnowledgeRelatedItemIds("item-a", allowed), []);
assert.deepEqual(filterKnowledgeRelatedItemIds(null, allowed), []);
assert.deepEqual(filterKnowledgeRelatedItemIds(Array.from({ length: 25 }, () => "item-a"), allowed), ["item-a"]);

console.log("Knowledge relation tests passed: allowlist enforcement, forged/cross-role ID rejection, type safety and deduplication.");
