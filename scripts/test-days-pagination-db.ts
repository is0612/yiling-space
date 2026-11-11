import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, createRouter, toNodeListener } from "h3";

/**
 * 忆泡日历分页的隔离数据库回归。
 *
 * 直接跑真实的 API handler（不是把查询逻辑抄一遍），所以分页、页码修正、
 * 按天聚合、角色隔离这些行为都是从 HTTP 响应上断言的。
 * 只能通过 `test:days-pagination-isolated` 进入 —— 那里会先建一个一次性库。
 */
const database = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
assert(/^yiling_days_test_[a-f0-9]{32}$/.test(database), "Run through test:days-pagination-isolated only.");

// handler 用的是 Nitro 自动导入的 defineEventHandler；tsx 下没有这个全局，补一个等价实现。
(globalThis as unknown as { defineEventHandler: unknown }).defineEventHandler = (handler: unknown) => handler;

const { getPrisma } = await import("../server/utils/prisma");
const { localDayKey } = await import("../server/utils/memory-event-time");
const daysIndex = (await import("../server/api/characters/[id]/days/index.get")).default;
const dayDetail = (await import("../server/api/characters/[id]/days/[dayKey].get")).default;

const prisma = getPrisma();
const KEYWORD = "海";

function shiftDay(base: string, delta: number) {
  const date = new Date(`${base}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}
function at(dayKey: string, minute: number) {
  return new Date(new Date(`${dayKey}T00:00:00.000Z`).getTime() + minute * 60_000);
}

// ── 夹具 ────────────────────────────────────────────────────────────
const ownerId = randomUUID();
const otherOwnerId = randomUUID();
const characterA = randomUUID();
const characterB = randomUUID();
const characterC = randomUUID();
const scopeAGlobal = randomUUID();
const scopeAPrivate = randomUUID();
const scopeB = randomUUID();
const scopeC = randomUUID();
const sessionToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");

const todayA = localDayKey(new Date(), "Asia/Shanghai");
const todayB = localDayKey(new Date(), "America/New_York");
const base = shiftDay(todayA, -2);

/** 95 个有记录的日期（都早于今天），其中三个有特殊用途。 */
const calendarDays = Array.from({ length: 95 }, (_, index) => shiftDay(base, -(index + 1)));
const multiScopeDay = shiftDay(base, -10);
const bigDay = shiftDay(base, -3);
const hitDay = shiftDay(base, -5);
/** 40 个「搜索命中」的日期，比日历那 95 天更早。 */
const searchDays = Array.from({ length: 40 }, (_, index) => shiftDay(base, -(100 + index + 1)));
const bDays = [shiftDay(base, -200), shiftDay(base, -201), shiftDay(base, -202)];
/** A 和 B 都有记录的同一天：用来验证同一天两个角色的条数互不串。 */
const sharedDay = shiftDay(base, -50);
const SHARED_DAY_B_EVENTS = 5;
/** 特殊日期不能撞车。 */
assert.equal(new Set([multiScopeDay, bigDay, hitDay]).size, 3);
assert(!calendarDays.includes(todayA), "Today must not be one of the seeded calendar days.");

const BIG_DAY_EVENTS = 130;
const BIG_DAY_ARCHIVED = 20;
const SEARCH_EVENTS_PER_DAY = 8;
const HIT_DAY_EVENTS = 5;
const HIT_DAY_MATCHES = 2;

type EventSeed = {
  scopeId: string;
  dayKey: string;
  index: number;
  title: string;
  detail: string;
  status?: "ACTIVE" | "ARCHIVED";
  state?: "DRAFT" | "FINAL";
};

function eventRow(seed: EventSeed) {
  return {
    memoryScopeId: seed.scopeId,
    dayKey: seed.dayKey,
    title: seed.title.slice(0, 200),
    detail: seed.detail,
    occurredAt: at(seed.dayKey, seed.index),
    status: (seed.status ?? "ACTIVE") as "ACTIVE" | "ARCHIVED",
    state: (seed.state ?? "FINAL") as "DRAFT" | "FINAL",
    dedupeKey: `${seed.dayKey}:${seed.scopeId}:${seed.index}`,
    sourceMessageIds: [],
    participants: [],
    keywords: [],
  };
}

const events: EventSeed[] = [];
for (const dayKey of calendarDays) {
  if (dayKey === bigDay) {
    for (let index = 0; index < BIG_DAY_EVENTS; index += 1) {
      events.push({
        scopeId: scopeAGlobal,
        dayKey,
        index,
        title: `大日子事件 ${index + 1}`,
        detail: `第 ${index + 1} 件事`,
        // 后 20 条是在页面上被隐藏的（ARCHIVED），日历与当天总数都要把它们算进去。
        status: index >= BIG_DAY_EVENTS - BIG_DAY_ARCHIVED ? "ARCHIVED" : "ACTIVE",
        state: index % 7 === 0 ? "DRAFT" : "FINAL",
      });
    }
    continue;
  }
  if (dayKey === hitDay) {
    for (let index = 0; index < HIT_DAY_EVENTS; index += 1) {
      const matches = index < HIT_DAY_MATCHES;
      events.push({
        scopeId: scopeAGlobal,
        dayKey,
        index,
        title: matches ? `${KEYWORD}边散步 ${index + 1}` : `普通记录 ${index + 1}`,
        detail: matches ? "命中关键词的那两条" : "不命中",
      });
    }
    continue;
  }
  if (dayKey === multiScopeDay) {
    // 同一天两个记忆范围各一条：日历必须只显示一行，条数相加。
    events.push({ scopeId: scopeAGlobal, dayKey, index: 0, title: "主线的一条", detail: "" });
    events.push({ scopeId: scopeAGlobal, dayKey, index: 1, title: "主线的第二条", detail: "" });
    events.push({ scopeId: scopeAPrivate, dayKey, index: 2, title: "私聊的一条", detail: "" });
    continue;
  }
  events.push({ scopeId: scopeAGlobal, dayKey, index: 0, title: `日常 ${dayKey} A`, detail: "日常" });
  events.push({ scopeId: scopeAGlobal, dayKey, index: 1, title: `日常 ${dayKey} B`, detail: "日常" });
}
for (const dayKey of searchDays) {
  for (let index = 0; index < SEARCH_EVENTS_PER_DAY; index += 1) {
    events.push({
      scopeId: scopeAGlobal,
      dayKey,
      index,
      title: `${KEYWORD}岸线 ${dayKey} #${index + 1}`,
      detail: `${KEYWORD}边的记录`,
    });
  }
}
for (const dayKey of bDays) {
  events.push({ scopeId: scopeB, dayKey, index: 0, title: "B 角色的一天", detail: "只属于 B" });
}
for (let index = 0; index < SHARED_DAY_B_EVENTS; index += 1) {
  events.push({ scopeId: scopeB, dayKey: sharedDay, index, title: `B 在同一天的记录 ${index + 1}`, detail: "只属于 B" });
}

const dayCounter = new Map<string, number>();
function bump(scopeId: string, dayKey: string, amount = 1) {
  const key = `${scopeId}|${dayKey}`;
  dayCounter.set(key, (dayCounter.get(key) ?? 0) + amount);
}
for (const seed of events) bump(seed.scopeId, seed.dayKey);

async function seed() {
  await prisma.user.createMany({
    data: [
      { id: ownerId, username: `days-owner-${ownerId}`, passwordHash: "test-only" },
      { id: otherOwnerId, username: `days-other-${otherOwnerId}`, passwordHash: "test-only" },
    ],
  });
  await prisma.session.create({
    data: {
      userId: ownerId,
      tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  await prisma.character.createMany({
    data: [
      { id: characterA, ownerId, name: "日历角色A", basePrompt: "test" },
      { id: characterB, ownerId, name: "日历角色B", basePrompt: "test" },
      { id: characterC, ownerId: otherOwnerId, name: "别人家的角色", basePrompt: "test" },
    ],
  });
  await prisma.characterMemorySetting.createMany({
    data: [
      { characterId: characterA, timezone: "Asia/Shanghai" },
      { characterId: characterB, timezone: "America/New_York" },
      { characterId: characterC, timezone: "Asia/Shanghai" },
    ],
  });
  await prisma.memoryScope.createMany({
    data: [
      { id: scopeAGlobal, characterId: characterA, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:a:${scopeAGlobal}` },
      { id: scopeAPrivate, characterId: characterA, scopeType: "USER_PRIVATE", scopeKey: `test:ap:${scopeAPrivate}`, userId: ownerId },
      { id: scopeB, characterId: characterB, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:b:${scopeB}` },
      { id: scopeC, characterId: characterC, scopeType: "CHARACTER_GLOBAL", scopeKey: `test:c:${scopeC}` },
    ],
  });
  const dayRows = [...dayCounter.entries()].map(([key, count]) => {
    const [scopeId, dayKey] = key.split("|") as [string, string];
    return {
      memoryScopeId: scopeId,
      dayKey,
      state: "FINAL" as const,
      eventCount: count,
      extractedAt: at(dayKey, 600),
    };
  });
  await prisma.memoryEventDay.createMany({ data: dayRows });
  await prisma.memoryEvent.createMany({ data: events.map(eventRow) });
}

// ── 起一个只挂这两个 handler 的最小 HTTP 服务 ──────────────────────
const app = createApp();
const router = createRouter();
router.get("/api/characters/:id/days", daysIndex);
router.get("/api/characters/:id/days/:dayKey", dayDetail);
app.use(router);
const server = http.createServer(toNodeListener(app));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const origin = `http://127.0.0.1:${port}`;
const cookie = `yiling_session=${sessionToken}`;

type DayRow = { dayKey: string; state: "DRAFT" | "FINAL" | null; eventCount: number };
type DaysBody = {
  today: string; timeZone: string; days: DayRow[]; query: string;
  page: number; pageSize: number; total: number; totalPages: number;
};
type DetailBody = {
  eventsTotal: number; eventsPage: number; eventsPageSize: number; eventsTotalPages: number;
  events: Array<{ id: string; occurredAt: string; status: string; title: string }>;
  day: { dayKey: string; state: string | null; eventCount: number };
};

async function request(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(origin + path, { headers: { cookie } });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
async function days(characterId: string, params: Record<string, string | number> = {}): Promise<DaysBody> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const { status, body } = await request(`/api/characters/${characterId}/days?${query.toString()}`);
  assert.equal(status, 200, `days request failed: ${JSON.stringify(body)}`);
  return body as DaysBody;
}
async function detail(characterId: string, dayKey: string, params: Record<string, string | number> = {}): Promise<DetailBody> {
  const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  const { status, body } = await request(`/api/characters/${characterId}/days/${dayKey}?${query.toString()}`);
  assert.equal(status, 200, `detail request failed: ${JSON.stringify(body)}`);
  return body as DetailBody;
}
function assertDescending(rows: DayRow[], label: string) {
  for (let index = 1; index < rows.length; index += 1) {
    assert(rows[index - 1]!.dayKey > rows[index]!.dayKey, `${label}: day keys must be strictly descending`);
  }
}
async function walk(characterId: string, pageSize: number, extra: Record<string, string | number> = {}) {
  const first = await days(characterId, { ...extra, page: 1, pageSize });
  const all: DayRow[] = [...first.days];
  for (let page = 2; page <= first.totalPages; page += 1) {
    const body = await days(characterId, { ...extra, page, pageSize });
    assert.equal(body.page, page, "walk: echoed page must match the requested page");
    assert.equal(body.total, first.total, "walk: total must not drift between pages");
    all.push(...body.days);
  }
  return { first, all };
}

try {
  await seed();
  /** 搜索用的那 40 天本身也是「有记录的日子」，所以日历总数要把它们算进来。 */
  const expectedDays = [todayA, ...calendarDays, ...searchDays].sort((left, right) => right.localeCompare(left));
  const expectedTotal = expectedDays.length;

  // 1. 超过 90 个日期：完整翻阅，不重不漏，且不再被 90 天截断。
  const walk20 = await walk(characterA, 20);
  assert.equal(walk20.first.total, expectedTotal, `expected ${expectedTotal} days, got ${walk20.first.total}`);
  assert.equal(walk20.first.totalPages, Math.ceil(expectedTotal / 20));
  assert.equal(walk20.all.length, expectedTotal, "walking every page must yield exactly total rows");
  assert.equal(new Set(walk20.all.map((row) => row.dayKey)).size, expectedTotal, "no duplicate day across pages");
  assert.deepEqual(walk20.all.map((row) => row.dayKey), expectedDays, "page walk must equal the full expected set");
  assertDescending(walk20.all, "pageSize=20");
  const walk100 = await walk(characterA, 100);
  assert.equal(walk100.all.length, expectedTotal, "90-day truncation must be gone");
  assert.deepEqual(walk100.all.map((row) => row.dayKey), expectedDays, "pageSize=100 must cover the same set");
  const capped = await days(characterA, { page: 1, pageSize: 500 });
  assert.equal(capped.pageSize, 100, "pageSize must be capped at 100");
  console.log(`Calendar days: ${walk20.first.total} days over ${walk20.first.totalPages} pages, no duplicates, no truncation.`);

  // 2. 同一天多个记忆范围，只显示一行，条数相加。
  const multiScopeRows = walk20.all.filter((row) => row.dayKey === multiScopeDay);
  assert.equal(multiScopeRows.length, 1, "a day with two memory scopes must still be a single row");
  assert.equal(multiScopeRows[0]!.eventCount, 3, "event counts of both scopes must be summed");
  const multiDetail = await detail(characterA, multiScopeDay);
  assert.equal(multiDetail.day.eventCount, 3, "day detail must merge the same two scopes");
  console.log("Multi-scope day: one row, eventCount = 3 (2 global + 1 private).");

  // 3. 搜索命中超过 300 条忆泡时，仍能翻到更早的日期。
  const searchTotalDays = searchDays.length + 1; // 40 天 + 命中 2 条的 hitDay
  const searchFirst = await days(characterA, { q: KEYWORD, page: 1, pageSize: 20 });
  assert.equal(searchFirst.total, searchTotalDays, `search must report ${searchTotalDays} days, got ${searchFirst.total}`);
  assert.equal(searchFirst.totalPages, 3);
  const searchWalk = await walk(characterA, 20, { q: KEYWORD });
  assert.equal(searchWalk.all.length, searchTotalDays, "search walk must reach every matched day");
  assert.equal(new Set(searchWalk.all.map((row) => row.dayKey)).size, searchTotalDays);
  assertDescending(searchWalk.all, "search pageSize=20");
  const oldestSearchDay = searchDays[searchDays.length - 1]!;
  assert(searchWalk.all.some((row) => row.dayKey === oldestSearchDay), "the oldest matched day must remain reachable");
  assert.equal(searchWalk.all[searchWalk.all.length - 1]!.dayKey, oldestSearchDay, "oldest matched day must be the last row");
  const matchingEvents = await prisma.memoryEvent.count({
    where: { memoryScope: { is: { characterId: characterA } }, status: "ACTIVE", OR: [
      { title: { contains: KEYWORD, mode: "insensitive" } },
      { detail: { contains: KEYWORD, mode: "insensitive" } },
      { participants: { has: KEYWORD } },
    ] },
  });
  assert.equal(matchingEvents, 322, `fixture sanity: expected 322 matching events, got ${matchingEvents}`);
  assert(matchingEvents > 300, "this scenario must exceed the old 300-event cap");
  console.log(`Search: ${searchTotalDays} matched days reachable across ${searchFirst.totalPages} pages (${matchingEvents} matching events, old cap was 300).`);

  // 4. 搜索结果的 eventCount 是命中数量，不是当天总数量。
  const hitRow = searchWalk.all.find((row) => row.dayKey === hitDay);
  assert(hitRow, "the partially matching day must appear in search results");
  assert.equal(hitRow.eventCount, HIT_DAY_MATCHES, "search eventCount must be the hit count");
  const hitCalendarRow = walk20.all.find((row) => row.dayKey === hitDay);
  assert.equal(hitCalendarRow?.eventCount, HIT_DAY_EVENTS, "calendar eventCount keeps the whole-day total");
  console.log(`Search eventCount: ${hitRow.eventCount} hits on the day vs ${hitCalendarRow?.eventCount} total events.`);

  // 5 & 6. 一天超过 100 条忆泡：每页 20、排序稳定、总数含已隐藏。
  const bigFirst = await detail(characterA, bigDay, { page: 1 });
  assert.equal(bigFirst.eventsTotal, BIG_DAY_EVENTS, "eventsTotal must include archived events");
  assert.equal(bigFirst.eventsPageSize, 20);
  assert.equal(bigFirst.eventsTotalPages, 7, "130 events over 20 per page is 7 pages");
  const bigPages: DetailBody[] = [bigFirst];
  for (let page = 2; page <= bigFirst.eventsTotalPages; page += 1) bigPages.push(await detail(characterA, bigDay, { page }));
  const seenEvents = bigPages.flatMap((page) => page.events);
  assert.equal(seenEvents.length, BIG_DAY_EVENTS, "walking every page must yield every event once");
  assert.equal(new Set(seenEvents.map((event) => event.id)).size, BIG_DAY_EVENTS, "no duplicate event across pages");
  assert.deepEqual(bigPages.map((page) => page.events.length), [20, 20, 20, 20, 20, 20, 10], "page sizes must be 20 except the last");
  for (let index = 1; index < seenEvents.length; index += 1) {
    const previous = seenEvents[index - 1]!;
    const current = seenEvents[index]!;
    assert(
      previous.occurredAt > current.occurredAt || (previous.occurredAt === current.occurredAt && previous.id > current.id),
      "events must stay newest-first by occurredAt then id across all pages",
    );
  }
  const archivedSeen = seenEvents.filter((event) => event.status === "ARCHIVED").length;
  assert.equal(archivedSeen, BIG_DAY_ARCHIVED, "archived events must be paginated alongside active ones");
  const archivedOnFirstPage = bigFirst.events.filter((event) => event.status === "ARCHIVED").length;
  assert.equal(archivedOnFirstPage, 20, "newest-first ordering puts this fixture's latest archived events on the first page");
  const bigCalendarRow = walk20.all.find((row) => row.dayKey === bigDay);
  assert.equal(bigCalendarRow?.eventCount, BIG_DAY_EVENTS, "calendar count must include archived events");
  console.log(`Big day: ${BIG_DAY_EVENTS} events over 7 pages, stable order, ${BIG_DAY_ARCHIVED} archived included in totals.`);

  // 7. 超出最大页码时修正。
  const lastExplicit = await days(characterA, { page: walk20.first.totalPages, pageSize: 20 });
  const lastPage = await days(characterA, { page: 999, pageSize: 20 });
  assert.equal(lastPage.page, lastPage.totalPages, "an out-of-range page must be clamped to the last page");
  assert.equal(lastPage.days.length, expectedTotal - (walk20.first.totalPages - 1) * 20, "the last page keeps the remainder");
  assert.deepEqual(lastPage.days.map((row) => row.dayKey), lastExplicit.days.map((row) => row.dayKey));
  for (const [label, params] of [
    ["page=0", { page: 0 }],
    ["page=-5", { page: -5 }],
    ["page=abc", { page: "abc" }],
  ] as const) {
    const body = await days(characterA, { ...params, pageSize: 20 });
    assert.equal(body.page, 1, `${label} must fall back to page 1`);
  }
  const bigOverflow = await detail(characterA, bigDay, { page: 999 });
  assert.equal(bigOverflow.eventsPage, bigOverflow.eventsTotalPages, "event pagination must clamp out-of-range pages too");
  assert.deepEqual(bigOverflow.events.map((event) => event.id), bigPages[bigPages.length - 1]!.events.map((event) => event.id));
  const bigZero = await detail(characterA, bigDay, { page: 0 });
  assert.equal(bigZero.eventsPage, 1, "event page 0 must fall back to 1");
  console.log("Out-of-range pages: clamped to the last page; 0 / negative / non-numeric fall back to 1.");

  // 8. 角色隔离 + 今天还没整理也会出现。
  const todayRow = walk20.all.find((row) => row.dayKey === todayA);
  assert(todayRow, "today must be listed even when nothing has been extracted yet");
  assert.equal(todayRow.eventCount, 0);
  assert.equal(todayRow.state, "DRAFT", "an unextracted today must be DRAFT");
  assert.equal(walk20.first.today, todayA, "today must use the character timezone");
  assert.equal(walk20.first.timeZone, "Asia/Shanghai");
  const bDaysBody = await days(characterB, { page: 1, pageSize: 20 });
  assert.equal(bDaysBody.timeZone, "America/New_York", "each character keeps its own timezone");
  assert.equal(bDaysBody.today, todayB, "today must be computed in the character timezone");
  assert.equal(bDaysBody.total, bDays.length + 2, "B sees its own 3 days, the shared day and today");
  const bKeys = new Set(bDaysBody.days.map((row) => row.dayKey));
  for (const dayKey of calendarDays) {
    if (dayKey === sharedDay) continue;
    assert(!bKeys.has(dayKey), "character B must not see character A's days");
  }
  for (const dayKey of bDays) assert(!walk20.all.some((row) => row.dayKey === dayKey), "character A must not see character B's days");
  const sharedForA = walk20.all.find((row) => row.dayKey === sharedDay);
  const sharedForB = bDaysBody.days.find((row) => row.dayKey === sharedDay);
  assert.equal(sharedForA?.eventCount, 2, "the shared day keeps character A's own count");
  assert.equal(sharedForB?.eventCount, SHARED_DAY_B_EVENTS, "the shared day keeps character B's own count");
  const foreign = await request(`/api/characters/${characterC}/days?page=1&pageSize=20`);
  assert.equal(foreign.status, 404, "another owner's character must not be readable");
  const foreignDetail = await request(`/api/characters/${characterC}/days/${bigDay}`);
  assert.equal(foreignDetail.status, 404, "another owner's day detail must not be readable");
  console.log(`Isolation: A=${walk20.first.total} days (${walk20.first.timeZone}), B=${bDaysBody.total} days (${bDaysBody.timeZone}), foreign character = 404.`);

  console.log("Memory calendar pagination DB regression passed.");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}
