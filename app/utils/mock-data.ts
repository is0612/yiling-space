export type TimelineType = "message" | "memory" | "snapshot" | "event" | "memoryEvent";

// 角色的形状与后端共用一份（`shared/types/character.ts`）。
// 这里原先是一份「全可选」的副本，注释里还写着「列表和详情字段不完全一致」——
// 其实所有接口都走同一个 characterInclude + toCharacterDto，形状早就统一了。
export type {
  Character,
  CharacterStatus,
  AvatarTone,
  ProactiveSettings,
  GroupInitiativeSettings,
} from "#shared/types/character";
import type { Character } from "#shared/types/character";

export type TimelineEntry = {
  id: string;
  type: TimelineType;
  title: string;
  summary: string;
  time: string;
  channel: string;
  tag: string;
  tagTone: "green" | "purple" | "blue" | "amber" | "gray";
  source: string;
  /** 记忆条目的重要度（0–1）；只有还在生效的记忆带。 */
  importance?: number;
};

// 快照相关形状统一放在 shared 契约里；这里 re-export 保持既有 import 路径可用，
// 同时服务端不再需要反过来 import 前端的 mock-data。

export type DemoTask = {
  id: string;
  name: string;
  character: string;
  range: string;
  status: "等待执行" | "成功" | "失败待重试" | "跳过" | "运行中";
  tone: "amber" | "green" | "rose" | "gray" | "blue";
  tries: number;
  time: string;
};


// 快照相关形状同样在 shared 契约里；这里 re-export 保持既有 import 路径可用。
export type {
  Snapshot,
  SnapshotAnalysis,
  SnapshotDetail,
  SnapshotSourceMessage,
} from "#shared/types/snapshot";

/** 演示数据：真实接口字段很多，占位数据不需要填满。 */
export type DemoCharacter = Partial<Character> & Pick<Character, "id" | "name" | "alias" | "description" | "avatar" | "avatarTone" | "status" | "channels" | "intervalDays" | "nextSnapshot" | "memoryCount" | "latestSnapshot" | "personality">;

export const initialCharacters: DemoCharacter[] = [
  {
    id: "big-fish",
    name: "大肥鱼",
    alias: "日常陪伴型",
    description: "有点懒散但很贴心，喜欢和熟悉的人分享生活。",
    avatar: "鱼",
    avatarTone: "purple",
    status: "运行中",
    channels: ["QQ"],
    intervalDays: 8,
    nextSnapshot: "明天 09:00",
    memoryCount: 128,
    latestSnapshot: "10 月 21 日",
    personality: "温柔、爱吐槽、偶尔犯懒，对熟悉的人很有耐心。",
  },
  {
    id: "dragon-girl",
    name: "龙娘",
    alias: "幻想陪伴型",
    description: "自信又好奇，对新鲜事物充满探索欲。",
    avatar: "龙",
    avatarTone: "peach",
    status: "运行中",
    channels: ["QQ"],
    intervalDays: 14,
    nextSnapshot: "11 月 03 日 20:00",
    memoryCount: 76,
    latestSnapshot: "10 月 20 日",
    personality: "有一点傲娇，喜欢探索未知，也很珍惜建立的羁绊。",
  },
  {
    id: "stargazer",
    name: "星海旅人",
    alias: "自定义角色",
    description: "记录旅途见闻的观察者，安静而富有想象力。",
    avatar: "星",
    avatarTone: "blue",
    status: "已暂停",
    channels: [],
    intervalDays: 8,
    nextSnapshot: "暂停中",
    memoryCount: 34,
    latestSnapshot: "10 月 14 日",
    personality: "理性、温和、喜欢把零散见闻整理成故事。",
  },
];

export const initialTimeline: TimelineEntry[] = [
  {
    id: "evt-1",
    type: "event",
    title: "一起看了《孤独摇滚！》的剪辑",
    summary: "大肥鱼分享了最近收藏的片段，并聊到自己最喜欢的演出桥段。",
    time: "今天 08:42",
    channel: "QQ",
    tag: "互动事件",
    tagTone: "blue",
    source: "QQ 私聊 · 消息 #msg-2081",
  },
  {
    id: "evt-2",
    type: "memory",
    title: "记住了：用户喜欢深夜分享视频",
    summary: "连续几次互动都发生在晚上，用户更喜欢轻松、有趣而不太正式的交流。",
    time: "昨天 22:16",
    channel: "QQ",
    tag: "长期记忆",
    tagTone: "purple",
    source: "由 4 条对话提炼 · 记忆 #mem-0148",
  },
  {
    id: "evt-3",
    type: "message",
    title: "聊到周末想做的事情",
    summary: "用户说周末想找一部新番看，大肥鱼答应整理一份轻松向的片单。",
    time: "昨天 19:32",
    channel: "QQ",
    tag: "对话记录",
    tagTone: "green",
    source: "QQ 私聊 · 会话 #conv-041",
  },
  {
    id: "evt-4",
    type: "snapshot",
    title: "第 12 份阶段总结已生成",
    summary: "本阶段共整理 46 条消息、5 个重要事件和 2 项需要继续跟进的约定。",
    time: "10 月 21 日 09:00",
    channel: "全部渠道",
    tag: "阶段总结",
    tagTone: "amber",
    source: "阶段总结 #snap-0012 · 版本 1",
  },
  {
    id: "evt-5",
    type: "event",
    title: "关注了一个新的音乐频道",
    summary: "从聊天记录中发现用户最近开始关注轻音乐和 Lo-fi 播放列表。",
    time: "10 月 20 日 21:08",
    channel: "QQ",
    tag: "内容事件",
    tagTone: "blue",
    source: "聊天记录 · 来源 #msg-381",
  },
];

export const initialSnapshots: Snapshot[] = [
  {
    id: "snap-12",
    number: 12,
    label: "第 12 份",
    version: 1,
    date: "2026-10-21 09:00",
    range: "10 月 13 日 — 10 月 21 日",
    summary: "最近更习惯在晚间分享视频；已答应整理一份轻松向片单，尚待跟进。",
    events: 5,
    messages: 46,
    status: "当前版本",
    statusTone: "green",

    kind: "AUTOMATIC",

    pendingReview: 0,
  },
  {
    id: "snap-11",
    number: 11,
    label: "第 11 份",
    version: 2,
    date: "2026-10-13 09:02",
    range: "10 月 5 日 — 10 月 13 日",
    summary: "重新生成的第 11 份阶段总结，修正了关于用户音乐偏好的描述，保留原版本供追溯。",
    events: 4,
    messages: 39,
    status: "当前版本",
    statusTone: "green",

    kind: "AUTOMATIC",

    pendingReview: 0,
  },
  {
    id: "snap-10",
    number: 10,
    label: "第 10 份",
    version: 1,
    date: "2026-10-05 09:00",
    range: "9 月 27 日 — 10 月 5 日",
    summary: "首次记录到用户开始规律分享音乐，并更喜欢简洁直接的聊天方式。",
    events: 3,
    messages: 31,
    status: "已被替代",
    statusTone: "gray",

    kind: "AUTOMATIC",

    pendingReview: 0,
  },
];

export const initialTasks: DemoTask[] = [
  { id: "job-204", name: "生成阶段总结", character: "大肥鱼", range: "10/21 09:00 — 10/29 09:00", status: "等待执行", tone: "amber", tries: 0, time: "计划于明天 09:00" },
  { id: "job-203", name: "整理长期记忆", character: "大肥鱼", range: "当前周期", status: "成功", tone: "green", tries: 1, time: "今天 08:45" },
  { id: "job-202", name: "生成阶段总结", character: "龙娘", range: "10/20 20:00 — 11/03 20:00", status: "等待执行", tone: "amber", tries: 0, time: "计划于 11/03 20:00" },
  { id: "job-200", name: "检查周期活动", character: "星海旅人", range: "10/06 — 10/14", status: "跳过", tone: "gray", tries: 1, time: "10 月 14 日 09:00" },
];

export const channels = [
  { name: "QQ", description: "聊天消息与会话事件", status: "规划中", color: "purple" },
  { name: "Telegram", description: "机器人会话与命令", status: "预留", color: "green" },
];
