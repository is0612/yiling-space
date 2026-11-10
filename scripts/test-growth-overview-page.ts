import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";
const path = "../app/pages/growth/index.vue";
const base = (id = "char-a") => `/api/characters/${id}/growth/overview`;
function result(id = "char-a", title = "当前结论") {
  return { character: { id, name: "测试角色" }, period: { days: 7, start: "2026-11-04T00:00:00Z", end: "2026-11-10T00:00:00Z" }, generatedAt: "2026-11-10T00:00:00Z",
    stats: { memories: 4, knowledge: 1, relationships: 0, conclusions: 1 }, pending: { reflections: 1, knowledge: 2, relationships: 0 },
    conclusions: [{ id: title, title, observation: "观察", inference: "推断", recommendation: "建议", acceptedAt: "2026-11-10T00:00:00Z", sourceRefs: [{ title: "<script>unsafe</script>", excerpt: "真实摘录" }] }], timeline: [], delivery: { failed: 0, stuck: 0, ready: 2 } };
}
async function setup() { const page = buildPageHarness(path); page.take(base()).resolve(result()); await flushMicrotasks(); return page; }
{
  const page = buildPageHarness(path);
  const oldA = page.take(base()); page.switchRole("char-b"); const b = page.take(base("char-b")); page.switchRole("char-a"); const newA = page.take(base());
  oldA.resolve(result("char-a", "旧A")); b.reject(new Error("旧B错误")); await flushMicrotasks();
  assert.equal(page.read("overview"), null); assert.equal(page.read("loading"), true); assert.equal(page.read("loadError"), "");
  newA.resolve(result("char-a", "新A")); await flushMicrotasks(); assert.equal(page.read<ReturnType<typeof result>>("overview").conclusions[0]!.title, "新A"); page.finish();
}
{
  const page = await setup();
  page.call("openSources", result().conclusions[0]); assert.equal(page.read("sourceOpen"), true);
  page.call("changeRange", 14); const first = page.take(base()); assert.equal(first.options?.query?.days, 14);
  assert.equal(page.read("overview"), null); assert.equal(page.read("sourceOpen"), false);
  page.call("changeRange", 30); const last = page.take(base()); assert.equal(last.options?.query?.days, 30);
  last.resolve(result("char-a", "30天")); await flushMicrotasks(); first.resolve(result("char-a", "14天旧响应")); await flushMicrotasks();
  assert.equal(page.read<ReturnType<typeof result>>("overview").conclusions[0]!.title, "30天"); page.finish();
}
{
  const page = await setup(); const pending = page.call("loadOverview"); page.take(base()).reject({ statusCode: 500 }); await pending;
  assert.equal(page.read("overview"), null); assert.match(page.read<string>("loadError"), /失败/); assert.equal(page.read("pendingTotal"), null); assert.equal(page.read("loading"), false);
  const retry = page.call("loadOverview"); page.take(base()).resolve(result()); await retry; assert.equal(page.read("loadError"), ""); page.finish();
}
{
  const page = await setup(); page.call("openSources", result().conclusions[0]);
  const sources = await page.call<Array<{ title: string; excerpt: string }>>("sourceRows", result().conclusions[0]!.sourceRefs);
  assert.equal(sources[0]!.title, "<script>unsafe</script>");
  page.switchRole("char-b"); assert.equal(page.read("sourceOpen"), false); assert.equal(page.read("selectedConclusion"), null);
  page.take(base("char-b")).resolve(result("char-b")); await flushMicrotasks();
  assert.equal(await page.call("roleHref", "/growth/knowledge"), "/growth/knowledge?c=char-b");
  assert.equal(await page.call("roleHref", "https://external.example/evil"), "/growth/reflection?c=char-b");
  page.switchRole("role &/?"); page.take(base("role%20%26%2F%3F")).resolve(result("role &/?")); await flushMicrotasks();
  assert.equal(await page.call("roleHref", "/growth/social/assessments"), "/growth/social/assessments?c=role%20%26%2F%3F"); page.finish();
}
{
  const page = buildPageHarness(path); const late = page.take(base()); page.unmount(); late.resolve(result()); await flushMicrotasks(); assert.equal(page.read("overview"), null); page.finish();
}
const template = readFileSync(new URL(path, import.meta.url), "utf8");
assert(!template.includes("v-html")); assert(!template.includes("sidebar")); assert(!template.includes("小灵"));
assert(template.includes("source.excerpt")); assert(template.includes("尚不自动影响聊天行为"));
assert(template.includes("overview.delivery.failed || overview.delivery.stuck")); assert(!template.includes("后台投递无异常"));
for (const kind of ["reflections", "knowledge", "relationships"]) assert(template.includes(`v-if="overview.pending.${kind} > 0"`));
assert(!/font-size:\s*(?:[0-9]|1[01])px/.test(template));
console.log("Growth overview page: role ABA, range latest-wins, failed-load clearing, source dialog safety, role-aware navigation and unmount regressions passed.");
