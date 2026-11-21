import type { MemoryEvent, MemoryEventScope, MemoryEventState, MemoryEventStatus, MemoryScopeType } from "../../shared/types/memory";

/** 范围语义映射：DB 的 scopeType → 页面用的三档。认不出来按角色全局处理（不会误判成私人）。 */
export function memoryEventScopeOf(scopeType: MemoryScopeType | string): MemoryEventScope {
  if (scopeType === "USER_PRIVATE") return "private";
  if (scopeType === "EXTERNAL_IDENTITY") return "external";
  return "character";
}

/**
 * 整形前的行：`memoryScope.scopeType` 是唯一需要拍平的关联字段。
 * `dayKey` 可选 —— 日子详情的 select 不取它（同一个接口里 dayKey 已在顶层）。
 */
export type MemoryEventRow = {
  id: string;
  dayKey?: string;
  occurredAt: Date;
  timeOfDay: string | null;
  place: string | null;
  participants: string[];
  title: string;
  detail: string;
  state: MemoryEventState;
  status: MemoryEventStatus;
  confidence: number | null;
  sourceMessageIds: string[];
  memoryScope: { scopeType: MemoryScopeType | string };
};

/**
 * 把 `memory_events` 的一行整形成忆泡 DTO（`shared/types/memory.ts` 的 `MemoryEvent`）。
 *
 * 日子详情与编辑接口共用这一份。之前两处各自手写对象：编辑接口没有
 * `confidence` / `sourceMessageIds`，日子详情没有 `dayKey` —— 同一张表，两个形状。
 * 这里不 `...row`：`memoryScopeId` / `participantRefs` / `dedupeKey` / `keywords`
 * 这些内部字段不该进响应。
 */
export function toMemoryEvent(row: MemoryEventRow): MemoryEvent {
  return {
    id: row.id,
    ...(row.dayKey ? { dayKey: row.dayKey } : {}),
    occurredAt: row.occurredAt.toISOString(),
    timeOfDay: row.timeOfDay,
    place: row.place,
    participants: row.participants,
    title: row.title,
    detail: row.detail,
    state: row.state,
    status: row.status,
    confidence: row.confidence,
    sourceMessageIds: row.sourceMessageIds,
    scope: memoryEventScopeOf(row.memoryScope.scopeType),
  };
}
