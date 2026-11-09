import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPageHarness, flushMicrotasks } from "./lib/page-harness";
import { parseKnowledgeMergeInput, parseKnowledgeRelationDecision } from "../server/utils/knowledge-item-governance";

/**
 * 知识系统「重复知识合并与冲突治理」页面交互层专项测试。
 *
 * 覆盖范围说明（重要）：
 * 本项目没有浏览器自动化能力（无 Playwright / jsdom / Cypress），现有页面测试都是
 * 「抽出 SFC 的 <script>，在 node:vm 里跑，用替身替换 Nuxt 自动导入」的脚本级 harness。
 * 因此本文件验证的是页面脚本逻辑、请求契约和模板绑定，**不是真实 DOM 渲染与点击**。
 * 模板断言用静态文本匹配完成，只能证明「按钮绑定了哪个函数、带了哪些实参」，
 * 不能证明布局、可见性、焦点与真实浏览器事件。
 */

const PAGE = "../app/pages/growth/knowledge/index.vue";

type MergeItem = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
  revision: number;
  status: string;
  sourceType: string;
  sourceRef: unknown;
};

type RelationView = {
  id: string;
  sourceItemId: string;
  targetItemId: string;
  relationType: string;
  status: string;
  resolution: string | null;
  relatedItem: MergeItem;
};

function item(overrides: Partial<MergeItem> & { id: string }): MergeItem {
  return {
    title: overrides.id,
    content: `${overrides.id} 的正文`,
    category: "SCIENCE",
    tags: [],
    confidence: 0.8,
    revision: 1,
    status: "ACTIVE",
    sourceType: "MANUAL",
    sourceRef: null,
    ...overrides,
  };
}

function relation(overrides: Partial<RelationView> & { id: string; relatedItem: MergeItem }): RelationView {
  return {
    sourceItemId: "item-a",
    targetItemId: overrides.relatedItem.id,
    relationType: "DUPLICATE",
    status: "OPEN",
    resolution: null,
    ...overrides,
  };
}

function workspaceWith(items: Array<Record<string, unknown>>) {
  return { candidates: [], items, candidateCount: 0, itemCount: items.length };
}

/**
 * vm 里创建的对象/数组与宿主 realm 不同源，deepStrictEqual 会因原型不同而失败，
 * 这里统一走一次 JSON 结构化克隆后再比较，避免用「看起来一样」掩盖真实差异。
 */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 1. 关联状态文案：六种处置状态都要有对应中文，不能落到默认值。 */
async function relationStatusLabels() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const cases: Array<[Partial<RelationView>, string]> = [
    [{ status: "OPEN", resolution: null }, "待处理"],
    [{ status: "RESOLVED", resolution: "MERGED" }, "已合并"],
    [{ status: "DISMISSED", resolution: "SOURCE_MERGED" }, "源知识已合并"],
    [{ status: "OPEN", resolution: "NEEDS_VERIFICATION" }, "待核实"],
    [{ status: "RESOLVED", resolution: "CONFIRM_CONFLICT" }, "已处理"],
    [{ status: "DISMISSED", resolution: "DISMISS" }, "已忽略"],
  ];
  for (const [partial, expected] of cases) {
    const label = await page.call<string>("relationStatusLabel", {
      id: "rel", sourceItemId: "item-a", targetItemId: "item-b",
      relationType: "DUPLICATE", relatedItem: item({ id: "item-b" }), ...partial,
    } as RelationView);
    assert.equal(label, expected, `状态 ${JSON.stringify(partial)} 应显示为「${expected}」`);
  }
  page.finish();
}

/** 2. 双向合并入口：两个按钮的实参顺序相反，草稿的 source/target 必须跟着换。 */
async function mergeEntryPointsBothDirections() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const current = item({ id: "current", revision: 3, title: "当前条目", content: "当前正文", tags: ["甲"], confidence: 0.6 });
  const related = item({ id: "related", revision: 7, title: "关联条目", content: "关联正文", tags: ["乙"], confidence: 0.9 });

  // 按钮 A：将当前条目合并到关联知识 → startMerge(item, relation.relatedItem)
  await page.call("startMerge", current, related);
  const forward = page.read<{ sourceItemId: string; targetItemId: string; expectedSourceRevision: number; expectedTargetRevision: number; title: string; content: string }>("mergeDraft");
  assert.equal(forward.sourceItemId, "current", "当前条目应作为源");
  assert.equal(forward.targetItemId, "related", "关联条目应作为目标");
  assert.equal(forward.expectedSourceRevision, 3);
  assert.equal(forward.expectedTargetRevision, 7);
  assert.equal(forward.title, "关联条目", "合并后的默认标题取目标条目");
  assert.equal(forward.content, "关联正文");

  // 按钮 B：将关联条目合并到当前知识 → startMerge(relation.relatedItem, item)
  await page.call("startMerge", related, current);
  const backward = page.read<{ sourceItemId: string; targetItemId: string; expectedSourceRevision: number; expectedTargetRevision: number; title: string; content: string }>("mergeDraft");
  assert.equal(backward.sourceItemId, "related", "关联条目应作为源");
  assert.equal(backward.targetItemId, "current", "当前条目应作为目标");
  assert.equal(backward.expectedSourceRevision, 7);
  assert.equal(backward.expectedTargetRevision, 3);
  assert.equal(backward.title, "当前条目");
  page.finish();
}

/** 3. 合并对照框：双方标题/正文/分类/可信度/标签/来源/版本都要进草稿，缺一项对照框就会空白。 */
async function mergePreviewCarriesBothSides() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const source = item({
    id: "src", revision: 5, title: "源标题", content: "源正文", category: "HISTORY",
    tags: ["源标签"], confidence: 0.42, sourceType: "CHAT", sourceRef: { messageIds: ["m-1"] },
  });
  const target = item({
    id: "tgt", revision: 2, title: "目标标题", content: "目标正文", category: "SCIENCE",
    tags: ["目标标签", "补充"], confidence: null, sourceType: "MANUAL", sourceRef: { note: "人工整理" },
  });
  await page.call("startMerge", source, target);
  const draft = page.read<Record<string, unknown>>("mergeDraft");

  assert.equal(draft.sourceTitle, "源标题");
  assert.equal(draft.sourceContent, "源正文");
  assert.equal(draft.sourceCategory, "HISTORY");
  assert.equal(draft.sourceConfidence, 0.42);
  assert.deepEqual(plain(draft.sourceTags), ["源标签"]);
  assert.equal(draft.sourceType, "CHAT");
  assert.deepEqual(plain(draft.sourceRef), { messageIds: ["m-1"] });

  assert.equal(draft.targetTitle, "目标标题");
  assert.equal(draft.targetContent, "目标正文");
  assert.equal(draft.targetCategory, "SCIENCE");
  assert.equal(draft.targetConfidence, null);
  assert.deepEqual(plain(draft.targetTags), ["目标标签", "补充"]);
  assert.equal(draft.targetSourceType, "MANUAL");
  assert.deepEqual(plain(draft.targetSourceRef), { note: "人工整理" });

  assert.equal(draft.tagsText, "目标标签, 补充", "标签输入框由目标对象预填");
  assert.equal(draft.confidence, "", "可信度为 null 时输入框留空，不能塞 0");
  page.finish();
}

/** 4. 合并提交字段必须与 API 契约逐字段一致，且不多带任何字段。 */
async function mergeSubmitMatchesApiContract() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const source = item({ id: "src", revision: 4 });
  const target = item({ id: "tgt", revision: 6 });
  await page.call("startMerge", source, target);

  // 用户改写最终内容：只通过草稿的可编辑字段，不重建整个对象。
  const draft = page.read<Record<string, unknown>>("mergeDraft");
  page.set("mergeDraft", {
    ...draft,
    title: "用户确认的标题",
    content: "用户确认的正文",
    category: "CULTURE",
    tagsText: "甲，乙, 丙",
    confidence: "0.33",
  });

  const pending = page.call("submitMerge");
  const post = page.take("/api/characters/char-a/growth/knowledge/items/src/merge", "POST");
  const body = post.options?.body as Record<string, unknown>;

  // 键集合必须正好是 parseKnowledgeMergeInput 的允许集合：多一个字段 API 会 400。
  assert.deepEqual(
    Object.keys(body).sort(),
    ["category", "confidence", "content", "expectedSourceRevision", "expectedTargetRevision", "tags", "targetItemId", "title"],
    "合并请求体字段必须与 API 白名单完全一致",
  );
  assert.equal(body.targetItemId, "tgt");
  assert.equal(body.expectedSourceRevision, 4);
  assert.equal(body.expectedTargetRevision, 6);
  assert.equal(body.title, "用户确认的标题");
  assert.equal(body.content, "用户确认的正文");
  assert.equal(body.category, "CULTURE");
  assert.deepEqual(plain(body.tags), ["甲", "乙", "丙"], "中文逗号与英文逗号都要能拆分");
  assert.equal(body.confidence, 0.33, "可信度必须以数字提交");

  // 直接把请求体交给服务端真实的入参解析函数，证明它确实能被 API 接受，
  // 而不是只对着测试里手抄的字段表自说自话。
  const accepted = parseKnowledgeMergeInput(plain(body));
  assert.deepEqual(accepted, {
    targetItemId: "tgt", expectedSourceRevision: 4, expectedTargetRevision: 6,
    title: "用户确认的标题", content: "用户确认的正文", category: "CULTURE",
    tags: ["甲", "乙", "丙"], confidence: 0.33,
  });
  assert.throws(
    () => parseKnowledgeMergeInput({ ...plain(body), extra: 1 }),
    /不允许修改的字段/,
    "多带字段必须被 API 拒绝，字段白名单断言才有意义",
  );

  post.resolve({ source: { status: "MERGED" }, target: { revision: 7 } });
  await flushMicrotasks();
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await pending;
  page.finish();
}

/** 5. 可信度留空时提交 null，而不是 0 或空字符串。 */
async function mergeSubmitAllowsEmptyConfidence() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  await page.call("startMerge", item({ id: "src", confidence: 0.9 }), item({ id: "tgt", confidence: null }));
  const pending = page.call("submitMerge");
  const post = page.take("/api/characters/char-a/growth/knowledge/items/src/merge", "POST");
  assert.equal((post.options?.body as Record<string, unknown>).confidence, null);
  post.resolve({});
  await flushMicrotasks();
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await pending;
  page.finish();
}

/** 6. 可信度非法时不得发请求，只提示错误。 */
async function mergeSubmitRejectsInvalidConfidence() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  await page.call("startMerge", item({ id: "src" }), item({ id: "tgt" }));
  page.set("mergeDraft", { ...page.read<Record<string, unknown>>("mergeDraft"), confidence: "1.4" });
  await page.call("submitMerge");

  assert.equal(page.requests.length, 0, "非法可信度不应发出任何请求");
  assert.deepEqual(page.errors, ["可信度必须是 0 到 1 之间的数字，留空表示未标注。"]);
  assert.notEqual(page.read("mergeDraft"), null, "校验失败时草稿要保留，方便用户修改");
  page.finish({ allowErrors: true });
}

/** 7. 冲突三操作各自带对 action，并按 item 在关系中的真实方向取双方 revision。 */
async function conflictActionsCarryDirectionalRevisions() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const itemA = item({ id: "item-a", revision: 2 });
  const itemB = item({ id: "item-b", revision: 9 });
  // 当前条目是 source
  const asSource: RelationView = {
    id: "rel-1", sourceItemId: "item-a", targetItemId: "item-b",
    relationType: "CONFLICT", status: "OPEN", resolution: null, relatedItem: itemB,
  };
  // 当前条目是 target（页面同一张卡片可能渲染反方向）
  const asTarget: RelationView = {
    id: "rel-2", sourceItemId: "item-b", targetItemId: "item-a",
    relationType: "CONFLICT", status: "OPEN", resolution: null, relatedItem: itemB,
  };

  const actions = ["CONFIRM_CONFLICT", "NEEDS_VERIFICATION", "DISMISS"] as const;
  for (const action of actions) {
    const pending = page.call("resolveRelation", itemA, asSource, action);
    const post = page.take("/api/characters/char-a/growth/knowledge/relations/rel-1/resolve", "POST");
    assert.deepEqual(plain(post.options?.body), {
      action, expectedSourceRevision: 2, expectedTargetRevision: 9,
    }, `${action} 的请求体不正确（当前条目为 source）`);
    assert.deepEqual(parseKnowledgeRelationDecision(plain(post.options?.body)), {
      action, expectedSourceRevision: 2, expectedTargetRevision: 9,
    }, `${action} 的请求体必须能被服务端处置解析器接受`);
    post.resolve({});
    await flushMicrotasks();
    page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
    await pending;
  }

  const pendingTarget = page.call("resolveRelation", itemA, asTarget, "NEEDS_VERIFICATION");
  const postTarget = page.take("/api/characters/char-a/growth/knowledge/relations/rel-2/resolve", "POST");
  assert.deepEqual(plain(postTarget.options?.body), {
    action: "NEEDS_VERIFICATION", expectedSourceRevision: 9, expectedTargetRevision: 2,
  }, "当前条目为 target 时，双方 revision 必须对调");
  postTarget.resolve({});
  await flushMicrotasks();
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await pendingTarget;

  assert.deepEqual(page.successes, [
    "已确认冲突，双方知识均予以保留。",
    "已标记待核实。",
    "已忽略这条关联建议。",
    "已标记待核实。",
  ]);
  page.finish();
}

/** 8. 已处置的关系不再重复提交，避免重复点击打两次接口。 */
async function resolvedRelationIsNotResubmitted() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const closed: RelationView = {
    id: "rel-closed", sourceItemId: "item-a", targetItemId: "item-b",
    relationType: "CONFLICT", status: "RESOLVED", resolution: "CONFIRM_CONFLICT", relatedItem: item({ id: "item-b" }),
  };
  await page.call("resolveRelation", item({ id: "item-a" }), closed, "DISMISS");
  assert.equal(page.requests.length, 0, "已处置关系不应再发请求");
  page.finish();
}

/** 9. 切换角色时必须清空合并草稿、合并中标记和处置中标记。 */
async function roleSwitchClearsGovernanceState() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  await page.call("startMerge", item({ id: "src" }), item({ id: "tgt" }));
  page.set("mergingKnowledge", true);
  page.set("resolvingRelationIds", ["rel-1"]);
  page.set("busyIds", ["src", "tgt"]);
  assert.notEqual(page.read("mergeDraft"), null);

  page.switchRole("char-b");
  assert.equal(page.read("mergeDraft"), null, "切角色必须关闭合并对照框");
  assert.equal(page.read("mergingKnowledge"), false, "切角色必须复位合并中标记");
  assert.deepEqual(plain(page.read("resolvingRelationIds")), [], "切角色必须清空处置中列表");
  assert.deepEqual(plain(page.read("busyIds")), [], "切角色必须清空忙状态");
  page.take("/api/characters/char-b/growth/knowledge").resolve(workspaceWith([]));
  page.finish();
}

/** 10. 合并请求在途中切角色：旧响应回来不得提示成功，也不得影响新角色。 */
async function inFlightMergeIsDiscardedOnRoleSwitch() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  await page.call("startMerge", item({ id: "src" }), item({ id: "tgt" }));
  const pending = page.call("submitMerge");
  const post = page.take("/api/characters/char-a/growth/knowledge/items/src/merge", "POST");

  page.switchRole("char-b");
  page.take("/api/characters/char-b/growth/knowledge").resolve(workspaceWith([]));

  post.resolve({});
  await pending;
  await flushMicrotasks();

  assert.deepEqual(page.successes, [], "旧角色的合并成功提示不能出现在新角色下");
  assert.equal(page.read("mergeDraft"), null);
  assert.equal(page.read("mergingKnowledge"), false);
  assert.equal(page.requests.length, 0, "不得因旧角色合并成功而触发新角色的 reload");
  page.finish();
}

/** 11. revision 冲突（409）：提示服务端原因、关闭草稿并刷新，让用户重新对照。 */
async function mergeConflictResetsDraft() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  await page.call("startMerge", item({ id: "src" }), item({ id: "tgt" }));
  const pending = page.call("submitMerge");
  const post = page.take("/api/characters/char-a/growth/knowledge/items/src/merge", "POST");
  post.reject({ data: { statusCode: 409, statusMessage: "知识内容已发生变化，请刷新双方内容后重新确认合并。" } });
  await flushMicrotasks();

  const refresh = page.take("/api/characters/char-a/growth/knowledge");
  refresh.resolve(workspaceWith([]));
  await pending;

  assert.deepEqual(page.errors, ["知识内容已发生变化，请刷新双方内容后重新确认合并。"]);
  assert.equal(page.read("mergeDraft"), null, "409 后草稿必须关闭，避免用户对着过期内容反复提交");
  assert.equal(page.read("mergingKnowledge"), false);
  assert.deepEqual(plain(page.read("busyIds")), [], "409 后 busy 标记必须清理");
  page.finish({ allowErrors: true });
}

/** 12. 普通失败（非 409）：保留草稿让用户重试，不能把输入清掉。 */
async function mergeFailureKeepsDraft() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  await page.call("startMerge", item({ id: "src" }), item({ id: "tgt" }));
  page.set("mergeDraft", { ...page.read<Record<string, unknown>>("mergeDraft"), title: "用户改过的标题" });
  const pending = page.call("submitMerge");
  const post = page.take("/api/characters/char-a/growth/knowledge/items/src/merge", "POST");
  post.reject({ data: { statusCode: 500, statusMessage: "合并知识失败，请稍后再试。" } });
  await pending;

  assert.deepEqual(page.errors, ["合并知识失败，请稍后再试。"]);
  const draft = page.read<{ title: string } | null>("mergeDraft");
  assert.ok(draft, "非 409 失败应保留草稿");
  assert.equal(draft!.title, "用户改过的标题", "用户已输入的内容不能被清掉");
  assert.equal(page.read("mergingKnowledge"), false);
  assert.equal(page.requests.length, 0, "非 409 失败不应自动刷新");
  page.finish({ allowErrors: true });
}

/** 13. 关系处置失败：提示服务端原因并刷新，同时复位处置中状态。 */
async function relationDecisionFailureRefreshes() {
  const page = buildPageHarness(PAGE);
  page.take("/api/characters/char-a/growth/knowledge").resolve(workspaceWith([]));
  await flushMicrotasks();

  const rel: RelationView = {
    id: "rel-1", sourceItemId: "item-a", targetItemId: "item-b",
    relationType: "CONFLICT", status: "OPEN", resolution: null, relatedItem: item({ id: "item-b" }),
  };
  const pending = page.call("resolveRelation", item({ id: "item-a" }), rel, "CONFIRM_CONFLICT");
  const post = page.take("/api/characters/char-a/growth/knowledge/relations/rel-1/resolve", "POST");
  post.reject({ data: { statusMessage: "关联知识已发生变化，请刷新后重新判断。" } });
  await flushMicrotasks();

  const refresh = page.take("/api/characters/char-a/growth/knowledge");
  refresh.resolve(workspaceWith([]));
  await pending;

  assert.deepEqual(page.errors, ["关联知识已发生变化，请刷新后重新判断。"]);
  assert.deepEqual(plain(page.read("resolvingRelationIds")), []);
  page.finish({ allowErrors: true });
}

/** 14. 模板绑定：按钮只挂在 OPEN 的关系上，且实参顺序决定合并方向。 */
function templateBindings() {
  // PAGE 相对 scripts/，这里以 scripts/ 为基准解析。
  const sfc = readFileSync(new URL(PAGE, new URL("./", import.meta.url)), "utf8");
  // 组件模板里还有嵌套 <template v-if>，不能取第一个 </template>，否则切片会提前结束。
  const scriptEnd = sfc.lastIndexOf("</script>");
  const template = sfc.slice(sfc.indexOf("<template", scriptEnd), sfc.lastIndexOf("</template>"));

  assert.ok(
    template.includes('@click="startMerge(item, relation.relatedItem)"'),
    "重复关系必须有「当前条目合并到关联知识」入口",
  );
  assert.ok(
    template.includes('@click="startMerge(relation.relatedItem, item)"'),
    "重复关系必须有「关联条目合并到当前知识」入口",
  );

  // 两个入口必须都限定在 OPEN + DUPLICATE，否则已处置或冲突关系上会出现合并按钮。
  const duplicateStart = template.indexOf("relation.status === 'OPEN' && relation.relationType === 'DUPLICATE'");
  const conflictStart = template.indexOf("relation.status === 'OPEN' && relation.relationType === 'CONFLICT'");
  assert.ok(duplicateStart >= 0 && conflictStart > duplicateStart, "模板中应存在重复与冲突两个独立区块");
  const duplicateBlock = template.slice(duplicateStart, conflictStart);
  assert.ok(duplicateBlock.includes("startMerge(item, relation.relatedItem)"), "合并入口必须在 DUPLICATE + OPEN 区块内");
  assert.ok(duplicateBlock.includes("startMerge(relation.relatedItem, item)"), "反向合并入口也必须在同一区块内");

  const conflictEnd = template.indexOf('<div class="item-actions">', conflictStart);
  assert.ok(conflictEnd > conflictStart, "冲突区块之后应有条目操作区");
  const conflictBlock = template.slice(conflictStart, conflictEnd);
  for (const action of ["CONFIRM_CONFLICT", "NEEDS_VERIFICATION", "DISMISS"]) {
    assert.ok(conflictBlock.includes(`resolveRelation(item, relation, '${action}')`), `冲突区块缺少 ${action} 操作`);
  }

  // 合并提交按钮在标题/正文/分类为空时必须禁用。
  assert.ok(
    /:disabled="mergingKnowledge \|\| !mergeDraft\.title\.trim\(\) \|\| !mergeDraft\.content\.trim\(\) \|\| !mergeDraft\.category\.trim\(\)"/.test(template),
    "合并提交按钮的禁用条件必须覆盖标题/正文/分类",
  );
  console.log("  ✅ 模板绑定：双向合并入口、三冲突操作、提交禁用条件");
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [
    ["关联状态文案覆盖六种处置状态", relationStatusLabels],
    ["双向合并入口的 source/target 随实参调换", mergeEntryPointsBothDirections],
    ["合并对照框携带双方内容、来源与版本", mergePreviewCarriesBothSides],
    ["合并提交字段与 API 白名单逐字段一致", mergeSubmitMatchesApiContract],
    ["可信度留空提交 null", mergeSubmitAllowsEmptyConfidence],
    ["非法可信度不发请求且保留草稿", mergeSubmitRejectsInvalidConfidence],
    ["冲突三操作携带方向化 revision", conflictActionsCarryDirectionalRevisions],
    ["已处置关系不重复提交", resolvedRelationIsNotResubmitted],
    ["切角色清空草稿与在途状态", roleSwitchClearsGovernanceState],
    ["在途合并在切角色后作废", inFlightMergeIsDiscardedOnRoleSwitch],
    ["409 关闭草稿并刷新", mergeConflictResetsDraft],
    ["非 409 失败保留用户草稿", mergeFailureKeepsDraft],
    ["关系处置失败提示并刷新", relationDecisionFailureRefreshes],
  ];
  for (const [name, test] of tests) {
    await test();
    console.log("  ✅", name);
  }
  templateBindings();
  console.log(`知识治理页面交互通过：${tests.length + 1} 项（脚本级 harness，非浏览器点击）。`);
}

await main();
