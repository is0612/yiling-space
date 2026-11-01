import { toMemorySnapshotDtos, type MemorySnapshotDto } from "./memory-snapshot-dto";

export type MemoryTimelineEntryDto = {
  id: string;
  type: "message" | "memory" | "snapshot" | "event" | "memoryEvent";
  title: string;
  summary: string;
  time: string;
  channel: string;
  tag: string;
  tagTone: "green" | "purple" | "blue" | "amber" | "gray";
  source: string;
};

/**
 * 一条忆泡。DRAFT = 今天还在长，FINAL = 已收口 —— 时间线上标出来，
 * 用户才知道「今天这几条还会变」。
 */
type MemoryEventRecord = {
  id: string;
  occurredAt: Date;
  timeOfDay: string | null;
  place: string | null;
  participants: string[];
  title: string;
  detail: string;
  state: "DRAFT" | "FINAL";
  memoryScope: { scopeType: string };
};

type MessageRecord = {
  id: string;
  role: "SYSTEM" | "USER" | "ASSISTANT" | "TOOL";
  eventType: string;
  content: string;
  occurredAt: Date;
  externalMessageId: string | null;
  conversation: {
    id: string;
    title: string | null;
    channelBinding: { connection: { displayName: string } } | null;
  };
};

type MemoryRecord = {
  id: string;
  category: "FACT" | "PREFERENCE" | "RELATIONSHIP" | "COMMITMENT" | "GOAL" | "EVENT" | "SUMMARY" | "OTHER";
  content: string;
  status: "ACTIVE" | "SUPERSEDED" | "ARCHIVED" | "INVALIDATED" | "TRASHED";
  createdAt: Date;
  updatedAt: Date;
  memoryScope: { scopeType: string };
};

type SnapshotRecord = Parameters<typeof toMemorySnapshotDtos>[0][number];

function formatTime(value: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  try {
    return new Intl.DateTimeFormat("zh-CN", options).format(value);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", { ...options, timeZone: "UTC" }).format(value);
  }
}

function summarize(value: string, maxLength = 260): string {
  const text = value.trim();
  return text.length > maxLength ? text.slice(0, maxLength) + "…" : text;
}

const messageRoleLabels: Record<MessageRecord["role"], string> = {
  SYSTEM: "系统消息",
  USER: "用户消息",
  ASSISTANT: "角色回复",
  TOOL: "工具记录",
};

const eventTypeLabels: Record<string, string> = {
  message_deleted: "消息已撤回",
  message_edited: "消息已编辑",
  reaction: "互动事件",
  platform_event: "平台事件",
};

const memoryCategoryLabels: Record<MemoryRecord["category"], string> = {
  FACT: "事实记忆",
  PREFERENCE: "偏好记忆",
  RELATIONSHIP: "关系记忆",
  COMMITMENT: "承诺与约定",
  GOAL: "目标记忆",
  EVENT: "事件记忆",
  SUMMARY: "记忆摘要",
  OTHER: "长期记忆",
};

const memoryStatusLabels: Record<MemoryRecord["status"], string> = {
  ACTIVE: "长期记忆",
  SUPERSEDED: "已被替代",
  ARCHIVED: "已归档",
  INVALIDATED: "已失效",
  TRASHED: "回收站",
};

type TimedEntry = { timestamp: number; entry: MemoryTimelineEntryDto };

export function toMemoryTimelineDtos(input: {
  messages: MessageRecord[];
  memoryItems: MemoryRecord[];
  snapshots: SnapshotRecord[];
  events?: MemoryEventRecord[];
}, timeZone = "Asia/Shanghai", limit = 300): MemoryTimelineEntryDto[] {
  const records: TimedEntry[] = [];

  for (const message of input.messages) {
    const isEvent = message.eventType !== "message";
    const roleLabel = messageRoleLabels[message.role];
    const sourceId = message.externalMessageId || message.id.slice(0, 8);
    records.push({
      timestamp: message.occurredAt.getTime(),
      entry: {
        id: "message:" + message.id,
        type: isEvent ? "event" : "message",
        title: isEvent ? (eventTypeLabels[message.eventType] || "平台事件：" + message.eventType) : roleLabel,
        summary: summarize(message.content),
        time: formatTime(message.occurredAt, timeZone),
        channel: message.conversation.channelBinding?.connection.displayName || "本地会话",
        tag: isEvent ? "平台事件" : roleLabel,
        tagTone: isEvent ? "amber" : message.role === "USER" ? "green" : message.role === "ASSISTANT" ? "blue" : message.role === "TOOL" ? "purple" : "gray",
        source: "会话" + (message.conversation.title ? " · " + message.conversation.title : " · " + message.conversation.id.slice(0, 8)) + " · 消息 #" + sourceId,
      },
    });
  }

  for (const memory of input.memoryItems) {
    const statusLabel = memoryStatusLabels[memory.status];
    const isPrivate = memory.memoryScope.scopeType === "USER_PRIVATE";
    records.push({
      timestamp: memory.updatedAt.getTime(),
      entry: {
        id: "memory:" + memory.id,
        type: "memory",
        title: memoryCategoryLabels[memory.category],
        summary: summarize(memory.content),
        time: formatTime(memory.updatedAt, timeZone),
        channel: isPrivate ? "私人记忆" : "长期记忆",
        tag: statusLabel,
        tagTone: memory.status === "ACTIVE" ? "purple" : memory.status === "INVALIDATED" ? "amber" : "gray",
        source: "记忆条目 #" + memory.id.slice(0, 8),
      },
    });
  }

  const snapshotDtos: MemorySnapshotDto[] = toMemorySnapshotDtos(input.snapshots, timeZone);
  const snapshotsById = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  for (const snapshot of snapshotDtos) {
    const source = snapshotsById.get(snapshot.id);
    records.push({
      timestamp: source?.createdAt.getTime() ?? Date.parse(snapshot.date),
      entry: {
        id: "snapshot:" + snapshot.id,
        type: "snapshot",
        title: "第 " + snapshot.number + " 份阶段总结 · v" + snapshot.version,
        summary: snapshot.summary,
        time: snapshot.date,
        channel: "全部渠道",
        tag: snapshot.status,
        tagTone: snapshot.statusTone,
        source: "总结版本 #" + snapshot.id.slice(0, 8),
      },
    });
  }

  for (const event of input.events ?? []) {
    const isPrivate = event.memoryScope.scopeType === "USER_PRIVATE";
    const parts = [
      event.timeOfDay ?? "",
      event.place ? "地点：" + event.place : "",
      event.participants.length ? "相关：" + event.participants.join("、") : "",
      event.detail,
    ].filter(Boolean);
    records.push({
      timestamp: event.occurredAt.getTime(),
      entry: {
        id: "memoryEvent:" + event.id,
        type: "memoryEvent",
        title: event.title,
        summary: summarize(parts.join(" · ")),
        time: formatTime(event.occurredAt, timeZone),
        channel: isPrivate ? "私人记忆" : "长期记忆",
        // DRAFT 是「今天还在长」，标出来用户才知道这几条之后还会变。
        tag: event.state === "DRAFT" ? "还在记" : "已收口",
        tagTone: event.state === "DRAFT" ? "amber" : "purple",
        source: "忆泡 #" + event.id.slice(0, 8),
      },
    });
  }

  return records
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
