import assert from "node:assert/strict";
import { pickPersonCueEvent } from "../server/utils/person-cue";

const now = new Date("2026-11-21T12:00:00+08:00");
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
const event = (id: string, daysAgo: number, title: string, participants: string[], externalId: string | null) => ({
  id,
  title,
  detail: `${title}的细节`,
  occurredAt: at(daysAgo),
  participants,
  keywords: [] as string[],
  memoryScopeId: "global",
  ...(externalId ? { participantRefs: [{ kind: "external", platform: "qq-onebot", externalId, displayName: participants[0] }] } : {}),
});

const base = {
  // 不带「上次/最近一次」：那是时间意图，会压过相关度；线索要的是「沾边」。
  query: "那个比赛你怎么看",
  now,
  timeZone: "Asia/Shanghai",
};

// 1) 按账号命中：说话人换了名字，靠账号仍能认出。
const renamed = [event("e1", 3, "陪看比赛", ["鱼小刚"], "100001")];
const picked = pickPersonCueEvent({ ...base, events: renamed, speakerIds: ["100001"] });
assert.equal(picked.reason, "picked");
assert.equal(picked.event?.id, "e1", "账号命中要能选出这条共同经历");

// 2) 说话人不在任何忆泡里：不硬凑。
const unrelated = [event("e2", 2, "她在群里和水友聊天", ["路人甲"], "999999")];
assert.deepEqual(
  pickPersonCueEvent({ ...base, events: unrelated, speakerIds: ["100001"] }),
  { event: null, reason: "no_match" },
);

// 3) 没有发言人（比如她自己触发的轮次）：直接空。
assert.deepEqual(
  pickPersonCueEvent({ ...base, events: renamed, speakerIds: [] }),
  { event: null, reason: "no_speaker" },
);

// 4) 已经在提示词里的忆泡不要重复。
assert.deepEqual(
  pickPersonCueEvent({ ...base, events: renamed, speakerIds: ["100001"], excludeIds: new Set(["e1"]) }),
  { event: null, reason: "no_match" },
);

// 5) 多个候选：优先和本轮话题沾边的，而不是最近的。
const many = [
  event("old-match", 20, "一起去看比赛", ["鱼小刚"], "100001"),
  event("recent-unrelated", 1, "一起吃了顿饭", ["鱼小刚"], "100001"),
];
const relevant = pickPersonCueEvent({ ...base, events: many, speakerIds: ["100001"] });
assert.equal(relevant.event?.id, "old-match", "有相关经历时优先相关的那条");

// 6) 一条都不沾话题：退到最近一条共同经历，仍然是库里真实存在的事。
const noneRelevant = pickPersonCueEvent({
  ...base, query: "今天天气不错", events: many, speakerIds: ["100001"],
});
assert.equal(noneRelevant.event?.id, "recent-unrelated");

// 7) 没有引用（老忆泡）：按账号认不出，不能靠名字猜。
const noRefs = [{ ...event("e3", 1, "老记忆", ["鱼小刚"], null) }];
assert.deepEqual(
  pickPersonCueEvent({ ...base, events: noRefs, speakerIds: ["100001"] }),
  { event: null, reason: "no_match" },
  "老忆泡缺引用时宁可不给线索，也不要按名字猜人",
);

// 8) 多个发言人：任意一个人命中即可（这一轮好几个人在说话）。
const twoSpeakers = [event("e4", 5, "群里一起玩", ["甲"], "100002")];
assert.equal(pickPersonCueEvent({ ...base, events: twoSpeakers, speakerIds: ["100001", "100002"] }).event?.id, "e4");

console.log("人物线索测试通过：账号命中、换名不受影响、无关不硬凑、无发言人为空、已选去重、优先相关、缺引用不猜。");
