import assert from "node:assert/strict";
import { parseDailyLifeActivityInput, parseDailyLifePlanInput } from "../server/utils/daily-life-input";

const plan = parseDailyLifePlanInput({
  dayKey: "2026-11-25",
  timeZone: "Asia/Shanghai",
  lifeType: "REST",
  summary: "在家休息",
  items: [{
    title: "看书",
    plannedStartAt: "2026-11-25T09:00:00+08:00",
    plannedEndAt: "2026-11-25T10:00:00+08:00",
    place: "家里",
  }],
});
assert.equal(plan.dayKey, "2026-11-25");
assert.equal(plan.items.length, 1);
assert.equal(plan.items[0]?.title, "看书");
assert.equal(plan.items[0]?.sortOrder, 0);
assert.throws(() => parseDailyLifePlanInput({ dayKey: "2026-02-31", items: [] }), /YYYY-MM-DD/u);
assert.throws(() => parseDailyLifePlanInput({ dayKey: "2026-11-25", timeZone: "Mars/Olympus", items: [] }), /时区/u);
assert.throws(() => parseDailyLifePlanInput({
  dayKey: "2026-11-25",
  items: [{ title: "错误时间", plannedStartAt: "2026-11-25T10:00:00Z", plannedEndAt: "2026-11-25T09:00:00Z" }],
}), /结束时间/u);
assert.throws(() => parseDailyLifePlanInput({ dayKey: "2026-11-25", items: Array.from({ length: 25 }, (_, i) => ({ title: "活动" + i })) }), /最多/u);
const activity = parseDailyLifeActivityInput({ title: "散步" });
assert.equal(activity.source, "USER_CONFIRMED");
assert.equal(activity.title, "散步");
const planned = parseDailyLifeActivityInput({ planItemId: "11111111-1111-4111-8111-111111111111" });
assert.equal(planned.planItemId, "11111111-1111-4111-8111-111111111111");
console.log("daily-life input tests passed");
