import assert from "node:assert/strict";
import { enumerateDayKeys, isDayKey, monthRange } from "../server/utils/day-range";

// 合法日期键
assert.equal(isDayKey("2026-11-21"), true);
assert.equal(isDayKey("2024-02-29"), true, "闰年 2 月 29 日存在");
assert.equal(isDayKey("2026-02-29"), false, "平年没有 2 月 29 日");
assert.equal(isDayKey("2026-13-01"), false, "月份越界");
assert.equal(isDayKey("2026-1-1"), false, "必须是两位");
assert.equal(isDayKey(20261121), false, "非字符串");

// 区间枚举：含两端
assert.deepEqual(enumerateDayKeys("2026-11-28", "2026-12-02"),
  ["2026-11-28", "2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"], "跨月要连续");
assert.deepEqual(enumerateDayKeys("2026-11-21", "2026-11-21"), ["2026-11-21"], "单日区间");
assert.deepEqual(enumerateDayKeys("2026-02-27", "2026-03-01"), ["2026-02-27", "2026-02-28", "2026-03-01"], "平年 2 月只有 28 天");
assert.deepEqual(enumerateDayKeys("2024-02-28", "2024-03-01"), ["2024-02-28", "2024-02-29", "2024-03-01"], "闰年补 29 日");

// 非法输入返回空，让调用方当「没给区间」处理，不要悄悄换成别的月份
assert.deepEqual(enumerateDayKeys("2026-11-30", "2026-11-01"), [], "顺序反了不猜");
assert.deepEqual(enumerateDayKeys("2026-02-31", "2026-03-01"), [], "不存在的日期不算区间");
assert.deepEqual(enumerateDayKeys("2026-11-01", "2027-12-31", 10).length, 10, "上限兜底，避免整年扫表");

// 月范围：整月最后一天按大小月与闰年算
assert.deepEqual(monthRange("2026-11"), { from: "2026-11-01", to: "2026-11-30" });
assert.deepEqual(monthRange("2024-02"), { from: "2024-02-01", to: "2024-02-29" });
assert.deepEqual(monthRange("2026-02"), { from: "2026-02-01", to: "2026-02-28" });
assert.deepEqual(monthRange("2026-12"), { from: "2026-12-01", to: "2026-12-31" });
assert.equal(monthRange("2026-13"), null);
assert.equal(monthRange("2026-1"), null);
assert.equal(monthRange("202611"), null);

// 月范围枚举出来的天数要和月份长度一致
for (const month of ["2026-01", "2026-02", "2026-04", "2024-02", "2026-12"]) {
  const range = monthRange(month)!;
  const days = enumerateDayKeys(range.from, range.to);
  assert.equal(days.length, Number(range.to.slice(-2)), `${month} 的天数要与 to 一致`);
  assert.equal(days[0], range.from);
  assert.equal(days.at(-1), range.to);
}

console.log("日期区间测试通过：日期键校验（含闰年与非法值）、含两端枚举、跨月连续、上限兜底、月范围交接。");
