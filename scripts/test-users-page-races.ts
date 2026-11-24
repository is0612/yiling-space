import assert from "node:assert/strict";
import { createSystemApi } from "../app/api/system";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";

const usersPath = "/api/admin/users";
const auditPath = "/api/admin/audit";
function userPage(page: number, label = `user-${page}`) {
  return { items: [{ id: label }], page, pageSize: 20, total: page * 20, totalPages: page + 1, hasMore: true,
    stats: { total: page * 20, adminCount: page, disabledCount: page + 1 } };
}
function auditPage(page: number) {
  return { items: [{ id: `audit-${page}` }], page, total: page * 10, totalPages: page + 1 };
}
async function ready() {
  const page = buildPageHarness("../app/pages/users.vue", { globals: { createSystemApi } });
  page.take(usersPath).resolve(userPage(1));
  page.take(auditPath).resolve(auditPage(1));
  await flushMicrotasks();
  return page;
}
{
  const page = await ready();
  const first = page.call("loadUsers", 2); const stale = page.take(usersPath);
  const second = page.call("loadUsers", 3); const current = page.take(usersPath);
  assert.equal(stale.options?.query?.page, 2); assert.equal(current.options?.query?.pageSize, 20);
  current.resolve(userPage(3)); await second;
  stale.resolve(userPage(2)); await first;
  assert.equal(page.read<Array<{ id: string }>>("users")[0]!.id, "user-3");
  assert.equal(page.read("userPage"), 3); assert.equal(page.read("userTotal"), 60);
  assert.equal(page.read("userTotalPages"), 4); assert.equal(page.read<{ adminCount: number }>("stats").adminCount, 3);
  assert.equal(page.read("loading"), false); page.finish();
}
{
  const page = await ready();
  const first = page.call("loadUsers", 2); const stale = page.take(usersPath);
  const second = page.call("loadUsers", 3); const current = page.take(usersPath);
  stale.reject({ data: { message: "旧请求错误" } }); await first;
  assert.equal(page.read("loading"), true); assert.deepEqual(page.errors, []);
  current.resolve(userPage(3)); await second;
  page.finish();
}
{
  const page = await ready();
  const first = page.call("loadUsers", 2); const stale = page.take(usersPath);
  const second = page.call("loadUsers", 3); const current = page.take(usersPath);
  stale.resolve(userPage(2)); await first;
  assert.equal(page.read("userPage"), 1); assert.equal(page.read("loading"), true);
  current.reject({ data: { message: "当前请求失败" } }); await second;
  assert.equal(page.read("loading"), false); assert.deepEqual(page.errors, ["当前请求失败"]);
  const retry = page.call("loadUsers", 3); page.take(usersPath).resolve(userPage(3)); await retry;
  assert.equal(page.read("userPage"), 3); page.finish({ allowErrors: true });
}
{
  const page = await ready();
  const first = page.call("loadAudit", 2); const stale = page.take(auditPath);
  const second = page.call("loadAudit", 3); const current = page.take(auditPath);
  assert.equal(current.options?.query?.pageSize, 10);
  current.resolve(auditPage(3)); await second; stale.resolve(auditPage(2)); await first;
  assert.equal(page.read<Array<{ id: string }>>("auditItems")[0]!.id, "audit-3");
  assert.equal(page.read("auditPage"), 3); assert.equal(page.read("auditTotal"), 30); assert.equal(page.read("auditTotalPages"), 4);
  page.finish();
}
{
  const page = await ready();
  const audit = page.call("loadAudit", 2); const stale = page.take(auditPath);
  const users = page.call("loadUsers", 2); const currentUsers = page.take(usersPath);
  const latest = page.call("loadAudit", 3); const currentAudit = page.take(auditPath);
  stale.reject(new Error("old audit failure")); await audit;
  currentAudit.resolve(auditPage(3)); await latest;
  assert.equal(page.read("loading"), true, "audit completion cannot close user loading");
  currentUsers.resolve(userPage(2)); await users;
  assert.equal(page.read("userPage"), 2); assert.equal(page.read("auditPage"), 3); page.finish();
}
{
  const page = await ready();
  const old = page.call("loadUsers", 2); const stale = page.take(usersPath);
  const fresh = page.call("loadUsers", 3); page.take(usersPath).resolve(userPage(3)); await fresh;
  stale.reject({ data: { message: "过期失败" } }); await old;
  const audit = page.call("loadAudit", 2); page.take(auditPath).reject(new Error("audit unavailable")); await audit;
  assert.equal(page.read("userPage"), 3); assert.equal(page.read("auditPage"), 1); page.finish();
}
{
  const page = await ready();
  const users = page.call("loadUsers", 2); const userRequest = page.take(usersPath);
  const audit = page.call("loadAudit", 2); const auditRequest = page.take(auditPath);
  page.unmount();
  userRequest.reject({ data: { message: "卸载后的错误" } });
  auditRequest.resolve(auditPage(2));
  await Promise.all([users, audit]);
  assert.equal(page.read("userPage"), 1); assert.equal(page.read("auditPage"), 1);
  page.finish();
}
console.log("Users page: 7 reverse-response, stale error/loading, pagination/stats, independent lists, retry and unmount scenarios passed (script-level, no DOM).");
