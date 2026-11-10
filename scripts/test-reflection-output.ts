import assert from "node:assert/strict";
import { parseJsonLoose } from "../server/utils/loose-json";
import { dedupeReflectionSuggestions, reflectionSourcesHash, normalizeReflectionSuggestions, type ReflectionSource } from "../server/utils/reflection-worker";

const source: ReflectionSource = {
  key: "memory:6c66d8c4-80a8-4b84-9c20-1b9bb72a09b4", type: "memory",
  id: "6c66d8c4-80a8-4b84-9c20-1b9bb72a09b4", hash: "a".repeat(64), title: "公开经历", excerpt: "给模型的有限来源摘录",
};
const valid = { title: "  先核对再下结论  ", observation: "记录里有一次纠正。", inference: "可能说明核对来源有帮助。", recommendation: "下次先核对来源。", sourceRefs: [source.key] };
const normalize = (suggestions: unknown[]) => normalizeReflectionSuggestions({ suggestions }, [source]);
const [result] = normalize([valid]);
assert(result);
assert.equal(result.title, "先核对再下结论");
assert.deepEqual(result.sourceRefs, [source]);
const forged = normalize([{ ...valid, sourceTitle: "模型伪造标题", excerpt: "模型伪造内容" }])[0]!;
assert.deepEqual(forged.sourceRefs, [source], "来源标题和摘录只取服务端白名单，忽略模型自填字段");
assert.deepEqual(normalize([]), []);
assert.deepEqual(normalize([{ ...valid, sourceRefs: [] }]), []);
assert.deepEqual(normalize([{ ...valid, sourceRefs: ["memory:invented"] }]), []);
assert.deepEqual(normalize([{ ...valid, sourceRefs: [source.key, "knowledge:invented"] }]), [], "One fabricated reference invalidates the entire suggestion.");
assert.deepEqual(normalize([{ ...valid, sourceRefs: [{ key: source.key }] }]), []);
assert.deepEqual(normalize([{ ...valid, title: " " }]), []);
assert.deepEqual(normalize([{ ...valid, observation: 12 }]), []);
assert.deepEqual(normalize([{ ...valid, title: "x".repeat(201) }]), []);
for (const field of ["observation", "inference", "recommendation"]) {
  assert.deepEqual(normalize([{ ...valid, [field]: "x".repeat(1501) }]), []);
}
assert.equal(normalize([{ ...valid, title: "x".repeat(200), observation: "x".repeat(1500) }]).length, 1);
assert.equal(normalize([{ ...valid, sourceRefs: [source.key, source.key] }])[0]!.sourceRefs.length, 1);
assert.equal(normalize([null, valid, { ...valid, sourceRefs: ["fake"] }]).length, 1);
assert.equal(normalize([valid, valid, valid]).length, 3);
for (const root of [null, [], "{}", 1, {}, { suggestions: null }, { suggestions: {} }, { suggestions: [valid, valid, valid, valid] }]) {
  assert.throws(() => normalizeReflectionSuggestions(root, [source]), /格式无效/);
}
assert.deepEqual(normalizeReflectionSuggestions({ suggestions: [valid] }, [{ ...source, hash: "fake" }]), []);
assert.deepEqual(normalizeReflectionSuggestions({ suggestions: [valid] }, [{ ...source, id: "invalid" }]), []);
const fenced = `\`\`\`json\n${JSON.stringify({ suggestions: [valid] })}\n\`\`\``;
assert.equal(normalizeReflectionSuggestions(parseJsonLoose(fenced, { expect: "object" }), [source]).length, 1);
const changed = { ...source, hash: "b".repeat(64) };
assert.equal(reflectionSourcesHash([source, changed]), reflectionSourcesHash([changed, source]));
assert.notEqual(reflectionSourcesHash([source]), reflectionSourcesHash([changed]));
assert.deepEqual(dedupeReflectionSuggestions([result], [[source]]), []);
assert.equal(dedupeReflectionSuggestions([result, { ...result, title: "不同措辞" }], []).length, 1);
assert.equal(dedupeReflectionSuggestions([{ ...result, sourceRefs: [changed] }], [[source]]).length, 1);
assert.equal(dedupeReflectionSuggestions([result], [null, {}]).length, 1);
console.log("Reflection output checks passed: bounds, empty results, strict root, fabricated reference rejection, canonical hashes, evidence deduplication and fenced JSON; no database/model calls.");
