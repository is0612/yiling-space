import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";
import { focusableElements, resolveTabFocus } from "../app/utils/focus-trap";

/**
 * 知识生命周期「页面与交互」专项测试（脚本级 harness）。
 *
 * 覆盖范围说明：本项目没有浏览器自动化（无 Playwright / jsdom），页面测试沿用
 * `scripts/lib/page-harness.ts` 的方式——抽出 SFC 的 `<script>`，在 node:vm 里执行，
 * 用替身替换 Nuxt 自动导入，模板断言用静态文本匹配。
 *
 * 因此这里验证的是页面脚本逻辑、请求契约和模板绑定，**不是真实 DOM 渲染**。
 * 键盘交互部分：焦点落点计算用 app/utils/focus-trap.ts 里的纯函数 + 假 DOM 真实驱动，
 * 弹窗组件的 DOM 行为（真正调用 focus、body 滚动锁定）只能靠静态断言 + 浏览器人工验收。
 */

const PAGE = "../app/pages/growth/knowledge/index.vue";
const DIALOG = "../app/components/AccessibleDialog.vue";
const BASE = "/api/characters/char-a/growth/knowledge";

type Entry = {
  id: string; title: string; content: string; category: string; tags: string[];
  confidence: number | null; status: string; sourceType: string; sourceRef: unknown;
  revision: number; createdAt: string; updatedAt: string; canPermanentlyDelete?: boolean;
};

function entry(id: string, status = "ACTIVE", extra: Partial<Entry> = {}): Entry {
  return {
    id,
    title: `标题 ${id}`,
    content: `正文 ${id}`,
    category: "GENERAL",
    tags: ["标签"],
    confidence: 0.8,
    status,
    sourceType: "MANUAL",
    sourceRef: null,
    revision: 1,
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:00:00.000Z",
    ...extra,
  };
}

function libraryEntry(id: string, status = "ACTIVE", revision = 1) {
  return { ...entry(id, status, { revision }), relations: [] };
}

function candidate(id: string, status: string) {
  return {
    id,
    sourceType: "MANUAL",
    sourceRef: null,
    rawContent: `候选原文 ${id}`,
    status,
    processedResult: null,
    processingError: null,
    processedAt: null,
    createdAt: "2026-11-09T10:00:00.000Z",
    relatedItems: [],
  };
}

function workspace(items: unknown[], candidates: unknown[] = []) {
  return { candidates, items, candidateCount: 0, itemCount: items.length };
}

/** vm 沙箱里的对象原型与宿主不同，结构化克隆后再比较。 */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Page = ReturnType<typeof buildPageHarness>;

async function bootstrap(page: Page, items: unknown[] = [], candidates: unknown[] = []) {
  page.take(BASE).resolve(workspace(items, candidates));
  await flushMicrotasks();
}

async function openArchiveTab(page: Page, items: unknown[]) {
  page.call("selectTab", "archive");
  const archive = page.takeMatching(
    request => (request.options?.query as Record<string, unknown> | undefined)?.itemStatus === "ARCHIVED",
    "归档列表",
  );
  const workspaceRequest = page.take(BASE);
  archive.resolve({ items, itemPagination: { page: 1, pageSize: 30, total: items.length, pageCount: 1 } });
  workspaceRequest.resolve(workspace([]));
  await flushMicrotasks();
  return archive;
}

async function openTrashTab(page: Page, items: unknown[]) {
  page.call("selectTab", "trash");
  const trash = page.take(`${BASE}/trash`);
  const workspaceRequest = page.take(BASE);
  trash.resolve({ characterId: "char-a", items, itemCount: items.length, pagination: { page: 1, pageSize: 30, total: items.length, pageCount: 1 } });
  workspaceRequest.resolve(workspace([]));
  await flushMicrotasks();
  return trash;
}

/** 一次操作成功后一定伴随一次工作区刷新，这里统一把它消化掉。 */
async function settleRefresh(page: Page, tab: "library" | "archive" | "trash") {
  const workspaceRequest = page.take(BASE);
  workspaceRequest.resolve(workspace([]));
  if (tab === "archive") {
    const archive = page.takeMatching(
      request => (request.options?.query as Record<string, unknown> | undefined)?.itemStatus === "ARCHIVED",
      "归档列表刷新",
    );
    archive.resolve({ items: [], itemPagination: { page: 1, pageSize: 30, total: 0, pageCount: 1 } });
  }
  if (tab === "trash") {
    page.take(`${BASE}/trash`).resolve({ characterId: "char-a", items: [], itemCount: 0, pagination: { page: 1, pageSize: 30, total: 0, pageCount: 1 } });
  }
  await flushMicrotasks();
}

// ---------------------------------------------------------------------------
// 1. 三个分区各自只展示对应状态
// ---------------------------------------------------------------------------
async function tabsShowOnlyTheirOwnStatus() {
  const page = buildPageHarness(PAGE);
  // 故意让知识库接口同时返回 ACTIVE 与 ARCHIVED，页面也只应渲染 ACTIVE。
  await bootstrap(page, [libraryEntry("active-1"), libraryEntry("archived-1", "ARCHIVED")]);
  assert.deepEqual(plain<string[]>(page.read<Entry[]>("libraryItems").map(item => item.status)), ["ACTIVE"]);
  assert.equal(page.read("activeTab"), "library");

  const archiveRequest = await openArchiveTab(page, [entry("archived-2", "ARCHIVED"), entry("active-2", "ACTIVE")]);
  assert.ok(archiveRequest.url.endsWith(BASE), "归档列表复用工作区路径 + itemStatus 过滤");
  assert.deepEqual(plain<string[]>(page.read<Entry[]>("archivedItems").map(item => item.status)), ["ARCHIVED"]);

  const trashRequest = await openTrashTab(page, [entry("trashed-1", "TRASHED"), entry("active-3", "ACTIVE")]);
  assert.equal(trashRequest.url, `${BASE}/trash`, "回收站必须走独立接口");
  assert.deepEqual(plain<string[]>(page.read<Entry[]>("trashItems").map(item => item.status)), ["TRASHED"]);

  // 没打开过的分区计数是「未知」，不能假装是 0。
  const tabs = plain<Array<{ key: string; known: boolean }>>(page.read("knowledgeTabs"));
  assert.deepEqual(tabs.map(tab => [tab.key, tab.known]), [["library", true], ["archive", true], ["trash", true]]);
  page.finish();
}

// ---------------------------------------------------------------------------
// 2. 归档 / 取消归档 / 移入回收站 / 恢复：路径、请求体、反馈、刷新
// ---------------------------------------------------------------------------
async function archiveUsesRevisionAndRefreshes() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("item-1", "ACTIVE", 2)]);
  const item = page.read<Entry[]>("libraryItems")[0]!;

  page.call("requestArchive", item);
  const post = page.take(`${BASE}/items/item-1/archive`, "POST");
  assert.deepEqual(plain(post.options?.body), { expectedRevision: 2 }, "归档必须带读取时的版本号");
  post.resolve({ item: { id: "item-1", status: "ARCHIVED", revision: 3 }, message: "知识已归档，不再参与检索。" });
  await flushMicrotasks();
  await settleRefresh(page, "library");
  assert.ok(page.successes.includes("知识已归档，不再参与检索。"), "成功反馈优先用服务端文案");
  assert.equal(page.read("loading"), false);
  page.finish();
}

async function trashRequiresConfirmationAndUsesPurgeRevisions() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("item-1", "ACTIVE", 4)]);
  const item = page.read<Entry[]>("libraryItems")[0]!;

  page.call("requestTrash", item);
  assert.equal(page.requests.length, 0, "确认前不得发请求");
  const dialog = page.read<{ kind: string; danger: boolean }>("confirmDialog");
  assert.equal(dialog.kind, "TRASH");
  assert.equal(dialog.danger, false, "移入回收站可恢复，不按危险操作呈现");

  const confirming = page.call("confirmAction");
  const post = page.take(`${BASE}/items/item-1/trash`, "POST");
  assert.deepEqual(plain(post.options?.body), { expectedRevision: 4 });
  post.resolve({ item: { id: "item-1", status: "TRASHED", revision: 5 }, message: "知识已移入回收站，不再参与检索。" });
  await flushMicrotasks();
  await settleRefresh(page, "library");
  await confirming;
  assert.equal(page.read("confirmDialog"), null, "成功后关闭确认框");
  assert.ok(page.successes.includes("知识已移入回收站，不再参与检索。"));
  page.finish();
}

async function archiveRestoreAndTrashRestoreUseTheirOwnEndpoints() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page);
  await openArchiveTab(page, [entry("archived-1", "ARCHIVED", { revision: 3 })]);

  page.call("requestUnarchive", page.read<Entry[]>("archivedItems")[0]!);
  const unarchive = page.take(`${BASE}/items/archived-1/unarchive`, "POST");
  assert.deepEqual(plain(unarchive.options?.body), { expectedRevision: 3 });
  unarchive.resolve({ item: { id: "archived-1", status: "ACTIVE", revision: 4 }, message: "知识已取消归档，恢复参与检索。" });
  await flushMicrotasks();
  await settleRefresh(page, "archive");
  assert.ok(page.successes.includes("知识已取消归档，恢复参与检索。"));

  await openTrashTab(page, [entry("trashed-1", "TRASHED", { revision: 6 })]);
  page.call("requestRestore", page.read<Entry[]>("trashItems")[0]!);
  const restore = page.take(`${BASE}/items/trashed-1/restore`, "POST");
  assert.deepEqual(plain(restore.options?.body), { expectedRevision: 6 });
  restore.resolve({ item: { id: "trashed-1", status: "ACTIVE", revision: 7 }, message: "知识已从回收站恢复。" });
  await flushMicrotasks();
  await settleRefresh(page, "trash");
  assert.ok(page.successes.includes("知识已从回收站恢复。"));
  page.finish();
}

// ---------------------------------------------------------------------------
// 3. 归档知识移入回收站：后端只允许 ACTIVE → TRASHED，页面按两步执行并说明
// ---------------------------------------------------------------------------
async function archivedTrashRunsTwoStepsWithFreshRevision() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page);
  await openArchiveTab(page, [entry("archived-1", "ARCHIVED", { revision: 5 })]);

  page.call("requestArchivedTrash", page.read<Entry[]>("archivedItems")[0]!);
  const dialog = page.read<{ kind: string; detail: string }>("confirmDialog");
  assert.equal(dialog.kind, "ARCHIVED_TRASH");
  assert.match(dialog.detail, /取消归档/, "确认框必须说明会先取消归档");
  assert.match(dialog.detail, /两步/, "确认框必须说明这是两步操作");

  const confirming = page.call("confirmAction");
  const unarchive = page.take(`${BASE}/items/archived-1/unarchive`, "POST");
  assert.deepEqual(plain(unarchive.options?.body), { expectedRevision: 5 });
  unarchive.resolve({ item: { id: "archived-1", status: "ACTIVE", revision: 6 } });
  await flushMicrotasks();

  const trash = page.take(`${BASE}/items/archived-1/trash`, "POST");
  assert.deepEqual(plain(trash.options?.body), { expectedRevision: 6 }, "第二步必须用第一步返回的新版本号");
  trash.resolve({ item: { id: "archived-1", status: "TRASHED", revision: 7 } });
  await flushMicrotasks();
  await settleRefresh(page, "archive");
  await confirming;
  assert.ok(page.successes.some(message => message.includes("移入回收站")));
  page.finish();
}

async function archivedTrashReportsPartialFailure() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page);
  await openArchiveTab(page, [entry("archived-1", "ARCHIVED", { revision: 5 })]);

  page.call("requestArchivedTrash", page.read<Entry[]>("archivedItems")[0]!);
  const confirming = page.call("confirmAction");
  page.take(`${BASE}/items/archived-1/unarchive`, "POST").resolve({ item: { revision: 6 } });
  await flushMicrotasks();
  page.take(`${BASE}/items/archived-1/trash`, "POST").reject({ data: { statusCode: 500, statusMessage: "数据库暂时不可用。" } });
  await flushMicrotasks();
  await settleRefresh(page, "archive");
  await confirming;

  const message = page.errors.find(text => text.includes("移入回收站失败"));
  assert.ok(message, "第二步失败必须提示");
  assert.match(message!, /已取消归档/, "必须告知用户知识已经回到知识库，而不是还在归档区");
  assert.notEqual(page.read("confirmDialog"), null, "非 409 失败保留确认框让用户重试");
  page.finish({ allowErrors: true });
}

// ---------------------------------------------------------------------------
// 4. 永久删除：二次确认 + 合并审计链禁止条件
// ---------------------------------------------------------------------------
async function purgeRequiresExplicitConfirmation() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page);
  await openTrashTab(page, [entry("trashed-1", "TRASHED", { revision: 8, canPermanentlyDelete: true })]);

  page.call("requestPurge", page.read<Entry[]>("trashItems")[0]!);
  assert.equal(page.requests.length, 0, "点击后先弹确认框，不发请求");
  const dialog = page.read<{ kind: string; danger: boolean; detail: string }>("confirmDialog");
  assert.equal(dialog.kind, "PURGE");
  assert.equal(dialog.danger, true);
  assert.match(dialog.detail, /不可恢复/, "必须明确告知永久删除不可恢复");

  const confirming = page.call("confirmAction");
  const request = page.take(`${BASE}/items/trashed-1`, "DELETE");
  const body = plain<Record<string, unknown>>(request.options?.body);
  assert.deepEqual(body, { expectedRevision: 8, confirm: "PERMANENT_DELETE" }, "必须带后端要求的二次确认口令");
  request.resolve({ ok: true, message: "知识已永久删除。" });
  await flushMicrotasks();
  await settleRefresh(page, "trash");
  await confirming;
  assert.ok(page.successes.includes("知识已永久删除。"));
  page.finish();
}

async function mergedKnowledgeCannotBePurgedFromPage() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page);
  await openTrashTab(page, [entry("merged-1", "TRASHED", { canPermanentlyDelete: false })]);

  page.call("requestPurge", page.read<Entry[]>("trashItems")[0]!);
  assert.equal(page.read("confirmDialog"), null, "参与合并审计链的知识不得进入永久删除确认");
  assert.ok(page.errors.some(text => text.includes("合并审计链")), "必须说明为什么不能删");
  assert.equal(page.requests.length, 0, "不得发出删除请求");

  // 页面禁用只是展示层判断；后端仍会重新检查，这里断言页面没有把 canPermanentlyDelete 当成唯一闸门。
  const sfc = readFileSync(new URL(PAGE, new URL("./", import.meta.url)), "utf8");
  assert.ok(
    sfc.includes('confirm: PURGE_CONFIRMATION'),
    "永久删除请求必须显式带确认口令，而不是只靠前端标记",
  );
  page.finish({ allowErrors: true });
}

// ---------------------------------------------------------------------------
// 5. 候选清理：单条删除不动正式知识；已忽略候选可多选批量删除
// ---------------------------------------------------------------------------
async function deleteCandidateKeepsAcceptedKnowledge() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [], [candidate("c-accepted", "ACCEPTED")]);

  page.call("requestDeleteCandidate", page.read<{ candidates: Array<{ id: string; status: string }> }>("data").candidates[0]);
  const dialog = page.read<{ kind: string; message: string; danger: boolean }>("confirmDialog");
  assert.equal(dialog.kind, "CANDIDATE_DELETE");
  assert.match(dialog.message, /不会删除已入库的正式知识/, "删除 ACCEPTED 候选前必须说明知识会保留");
  assert.equal(dialog.danger, true);

  const confirming = page.call("confirmAction");
  const request = page.take(`${BASE}/candidates/c-accepted`, "DELETE");
  request.resolve({ ok: true, candidateId: "c-accepted", deletedStatus: "ACCEPTED", knowledgeItemId: "item-9", knowledgeItemRetained: true });
  await flushMicrotasks();
  await settleRefresh(page, "library");
  await confirming;
  assert.ok(page.successes.includes("候选已删除，已入库的正式知识保留。"));
  page.finish();
}

async function batchDeleteOnlyDismissedCandidates() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [], [candidate("d-1", "DISMISSED"), candidate("d-2", "DISMISSED"), candidate("p-1", "PENDING")]);
  const candidates = page.read<Array<{ id: string; status: string }>>("data").candidates;
  const [dismissed1, dismissed2, pending] = candidates;

  page.call("toggleCandidateSelection", dismissed1);
  page.call("toggleCandidateSelection", dismissed2);
  page.call("toggleCandidateSelection", pending);
  assert.deepEqual(plain<string[]>(page.read("selectedCandidateIds")), ["d-1", "d-2"], "待处理候选不能被选中");

  page.call("requestBatchDeleteCandidates");
  const dialog = page.read<{ kind: string; message: string; candidateIds: string[] }>("confirmDialog");
  assert.equal(dialog.kind, "CANDIDATE_BATCH_DELETE");
  assert.match(dialog.message, /2 条/, "批量操作前必须显示数量");
  assert.deepEqual(plain<string[]>(dialog.candidateIds), ["d-1", "d-2"]);

  const confirming = page.call("confirmAction");
  page.take(`${BASE}/candidates/d-1`, "DELETE").resolve({ ok: true, knowledgeItemRetained: false });
  await flushMicrotasks();
  page.take(`${BASE}/candidates/d-2`, "DELETE").resolve({ ok: true, knowledgeItemRetained: false });
  await flushMicrotasks();
  await settleRefresh(page, "library");
  await confirming;
  assert.ok(page.successes.includes("已删除 2 条已忽略候选。"));
  assert.deepEqual(plain<string[]>(page.read("selectedCandidateIds")), [], "删除后清空选择");
  page.finish();
}

async function pendingCandidatesAreNeverBatchDeleted() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [], [candidate("p-1", "PENDING"), candidate("p-2", "PROCESSING")]);

  // 即使选择集合被外部塞进待处理 ID，批量删除也必须一条都不发。
  page.set("selectedCandidateIds", ["p-1", "p-2"]);
  page.call("requestBatchDeleteCandidates");
  assert.equal(page.read("confirmDialog"), null, "没有可删除的已忽略候选时不弹确认框");
  assert.ok(page.warnings.some(text => text.includes("请先选择要删除的已忽略候选")), "必须提示选择集里没有可清理项");

  page.set("selectedCandidateIds", ["p-1"]);
  const confirming = page.call("confirmAction");
  await confirming;
  assert.equal(page.requests.length, 0, "待处理候选不得被删除");
  page.finish();
}

// ---------------------------------------------------------------------------
// 6. revision 冲突（409）：提示 + 刷新 + 关闭过期确认框
// ---------------------------------------------------------------------------
async function revisionConflictReportsAndRefreshes() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("item-1", "ACTIVE", 1)]);
  page.call("requestTrash", page.read<Entry[]>("libraryItems")[0]!);
  const confirming = page.call("confirmAction");

  page.take(`${BASE}/items/item-1/trash`, "POST").reject({
    data: { statusCode: 409, statusMessage: "这条知识已被其他操作修改，请刷新后再试。" },
  });
  await flushMicrotasks();
  await settleRefresh(page, "library");
  await confirming;

  assert.ok(page.errors.includes("这条知识已被其他操作修改，请刷新后再试。"), "必须把服务端冲突原因告诉用户");
  assert.equal(page.read("confirmDialog"), null, "409 后关闭确认框，避免用户对着过期数据重试");
  page.finish({ allowErrors: true });
}

async function operationFailureKeepsDialogForRetry() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("item-1", "ACTIVE", 1)]);
  page.call("requestTrash", page.read<Entry[]>("libraryItems")[0]!);
  const confirming = page.call("confirmAction");

  page.take(`${BASE}/items/item-1/trash`, "POST").reject({ data: { statusCode: 500, statusMessage: "服务器开小差了。" } });
  await flushMicrotasks();
  await settleRefresh(page, "library");
  await confirming;

  assert.ok(page.errors.includes("服务器开小差了。"));
  assert.notEqual(page.read("confirmDialog"), null, "非 409 失败保留确认框");
  assert.equal(page.read("actionBusy"), false, "失败后必须复位提交中状态");
  page.finish({ allowErrors: true });
}

// ---------------------------------------------------------------------------
// 7. 角色切换竞态：旧角色数据/提示/刷新都不能落到新角色
// ---------------------------------------------------------------------------
async function archiveAndTrashSearchPagination() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("active-1")]);
  page.set("keyword", "星云");
  page.call("selectTab", "archive");
  const archiveFirst = page.takeMatching(
    request => (request.options?.query as Record<string, unknown> | undefined)?.itemStatus === "ARCHIVED",
    "归档搜索第一页",
  );
  const workspaceFirst = page.take(BASE);
  assert.equal(archiveFirst.options?.query?.q, "星云");
  assert.equal(archiveFirst.options?.query?.page, 1);
  archiveFirst.resolve({ items: [entry("archive-1", "ARCHIVED")], itemPagination: { page: 1, pageSize: 30, total: 31, pageCount: 2 } });
  workspaceFirst.resolve(workspace([]));
  await flushMicrotasks();

  page.call("changeArchivePage", 2);
  const archiveSecond = page.takeMatching(
    request => (request.options?.query as Record<string, unknown> | undefined)?.itemStatus === "ARCHIVED",
    "归档搜索第二页",
  );
  const workspaceSecond = page.take(BASE);
  assert.equal(archiveSecond.options?.query?.q, "星云");
  assert.equal(archiveSecond.options?.query?.page, 2);
  archiveSecond.resolve({ items: [entry("archive-31", "ARCHIVED")], itemPagination: { page: 2, pageSize: 30, total: 31, pageCount: 2 } });
  workspaceSecond.resolve(workspace([]));
  await flushMicrotasks();
  assert.equal(page.read("archivePage"), 2);
  assert.equal(page.read("archiveTotalCount"), 31);

  page.call("selectTab", "trash");
  const trashFirst = page.take(`${BASE}/trash`);
  const workspaceTrash = page.take(BASE);
  assert.equal(trashFirst.options?.query?.q, "星云");
  assert.equal(trashFirst.options?.query?.page, 1);
  trashFirst.resolve({ characterId: "char-a", items: [entry("trash-1", "TRASHED")], itemCount: 31, pagination: { page: 1, pageSize: 30, total: 31, pageCount: 2 } });
  workspaceTrash.resolve(workspace([]));
  await flushMicrotasks();

  page.call("changeTrashPage", 2);
  const trashSecond = page.take(`${BASE}/trash`);
  const workspaceTrashSecond = page.take(BASE);
  assert.equal(trashSecond.options?.query?.q, "星云");
  assert.equal(trashSecond.options?.query?.page, 2);
  trashSecond.resolve({ characterId: "char-a", items: [entry("trash-31", "TRASHED")], itemCount: 31, pagination: { page: 2, pageSize: 30, total: 31, pageCount: 2 } });
  workspaceTrashSecond.resolve(workspace([]));
  await flushMicrotasks();
  assert.equal(page.read("trashPage"), 2);
  assert.equal(page.read("trashTotalCount"), 31);
  page.finish();
}

async function staleArchiveListDoesNotCrossRole() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("a-active")]);

  page.call("selectTab", "archive");
  const archiveA = page.takeMatching(
    request => (request.options?.query as Record<string, unknown> | undefined)?.itemStatus === "ARCHIVED",
    "A 的归档列表",
  );
  page.take(BASE).resolve(workspace([]));
  await flushMicrotasks();

  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b/growth/knowledge");
  archiveA.resolve({ items: [entry("a-archived", "ARCHIVED")], itemPagination: { page: 1, pageSize: 30, total: 1, pageCount: 1 } });
  await flushMicrotasks();
  assert.deepEqual(plain<unknown[]>(page.read("archivedItems")), [], "A 的归档数据不能出现在 B 的页面");
  assert.equal(page.read("activeTab"), "library", "切角色回到知识库分区");

  loadB.resolve(workspace([]));
  await flushMicrotasks();
  page.finish();
}

async function inFlightLifecycleDoesNotTouchNextRole() {
  const page = buildPageHarness(PAGE);
  await bootstrap(page, [libraryEntry("item-1")]);
  page.call("requestArchive", page.read<Entry[]>("libraryItems")[0]!);
  const post = page.take(`${BASE}/items/item-1/archive`, "POST");

  page.switchRole("char-b");
  const loadB = page.take("/api/characters/char-b/growth/knowledge");
  post.resolve({ item: { revision: 2 }, message: "知识已归档，不再参与检索。" });
  await flushMicrotasks();

  assert.equal(page.successes.length, 0, "旧角色的操作成功提示不能出现在新角色");
  assert.equal(page.requests.length, 0, "旧角色的响应不能额外触发新角色刷新");
  assert.deepEqual(plain<unknown[]>(page.read("libraryItems")), []);

  loadB.resolve(workspace([]));
  await flushMicrotasks();
  page.finish();
}

// ---------------------------------------------------------------------------
// 8. 加载失败与空列表
// ---------------------------------------------------------------------------
async function loadFailureAndEmptyStates() {
  const page = buildPageHarness(PAGE);
  page.take(BASE).reject({ data: { statusMessage: "读取知识系统失败，请检查登录状态。" } });
  await flushMicrotasks();
  assert.ok(page.errors.includes("读取知识系统失败，请检查登录状态。"));
  assert.equal(page.read("loading"), false, "失败后必须结束 loading");
  assert.deepEqual(plain<unknown[]>(page.read("libraryItems")), []);
  assert.deepEqual(plain<unknown[]>(page.read("archivedItems")), []);
  assert.deepEqual(plain<unknown[]>(page.read("trashItems")), []);

  // 重新加载成功、但一条数据都没有：三个分区计数都是 0，而不是残留旧值。
  const reload = page.call("load");
  page.take(BASE).resolve(workspace([]));
  await reload;
  const knowledgeTabs = plain<Array<{ key: string; count: number }>>(page.read("knowledgeTabs"));
  assert.deepEqual(knowledgeTabs.map(tab => tab.count), [0, 0, 0], "空列表时三个分区计数都是 0");
  page.finish({ allowErrors: true });
}

// ---------------------------------------------------------------------------
// 9. 键盘交互：焦点落点用假 DOM 真实驱动
// ---------------------------------------------------------------------------
function fakeNode(id: string, options: { hidden?: boolean } = {}) {
  const node = {
    id,
    focused: false,
    focus() { node.focused = true; },
    getClientRects: () => (options.hidden ? [] : [{}]),
  };
  return node;
}

function fakeRoot(nodes: Array<ReturnType<typeof fakeNode>>) {
  return {
    querySelectorAll: () => nodes,
    contains: (node: unknown) => nodes.includes(node as ReturnType<typeof fakeNode>),
  } as unknown as HTMLElement;
}

function readSfc(relativePath: string) {
  return readFileSync(new URL(relativePath, new URL("./", import.meta.url)), "utf8");
}

function templateOf(sfc: string) {
  const scriptEnd = sfc.lastIndexOf("</script>");
  return sfc.slice(sfc.indexOf("<template", scriptEnd), sfc.lastIndexOf("</template>"));
}

/** 10. 模板绑定：三个分区、操作入口、禁用条件、提示文案、弹窗可访问性标记。 */
function templateBindings() {
  const template = templateOf(readSfc(PAGE));

  for (const [handler, label] of [
    ["requestArchive(item)", "归档"],
    ["requestTrash(item)", "移入回收站"],
    ["requestUnarchive(item)", "恢复归档"],
    ["requestArchivedTrash(item)", "归档知识移入回收站"],
    ["requestRestore(item)", "回收站恢复"],
    ["requestPurge(item)", "永久删除"],
    ["requestDeleteCandidate(candidate)", "候选单条删除"],
    ["requestBatchDeleteCandidates", "候选批量删除"],
  ] as const) {
    assert.ok(template.includes(`@click="${handler}"`), `模板缺少「${label}」入口`);
  }

  assert.ok(
    template.includes('activeTab === \'library\'') && template.includes('activeTab === \'archive\'') && template.includes('activeTab === \'trash\''),
    "三个分区必须各自按 activeTab 渲染",
  );

  assert.ok(
    /:disabled="actionBusy \|\| item\.canPermanentlyDelete === false"/.test(template),
    "永久删除按钮必须在合并审计链条目上禁用",
  );
  assert.ok(
    template.includes("合并审计链"),
    "存在合并审计关系的知识必须显示不可永久删除的说明",
  );
  assert.ok(template.includes("@click=\"confirmAction\""), "确认框必须有提交入口");
  assert.ok(template.includes("data-autofocus"), "确认框打开后要指定初始焦点");

  for (const empty of ["暂时没有知识候选", "还没有正式知识", "还没有归档知识", "回收站是空的"]) {
    assert.ok(template.includes(empty), `缺少空态文案：${empty}`);
  }

  const dialogs = template.match(/<AccessibleDialog/g) ?? [];
  assert.equal(dialogs.length, 2, "合并确认框与操作确认框都必须走可访问弹窗组件");
  console.log("  ✅ 模板绑定：三分区、操作入口、禁用条件、空态与弹窗标记");
}

/** 11. 弹窗组件入口本身要带 role/aria/键盘处理与焦点归还。 */
function dialogComponentMarkup() {
  const sfc = readSfc(DIALOG);
  const template = templateOf(sfc);
  assert.ok(template.includes('role="dialog"'), "弹窗必须有 role=dialog");
  assert.ok(template.includes('aria-modal="true"'), "弹窗必须标记为模态");
  assert.ok(template.includes('tabindex="-1"'), "弹窗容器本身要能被程序聚焦");
  assert.ok(template.includes('@keydown="onKeydown"'), "弹窗必须处理键盘事件");
  assert.ok(sfc.includes('event.key === "Escape"'), "必须支持 Esc 关闭");
  assert.ok(sfc.includes("resolveTabFocus("), "Tab 焦点必须限制在弹窗内");
  assert.ok(sfc.includes("returnFocus?.focus()"), "关闭后必须把焦点还给触发元素");
  assert.ok(sfc.includes("document.body.style.overflow"), "打开期间要锁住背景滚动，避免焦点与滚动错位");
  console.log("  ✅ 弹窗组件：role/aria、Esc、Tab 循环、焦点归还");
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [
    ["三个分区只展示对应状态", tabsShowOnlyTheirOwnStatus],
    ["归档携带版本号并刷新", archiveUsesRevisionAndRefreshes],
    ["移入回收站需确认且携带版本号", trashRequiresConfirmationAndUsesPurgeRevisions],
    ["取消归档 / 回收站恢复走各自接口", archiveRestoreAndTrashRestoreUseTheirOwnEndpoints],
    ["归档知识移入回收站分两步并带新版本号", archivedTrashRunsTwoStepsWithFreshRevision],
    ["两步操作中途失败要说明知识现在在哪", archivedTrashReportsPartialFailure],
    ["永久删除二次确认与确认口令", purgeRequiresExplicitConfirmation],
    ["合并审计链知识不可永久删除", mergedKnowledgeCannotBePurgedFromPage],
    ["删除已入库候选不影响正式知识", deleteCandidateKeepsAcceptedKnowledge],
    ["已忽略候选多选批量删除", batchDeleteOnlyDismissedCandidates],
    ["待处理候选不会被批量清理", pendingCandidatesAreNeverBatchDeleted],
    ["409 冲突提示并刷新最新数据", revisionConflictReportsAndRefreshes],
    ["非 409 失败保留确认框可重试", operationFailureKeepsDialogForRetry],
    ["归档与回收站搜索和分页参数正确", archiveAndTrashSearchPagination],
    ["旧角色归档列表不跨角色", staleArchiveListDoesNotCrossRole],
    ["在途生命周期操作不污染新角色", inFlightLifecycleDoesNotTouchNextRole],
    ["加载失败与空列表状态", loadFailureAndEmptyStates],
    ["焦点落点计算（Tab 循环 / 收口 / 拉回）", keyboardFocusTrap],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log("  ✅", name);
  }
  templateBindings();
  dialogComponentMarkup();
  console.log(`知识生命周期页面交互通过：${tests.length + 2} 项（脚本级 harness + 纯函数焦点计算）。`);
}

/** 9. 键盘交互：焦点落点用假 DOM 真实驱动。 */
function keyboardFocusTrap() {
  const first = fakeNode("first");
  const middle = fakeNode("middle");
  const last = fakeNode("last");
  const hidden = fakeNode("hidden", { hidden: true });
  const root = fakeRoot([first, middle, last, hidden]);

  assert.deepEqual(
    focusableElements(root as unknown as { querySelectorAll: (selector: string) => ArrayLike<unknown> }).length,
    3,
    "不可见元素不参与 Tab 顺序",
  );

  const wrapForward = resolveTabFocus(root, last as unknown as Element, false);
  assert.equal(wrapForward.kind, "move");
  assert.equal((wrapForward as { target: { id: string } }).target.id, "first", "Tab 在最后一个元素上绕回第一个");

  const wrapBackward = resolveTabFocus(root, first as unknown as Element, true);
  assert.equal(wrapBackward.kind, "move");
  assert.equal((wrapBackward as { target: { id: string } }).target.id, "last", "Shift+Tab 在第一个元素上绕回最后一个");

  assert.equal(resolveTabFocus(root, middle as unknown as Element, false).kind, "native", "中间元素交给浏览器默认行为");

  const outside = fakeNode("outside");
  const outsideRoot = fakeRoot([first, middle, last]);
  const pullBack = resolveTabFocus(outsideRoot, outside as unknown as Element, false);
  assert.equal((pullBack as { target: { id: string } }).target.id, "first", "焦点在弹窗外时拉回弹窗内");

  const emptyRoot = fakeRoot([]);
  const fallback = resolveTabFocus(emptyRoot, null, false);
  assert.equal(fallback.kind, "move");
  assert.equal((fallback as { target: unknown }).target, emptyRoot, "没有可聚焦元素时焦点收到弹窗容器");
}

main().catch((error) => {
  console.error("知识生命周期页面交互验收失败。");
  console.error(error);
  process.exitCode = 1;
});

  const middle = fakeNode("middle");
  const last = fakeNode("last");
  const hidden = fakeNode("hidden", { hidden: true });
