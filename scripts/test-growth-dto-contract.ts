/**
 * 成长域响应契约回归。
 *
 * 守的不是「字段值算得对不对」（那是 goals/preferences/expression-habits 各自的事），
 * 而是「发出去的形状是否还等于 shared/types/growth.ts 里声明的那一份」：
 *
 * 1. 契约里要求的字段必须全部存在，不能被整形时漏掉；
 * 2. 日期必须是 ISO 字符串（不是 Date 对象、不是本地时间格式）；
 * 3. 枚举字段的取值必须落在契约允许的集合里；
 * 4. 历史条目**不能**退化成「主对象 + action」—— 修订行没有 characterId / updatedAt /
 *    progressCount，早先那样写会让页面读到 undefined。
 *
 * 这里用真实 Prisma 行的形状造数据（`character_goal_revisions` 等表有什么字段就造什么），
 * 不用精简对象 —— 否则测的是 mock，不是接口。
 */
import assert from "node:assert/strict";
import type {
  CharacterExpressionHabit,
  CharacterExpressionHabitRevision,
  CharacterGoal,
  CharacterGoalRevision,
  CharacterPreference,
  CharacterPreferenceRevision,
} from "../src/generated/prisma/client";
import { publicGoal, toGoalHistoryDto } from "../server/utils/goals";
import { toPreferenceDto, toPreferenceHistoryDto } from "../server/utils/preferences";
import { toLanguageHabitDto, toLanguageHistoryDto } from "../server/utils/expression-habits";
import { EXPRESSION_CHAT_SCOPES, GOAL_KINDS, GOAL_STATUSES, LANGUAGE_KINDS, LANGUAGE_STATUSES, PREFERENCE_KINDS, PREFERENCE_STATUSES } from "../shared/types/growth";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const at = new Date("2026-11-22T00:00:00.000Z");
const sourceRef = { type: "MEMORY_EVENT", id: "11111111-1111-4111-8111-111111111111", hash: "a".repeat(64), title: "来源标题", summary: "来源摘要" };

function assertIso(value: unknown, label: string) {
  assert.equal(typeof value, "string", `${label} 必须是字符串（JSON 传输后就是 ISO）`);
  assert.match(value as string, ISO, `${label} 必须是 ISO 8601 UTC 字符串`);
}

function assertFields(value: Record<string, unknown>, fields: readonly string[], label: string) {
  for (const field of fields) {
    assert.ok(field in value, `${label} 缺少契约字段 ${field}`);
    assert.notEqual(value[field], undefined, `${label}.${field} 不能是 undefined`);
  }
}

function assertEnum(value: unknown, allowed: readonly string[], label: string) {
  assert.ok(allowed.includes(value as string), `${label} 的取值 ${String(value)} 不在契约枚举内`);
}

// ---------- Goal ----------
const goalRow = {
  id: "22222222-2222-4222-8222-222222222222",
  characterId: "33333333-3333-4333-8333-333333333333",
  kind: "GOAL",
  title: "认识星座",
  description: "先认识三个常见星座",
  reason: "她持续提起",
  status: "ACTIVE",
  revision: 3,
  sourceType: "SOURCES",
  sourceRefs: [sourceRef],
  createdAt: at,
  updatedAt: at,
  _count: { progress: 2 },
  progress: [{
    id: "44444444-4444-4444-8444-444444444444",
    goalId: "22222222-2222-4222-8222-222222222222",
    requestKey: "55555555-5555-4555-8555-555555555555",
    content: "认出了北斗七星",
    sourceRefs: [sourceRef],
    createdAt: at,
  }],
} as unknown as CharacterGoal & { _count: { progress: number }; progress: Array<{ id: string; goalId: string; requestKey: string; content: string; sourceRefs: unknown; createdAt: Date }> };

const goal = publicGoal(goalRow);
assertFields(goal as unknown as Record<string, unknown>,
  ["id", "characterId", "kind", "title", "description", "reason", "status", "revision", "sourceType", "sourceRefs", "createdAt", "updatedAt", "progressCount", "latestProgress"],
  "Goal");
assertIso(goal.createdAt, "Goal.createdAt");
assertIso(goal.updatedAt, "Goal.updatedAt");
assertEnum(goal.kind, GOAL_KINDS, "Goal.kind");
assertEnum(goal.status, GOAL_STATUSES, "Goal.status");
assert.equal(goal.progressCount, 2, "progressCount 取 _count.progress");
assert.ok(goal.latestProgress, "latestProgress 应带上最近一条进展");
assertIso(goal.latestProgress!.createdAt, "Goal.latestProgress.createdAt");

// ---------- GoalHistory（修订行，不是 Goal） ----------
const goalRevisionRow = {
  id: "66666666-6666-4666-8666-666666666666",
  goalId: goalRow.id,
  revision: 3,
  action: "COMPLETE",
  kind: "GOAL",
  title: goalRow.title,
  description: goalRow.description,
  reason: goalRow.reason,
  status: "COMPLETED",
  sourceType: "SOURCES",
  sourceRefs: [sourceRef],
  actorId: "77777777-7777-4777-8777-777777777777",
  createdAt: at,
} as unknown as CharacterGoalRevision;

const goalHistory = toGoalHistoryDto(goalRevisionRow);
assertFields(goalHistory as unknown as Record<string, unknown>,
  ["id", "goalId", "revision", "action", "kind", "title", "description", "reason", "status", "sourceType", "sourceRefs", "actorId", "createdAt"],
  "GoalHistory");
assertIso(goalHistory.createdAt, "GoalHistory.createdAt");
// 修订行没有这些：写进契约就等于承诺了一个永远 undefined 的字段。
for (const absent of ["characterId", "updatedAt", "progressCount", "latestProgress"]) {
  assert.ok(!(absent in (goalHistory as unknown as Record<string, unknown>)), `GoalHistory 不应带 ${absent}（修订表没有这一列）`);
}

// ---------- Preference ----------
const preferenceRow = {
  id: "88888888-8888-4888-8888-888888888888",
  characterId: goalRow.characterId,
  kind: "LIKE",
  topic: "星座",
  reason: "她主动提起",
  status: "ACTIVE",
  revision: 1,
  sourceType: "SOURCES",
  sourceRefs: [sourceRef],
  createdAt: at,
  updatedAt: at,
} as unknown as CharacterPreference;

const preference = toPreferenceDto(preferenceRow);
assertFields(preference as unknown as Record<string, unknown>,
  ["id", "characterId", "kind", "topic", "reason", "status", "revision", "sourceType", "sourceRefs", "createdAt", "updatedAt"],
  "Preference");
assertIso(preference.createdAt, "Preference.createdAt");
assertEnum(preference.kind, PREFERENCE_KINDS, "Preference.kind");
assertEnum(preference.status, PREFERENCE_STATUSES, "Preference.status");

const preferenceHistoryRow = {
  id: "99999999-9999-4999-8999-999999999999",
  preferenceId: preferenceRow.id,
  revision: 1,
  action: "CREATE",
  kind: "LIKE",
  topic: preferenceRow.topic,
  reason: preferenceRow.reason,
  status: "PENDING",
  sourceType: "SOURCES",
  sourceRefs: [sourceRef],
  actorId: goalRevisionRow.actorId,
  createdAt: at,
} as unknown as CharacterPreferenceRevision;

const preferenceHistory = toPreferenceHistoryDto(preferenceHistoryRow);
assertFields(preferenceHistory as unknown as Record<string, unknown>,
  ["id", "preferenceId", "revision", "action", "kind", "topic", "reason", "status", "sourceType", "sourceRefs", "actorId", "createdAt"],
  "PreferenceHistory");
assertIso(preferenceHistory.createdAt, "PreferenceHistory.createdAt");
for (const absent of ["characterId", "updatedAt"]) {
  assert.ok(!(absent in (preferenceHistory as unknown as Record<string, unknown>)), `PreferenceHistory 不应带 ${absent}`);
}

// ---------- LanguageHabit（来源按 sourceType 分支） ----------
const habitRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  characterId: goalRow.characterId,
  kind: "WORDING",
  chatScope: "GROUP",
  content: "避免机械反问",
  context: "日常交流",
  reason: "群观察",
  status: "PENDING",
  reviewedBy: null,
  reviewedAt: null,
  revision: 1,
  sourceType: "GROUP_OBSERVATION",
  conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  memoryScopeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  sourceRefs: [{ type: "GROUP_OBSERVATION", selection: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", openingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", responseId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", outcomeId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, hash: "b".repeat(64) }],
  createdAt: at,
  updatedAt: at,
} as unknown as CharacterExpressionHabit;

const habit = toLanguageHabitDto(habitRow);
assertFields(habit as unknown as Record<string, unknown>,
  ["id", "characterId", "kind", "content", "context", "reason", "status", "revision", "sourceType", "sourceRefs", "createdAt", "updatedAt"],
  "LanguageHabit");
assertIso(habit.createdAt, "LanguageHabit.createdAt");
assertIso(habit.updatedAt, "LanguageHabit.updatedAt");
assertEnum(habit.kind, LANGUAGE_KINDS, "LanguageHabit.kind");
assertEnum(habit.status, LANGUAGE_STATUSES, "LanguageHabit.status");
assertEnum(habit.chatScope ?? "ALL", EXPRESSION_CHAT_SCOPES, "LanguageHabit.chatScope");
// 群观察来源没有 title/id：契约里它是独立分支，不该被当成 GrowthSource 访问。
const groupRef = habit.sourceRefs[0]!;
assert.equal(groupRef.type, "GROUP_OBSERVATION");
assert.ok(!("title" in groupRef), "GROUP_OBSERVATION 来源不应有 title（旧契约统一成 GrowthSource 是错的）");

// 四种来源各造一条，确认识别成对应的分支形状
const sources = [
  { type: "MEMORY_EVENT", id: sourceRef.id, hash: sourceRef.hash, title: "标题", summary: "摘要" },
  { type: "GROUP_OBSERVATION", selection: { conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", openingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", responseId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", outcomeId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }, hash: "c".repeat(64) },
  { key: `experience:${sourceRef.id}`, type: "experience", id: sourceRef.id, hash: "d".repeat(64), conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", memoryScopeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  { version: 1, type: "experience", key: `experience:${sourceRef.id}`, id: sourceRef.id, hash: "e".repeat(64), conversationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", memoryScopeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", feedbackMessageId: "12341234-1234-4123-8123-123412341234", educationMode: "explicit", proposer: { kind: "owner", platform: "desktop", identity: "owner" } },
];
const fourSourceHabit = toLanguageHabitDto({ ...habitRow, sourceRefs: sources } as unknown as CharacterExpressionHabit);
assert.equal(fourSourceHabit.sourceRefs.length, 4, "四种来源都应原样带出（整形不做裁剪）");

// ---------- LanguageHistory（修订行） ----------
const habitRevisionRow = {
  id: "12121212-1212-4212-8212-121212121212",
  habitId: habitRow.id,
  revision: 1,
  action: "CREATE",
  kind: "WORDING",
  content: habitRow.content,
  context: habitRow.context,
  chatScope: "ALL",
  reason: habitRow.reason,
  status: "PENDING",
  sourceType: "GROUP_OBSERVATION",
  sourceRefs: habitRow.sourceRefs,
  conversationId: habitRow.conversationId,
  memoryScopeId: habitRow.memoryScopeId,
  actorId: goalRevisionRow.actorId,
  createdAt: at,
} as unknown as CharacterExpressionHabitRevision;

const habitHistory = toLanguageHistoryDto(habitRevisionRow);
assertFields(habitHistory as unknown as Record<string, unknown>,
  ["id", "habitId", "revision", "action", "kind", "content", "context", "reason", "status", "sourceType", "sourceRefs", "actorId", "createdAt"],
  "LanguageHistory");
assertIso(habitHistory.createdAt, "LanguageHistory.createdAt");
assertEnum(habitHistory.chatScope ?? "ALL", EXPRESSION_CHAT_SCOPES, "LanguageHistory.chatScope");
for (const absent of ["characterId", "updatedAt", "reviewedBy", "reviewedAt"]) {
  assert.ok(!(absent in (habitHistory as unknown as Record<string, unknown>)), `LanguageHistory 不应带 ${absent}（修订表没有这一列）`);
}

console.log("Growth DTO contract: Goal / GoalHistory / Preference / PreferenceHistory / LanguageHabit / LanguageHistory 的字段集、ISO 日期、枚举取值与来源联合分支都与 shared/types/growth.ts 一致。");
