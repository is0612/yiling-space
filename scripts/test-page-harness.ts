import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";

const directory = mkdtempSync(join(tmpdir(), "yiling-page-harness-"));
let fixtureNumber = 0;
function fixture(script: string, options: Parameters<typeof buildPageHarness>[1] = {}) {
  const path = join(directory, `fixture-${++fixtureNumber}.vue`);
  writeFileSync(path, `<script setup lang="ts">\n${script}\n</script>`, "utf8");
  return buildPageHarness(pathToFileURL(path).href, options);
}
const roleSource = `const { character } = useCharacterSelection();
const characterId = computed(() => character.value.id);`;
try {
  const absent = fixture("const keyword = ref(''); watch(keyword, () => { throw new Error('wrong watcher fired'); });");
  assert.throws(() => absent.switchRole("char-b"), /missing role source binding/);
  absent.finish();
  const unwatched = fixture(`${roleSource}\nconst keyword = ref(''); watch(keyword, () => {});`);
  assert.throws(() => unwatched.switchRole("char-b"), /role watcher must be registered on: characterId/);
  unwatched.finish();
  for (const declaration of ["ref('char-a')", "computed(() => 'char-a')"]) {
    const unrelated = fixture(`const characterId = ${declaration}; watch(characterId, () => { throw new Error('unrelated watcher fired'); });`);
    assert.throws(() => unrelated.switchRole("char-b"), /role source must follow the selected role/);
    unrelated.finish();
  }
  const multiple = fixture(`${roleSource}\nconst calls = ref(0); watch(characterId, () => { calls.value++; }); watch(characterId, () => { calls.value++; });`);
  multiple.switchRole("char-b");
  assert.equal(multiple.read("calls"), 2);
  multiple.switchRole("char-b");
  assert.equal(multiple.read("calls"), 2, "unchanged role must not trigger watchers");
  multiple.finish();
  const missingExplicit = fixture(`${roleSource}\nwatch(characterId, () => {});`, { roleSources: ["characterId", "missing"] });
  assert.throws(() => missingExplicit.switchRole("char-b"), /missing role source binding: missing/);
  missingExplicit.finish();

  const page = fixture(`const client = useApiRequest();
async function raw() { try { await $fetch('/raw'); } catch {} }
async function domain() { try { await client({ url: '/domain', method: 'get' }); } catch {} }
raw(); domain();`);
  assert.throws(() => page.finish(), /unsettled requests: GET \/raw, GET \/api\/domain/);
  const raw = page.take("/raw");
  const domain = page.takeMatching(request => request.url === "/api/domain");
  assert.equal(page.requests.length, 0);
  assert.throws(() => page.finish(), /unsettled requests/, "taking a request must not settle it");
  raw.resolve({});
  assert.throws(() => page.finish(), /unsettled requests: GET \/api\/domain/);
  domain.reject(new Error("expected failure"));
  await flushMicrotasks();
  page.finish();
  console.log("Page harness: strict role sources, all matching watchers, no fallback, raw/domain request settlement and take-without-settle rejection passed.");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
