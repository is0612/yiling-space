import { createError } from "h3";

export type DailyLifePlanInput = {
  dayKey: string;
  timeZone: string;
  lifeType: string;
  summary: string;
  items: Array<{
    title: string;
    detail: string;
    plannedStartAt: Date | null;
    plannedEndAt: Date | null;
    place: string | null;
    scene: string;
    outfitDescription: string;
    propsDescription: string;
    sortOrder: number;
  }>;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown, max: number, label: string, required = false): string {
  if (typeof value !== "string") {
    if (required) throw createError({ statusCode: 400, statusMessage: label + "必须是文本。" });
    return "";
  }
  const result = value.trim();
  if (required && !result) throw createError({ statusCode: 400, statusMessage: label + "不能为空。" });
  if (result.length > max) throw createError({ statusCode: 400, statusMessage: label + "不能超过 " + max + " 个字符。" });
  return result;
}

function optionalDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw createError({ statusCode: 400, statusMessage: label + "必须是带时区的 ISO 日期时间。" });
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw createError({ statusCode: 400, statusMessage: label + "无效。" });
  return date;
}

export function parseDailyLifePlanInput(value: unknown): DailyLifePlanInput {
  const body = record(value);
  const dayKey = text(body.dayKey, 10, "日期", true);
  const parsedDay = new Date(dayKey + "T00:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey) || !Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== dayKey) {
    throw createError({ statusCode: 400, statusMessage: "日期必须是 YYYY-MM-DD。" });
  }
  const timeZone = text(body.timeZone ?? "Asia/Shanghai", 80, "时区", true);
  try { new Intl.DateTimeFormat("en", { timeZone }).format(new Date()); }
  catch { throw createError({ statusCode: 400, statusMessage: "时区名称无效。" }); }
  const lifeType = text(body.lifeType ?? "FREE", 40, "生活类型", true);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length > 24) throw createError({ statusCode: 400, statusMessage: "一天最多安排 24 项活动。" });
  const items = rawItems.map((raw, index) => {
    const item = record(raw);
    const plannedStartAt = optionalDate(item.plannedStartAt, "活动开始时间");
    const plannedEndAt = optionalDate(item.plannedEndAt, "活动结束时间");
    if (plannedStartAt && plannedEndAt && plannedEndAt <= plannedStartAt) {
      throw createError({ statusCode: 400, statusMessage: "活动结束时间必须晚于开始时间。" });
    }
    return {
      title: text(item.title, 160, "活动标题", true),
      detail: text(item.detail, 4000, "活动详情"),
      plannedStartAt,
      plannedEndAt,
      place: text(item.place, 200, "地点") || null,
      scene: text(item.scene, 500, "场景"),
      outfitDescription: text(item.outfitDescription, 1000, "穿着"),
      propsDescription: text(item.propsDescription, 1000, "道具"),
      sortOrder: index,
    };
  });
  return { dayKey, timeZone, lifeType, summary: text(body.summary, 1000, "计划摘要"), items };
}

export function parseDailyLifeActivityInput(value: unknown) {
  const body = record(value);
  const planItemId = typeof body.planItemId === "string" && body.planItemId.trim() ? body.planItemId.trim() : null;
  const source = body.source === "CHARACTER_INITIATED" ? "CHARACTER_INITIATED"
    : body.source === "PLAN" ? "PLAN" : "USER_CONFIRMED";
  if (planItemId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(planItemId)) {
    throw createError({ statusCode: 400, statusMessage: "计划活动 ID 无效。" });
  }
  if (source === "PLAN" && !planItemId) throw createError({ statusCode: 400, statusMessage: "来自计划的活动必须关联一项计划活动。" });
  const title = text(body.title, 160, "活动标题", !planItemId);
  const detail = text(body.detail, 4000, "活动详情");
  const place = text(body.place, 200, "地点") || null;
  const sourceRef = text(body.sourceRef, 255, "来源引用") || null;
  return { planItemId, source, title, detail, place, sourceRef };
}
