import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { setImmediate as flush } from "node:timers/promises";
import ts from "typescript";

const sfc = readFileSync(new URL("../app/components/MemoryExtractionDialog.vue", import.meta.url), "utf8");
const source = ts.createSourceFile("dialog.ts", sfc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const script = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(source)).join("\n");
const compiled = ts.transpileModule(`(function () { ${script}\n return { preview, previewError, previewLoading, jobs, progressError, canStart, startExtraction, loadPreview, refresh, sessionCharacterId }; })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
type Request = { url: string; options?: { query: Record<string, string> }; resolve: (value: unknown) => void; reject: (error: Error) => void };
function harness() {
  const props = { modelValue: false, characterId: "role-a", characterName: "角色甲" };
  const requests: Request[] = [];
  const watchers: Array<() => void> = [];
  const timers = new Map<number, () => Promise<void>>();
  const actions: string[] = [];
  let timerId = 0;
  let dispose: () => void = () => {};
  const ref = (value: unknown) => ({ value });
  const page = new Script(compiled).runInContext(createContext({
    defineProps: () => props, defineEmits: () => () => {}, ref, Error,
    computed: (get: (() => unknown) | { get: () => unknown; set: (value: boolean) => void }) => ({ get value() { return typeof get === "function" ? get() : get.get(); } }),
    watch: (_source: unknown, callback: (value: unknown) => void, options: { immediate?: boolean }) => {
      const run = () => callback([props.modelValue, props.characterId]);
      watchers.push(run);
      if (options?.immediate) run();
    },
    onBeforeUnmount: (callback: () => void) => { dispose = callback; },
    useMemoryActions: (getId: () => string) => ({ eventExtracting: ref(false), runEventExtraction: async () => { actions.push(getId()); return true; } }),
    ensureMemoryProgressPolling: () => {},
    $fetch: (url: string, options?: Request["options"]) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
    setTimeout: (callback: () => Promise<void>) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  }));
  function change(value: Partial<typeof props>) { Object.assign(props, value); watchers.forEach(run => run()); }
  function take(part: string, role = props.characterId) {
    const index = requests.findIndex(request => request.url.includes(part) && (request.url.includes(role) || request.options?.query.characterId === role));
    assert(index >= 0, `missing ${part} for ${role}`);
    return requests.splice(index, 1)[0]!;
  }
  return { page, props, requests, actions, timers, change, take, dispose: () => dispose() };
}
const preview = (characterId: string, totalMessages = 1) => ({ characterId, characterName: characterId, timeZone: "Asia/Shanghai", checkedAt: "2026-11-09T00:00:00Z", totalMessages, rows: [], notice: null, truncated: false });
const progress = { jobs: [], checkedAt: "2026-11-09T00:00:00Z" };

const race = harness();
assert.equal(race.requests.length, 0, "closed dialog must not fetch or post");
race.change({ modelValue: true });
assert.equal(race.actions.length, 0, "opening must only preview, not start extraction");
const oldPreview = race.take("preview");
const oldProgress = race.take("memory-progress");
race.change({ characterId: "role-b", characterName: "角色乙" });
race.take("preview").resolve(preview("role-b", 2));
race.take("memory-progress").resolve(progress);
await flush();
oldPreview.resolve(preview("role-a", 99));
oldProgress.resolve({ ...progress, jobs: [{ characterId: "role-a", type: "EXTRACT_EVENTS" }] });
await flush();
assert.equal(race.page.preview.value.characterId, "role-b");
assert.equal(race.page.preview.value.totalMessages, 2);
assert.equal(race.page.jobs.value.length, 0);
assert.equal(race.timers.size, 1);
const starting = race.page.startExtraction();
assert.deepEqual(race.actions, ["role-b"], "start must use the captured visible role");
await flush();
const latePreview = race.take("preview");
const lateProgress = race.take("memory-progress");
race.change({ modelValue: false });
assert.equal(race.timers.size, 0, "closing clears local polling");
latePreview.resolve(preview("role-b", 88));
lateProgress.resolve(progress);
await starting;
assert.equal(race.page.preview.value, null, "closed session must reject late responses");
assert.equal(race.timers.size, 0, "late completion cannot restart polling");

const failed = harness();
failed.change({ modelValue: true });
failed.take("preview").reject(new Error("预览暂时失败"));
failed.take("memory-progress").reject(new Error("进度暂时失败"));
await flush();
assert.equal(failed.page.preview.value, null);
assert.match(failed.page.previewError.value, /预览暂时失败/);
assert.match(failed.page.progressError.value, /进度暂时失败/);
assert.equal(failed.page.canStart.value, false, "a failed preview is not an empty successful preview");
const retry = failed.page.loadPreview();
failed.take("preview").resolve(preview("role-a", 0));
await retry;
assert.equal(failed.page.canStart.value, false, "no pending messages or retryable jobs disables start");
failed.page.jobs.value = [{ characterId: "role-a", type: "EXTRACT_EVENTS", status: "RETRY_WAIT", leaseExpired: false }];
assert.equal(failed.page.canStart.value, false, "a historical retryable task cannot start an empty today/yesterday extraction");
failed.page.preview.value.hasLegacyOwnerChats = true;
assert.equal(failed.page.canStart.value, true, "legacy owner conversations permit the server to check and relocate before extraction");
failed.dispose();
assert.equal(failed.timers.size, 0, "unmount clears polling");
assert.match(sfc, /v-if="!jobs\.length && !progressError"/, "failed progress queries must not show successful empty state");
assert.match(sfc, /本次任务已结束，可在忆泡日历查看结果/);
console.log("Memory extraction dialog passed: preview-only open, role/session races, close/unmount polling cleanup, explicit failures, captured start, and empty/retryable states.");
