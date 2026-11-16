import assert from "node:assert/strict";
import { projectToolMemories, projectToolKnowledge, qqReadOnlyTaskRequested } from "../server/utils/qq-read-only-tools";
import type { MemoryAssistantCandidate } from "../server/utils/memory-assistant";
import { readFile } from "node:fs/promises";
const row: MemoryAssistantCandidate = { sourceKey: "memory/internal", id: "internal", sourceType: "memory", scope: "character", relevanceScore: 1, content: "账号123456789 " + "文".repeat(1500) };
const projected = projectToolMemories([ { ...row, scope: "private", content: "PRIVATE" }, ...Array.from({ length: 8 }, () => row) ], true);
assert.equal(projected.length, 6);
assert(projected.every(item => item.content.length <= 800));
assert(!JSON.stringify(projected).includes("123456789"));
assert(!JSON.stringify(projected).includes("PRIVATE"));
for (const key of ["sourceKey", "scopeId", "memoryScopeId", "conversationId", "internal"]) assert(!JSON.stringify(projected).includes(key));
assert.equal(projectToolMemories([{ ...row, scope: "private" }], false).length, 1);
const knowledge = projectToolKnowledge(Array.from({ length: 8 }, () => ({ id: "secret", title: "资料123456789", content: "文".repeat(1200), category: "FACT", tags: [] })));
assert.equal(knowledge.length, 6); assert(knowledge.every(item => item.content.length <= 800));
assert(!JSON.stringify(knowledge).includes("secret")); assert(!JSON.stringify(knowledge).includes("123456789"));
assert(!qqReadOnlyTaskRequested("早上好")); assert(qqReadOnlyTaskRequested("查一下之前的约定")); assert(qqReadOnlyTaskRequested("https://example.com/project"));
for (const path of ["group-context-reply.ts", "memory-assistant.ts"]) {
 const source = await readFile(new URL(`../server/utils/${path}`, import.meta.url), "utf8");
 assert(source.includes("const { readOnlyTools, ...chatData } = input.chatInput"));
 assert(source.includes("snapshotAssistantTurnData(chatData)"));
 assert(!source.includes("snapshotAssistantTurnData(input.chatInput)"));
}
console.log("QQ read-only tool wiring: public/private scope projection, identifiers redacted, six bounded sources, task gate and callback snapshot preservation passed.");
