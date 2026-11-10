import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

// Run the actual review handler with delayed responses, not a duplicate implementation.
const text = readFileSync(new URL("../app/components/SocialFriendsWorkspace.vue", import.meta.url), "utf8");
const source = ts.createSourceFile("friends.ts", text.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const handler = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "resolveSuggestion")!;
const compiled = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function harness() {
  const callbacks: Array<(value: unknown) => void> = [];
  const aliases: unknown[] = [];
  const context = {
    activeCharacterId: { value: "role-a" }, resolvingSuggestionId: { value: "" },
    suggestionResolveSequence: 0, suggestions: { value: [{ id: "one" }, { id: "two" }] },
    pendingSuggestions: { value: 2 },
    $fetch: () => new Promise(resolve => callbacks.push(resolve)),
    applyAliases: (scope: string, saved: string[]) => aliases.push({ scope, saved }),
    ElMessage: { error: () => assert.fail("unexpected review error") },
    readErrorMessage: () => "error",
  };
  const run = new Script(`${compiled}\nresolveSuggestion`).runInNewContext(context) as (suggestion: unknown, approve: boolean) => Promise<void>;
  return { context, callbacks, aliases, run };
}
const suggestion = { id: "one", scopeId: "scope-a", alias: "untrusted original" };
{
  const h = harness(); const pending = h.run(suggestion, true);
  h.callbacks[0]!({ aliases: ["server-normalized"] }); await pending;
  assert.deepEqual(h.aliases, [{ scope: "scope-a", saved: ["server-normalized"] }]);
  assert.equal(h.context.pendingSuggestions.value, 1);
}
{
  const h = harness(); const pending = h.run(suggestion, true);
  h.context.activeCharacterId.value = "role-b";
  h.context.suggestionResolveSequence++;
  h.context.resolvingSuggestionId.value = "another-review";
  h.callbacks[0]!({ aliases: ["old-role"] }); await pending;
  assert.equal(h.aliases.length, 0);
  assert.equal(h.context.pendingSuggestions.value, 2);
  assert.equal(h.context.resolvingSuggestionId.value, "another-review");
}
console.log("friend suggestion review: saved aliases and stale-role response guards passed");
