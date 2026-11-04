import assert from "node:assert/strict";
import { readCharacterCreateInput } from "../server/utils/character-create-input";
import { readCharacterBody, readCharacterProfilePatch } from "../server/utils/character-profile-input";
import { characterCopyInput, createCharacterOperationGuard, replaceCharacter } from "../app/utils/character-management";
import { characterInclude, toCharacterDto } from "../server/utils/character-dto";

for (const value of [null, undefined, [], 42, "text"]) {
  assert.throws(() => readCharacterBody(value), (error: unknown) => (error as { statusCode?: number }).statusCode === 400);
}
assert.deepEqual(readCharacterProfilePatch({}), { data: {}, modelConfig: {} });
for (const field of ["name", "personality", "examples", "userAddress", "alias", "description"]) {
  for (const value of [null, 42, {}, [], true]) {
    assert.throws(() => readCharacterProfilePatch({ [field]: value }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400, `${field} must reject a non-text value`);
  }
}
assert.deepEqual(readCharacterProfilePatch({ name: " Name ", personality: " ", examples: "", userAddress: "", alias: " tag ", description: "" }), {
  data: { name: "Name", basePrompt: "", styleExamples: "", userAddress: "" }, modelConfig: { alias: "tag", description: "" },
});
assert.throws(() => readCharacterProfilePatch({ name: " " }));
assert.throws(() => readCharacterProfilePatch({ personality: "x".repeat(12001) }));
assert.deepEqual(readCharacterProfilePatch({ chatThinking: false, examples: undefined }), { data: {}, modelConfig: {} });

const defaults = readCharacterCreateInput({ name: " Test " });
assert.equal(defaults.name, "Test");
assert.equal(defaults.userAddress, "主人");
assert.equal(defaults.alias, "新建角色");
for (const userAddress of ["", "   "]) assert.equal(readCharacterCreateInput({ name: "Test", userAddress }).userAddress, "");
assert.equal(readCharacterCreateInput({ name: "Test", userAddress: " 朋友 " }).userAddress, "朋友");
for (const value of [null, undefined, [], 42, "x", {}]) assert.throws(() => readCharacterCreateInput(value));
assert.doesNotThrow(() => readCharacterCreateInput({ name: "x".repeat(100), userAddress: "x".repeat(40) }));
assert.throws(() => readCharacterCreateInput({ name: "x".repeat(101) }));
assert.throws(() => readCharacterCreateInput({ name: "Test", userAddress: "x".repeat(41) }));
assert.throws(() => readCharacterCreateInput({ name: "Test", examples: "x".repeat(8001) }));

const copied = characterCopyInput({ name: "x".repeat(100), alias: "tag", description: "desc", personality: "persona",
  examples: "sample", userAddress: "", avatarTone: "mint", ...{ chatApiKey: "secret", memories: ["private"] } });
assert.equal(copied.name.length, 100);
assert(copied.name.endsWith(" 副本"));
assert.equal(copied.examples, "sample");
assert.equal(copied.userAddress, "");
assert.deepEqual(Object.keys(copied).sort(), ["name", "alias", "description", "personality", "examples", "userAddress", "avatarTone"].sort());
assert.equal(readCharacterCreateInput(copied).userAddress, "");

const guard = createCharacterOperationGuard();
let release!: () => void;
let calls = 0;
const first = guard.run("a", async () => { calls++; await new Promise<void>((resolve) => { release = resolve; }); });
await guard.run("a", async () => { calls++; });
await guard.run("b", async () => { calls++; });
assert.equal(calls, 2);
assert(guard.isPending("a"));
release();
await first;
assert(!guard.isPending("a"));
await assert.rejects(guard.run("a", async () => { throw new Error("cancel or failure"); }));
await guard.run("a", async () => { calls++; });
assert.equal(calls, 3);
const list = [{ id: "a", name: "before" }];
replaceCharacter(list, { id: "a", name: "after" });
replaceCharacter(list, { id: "deleted", name: "late response" });
assert.deepEqual(list, [{ id: "a", name: "after" }]);

assert.deepEqual(characterInclude.memoryScopes.select._count.select.memoryItems.where, { status: "ACTIVE" });
assert.equal("memoryItems" in characterInclude.memoryScopes.select, false);
assert.deepEqual(characterInclude.channelBindings, { select: { connection: { select: { displayName: true } } } });
const base = { id: "a", name: "Test", avatar: null, basePrompt: "persona", styleExamples: "sample", userAddress: "",
  status: "ACTIVE", modelConfig: {}, updatedAt: new Date("2026-11-05T00:00:00Z"), memorySetting: null,
  channelBindings: [{ connection: { displayName: "QQ" } }], memoryScopes: [] };
assert.equal(toCharacterDto(base).memoryCount, 0);
const dto = toCharacterDto({ ...base, memoryScopes: [
  { _count: { memoryItems: 20000 }, snapshots: [] }, { _count: { memoryItems: 3 }, snapshots: [] },
] });
assert.equal(dto.memoryCount, 20003);
assert.deepEqual(dto.channels, ["QQ"]);
assert.equal(dto.userAddress, "");
assert.equal(dto.examples, "sample");
console.log("Character management regression passed: create defaults/empty address, safe full-profile copy, duplicate-operation guard, late PATCH safety, count-only projection and DTO compatibility (no DB/network).");
