import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { planOwnerHistory, readOwnerHistoryPlan, OWNER_HISTORY_TTL_MS, ownerHistoryGroupWhere, ownerHistoryConversationWhere, selectOwnerHistoryEvidence, loadOwnerHistoryPage, loadOwnerHistoryEvidence, loadOwnerHistoryContext, saveOwnerHistoryContext, type OwnerHistoryRow, type OwnerHistoryPlan } from "../server/utils/owner-private-history";
import { generateConversationReplyWithMemoryAssistant } from "../server/utils/memory-assistant";
import { createAssistantTurnContext } from "../server/utils/assistant-turn-context";
import type { TurnDetailPatch } from "../server/utils/model-turn-detail";

const beforeMidnight = new Date("2026-11-17T15:58:00Z");
const initial = planOwnerHistory("查询今晚群里大家说了什么，群号123456789", null, beforeMidnight, "Asia/Shanghai")!;
assert.equal(initial.groupId, "123456789");
assert.equal(initial.start, "2026-11-17T10:00:00.000Z");
const followup = planOwnerHistory("他后来怎么回答的", initial, new Date("2026-11-17T16:03:00Z"), "Asia/Shanghai")!;
assert.equal(followup.start, initial.start);
assert.equal(followup.end, initial.end, "A follow-up must not move the date across midnight");
assert.equal(followup.anchoredAt, initial.anchoredAt, "TTL is absolute, not extended by every follow-up");
const unspecified = {...initial,groupId:undefined};
const clarifiedAfterMidnight = planOwnerHistory("123456789",unspecified,new Date("2026-11-17T16:03:00Z"),"Asia/Shanghai")!;
assert.equal(clarifiedAfterMidnight.start,initial.start,"Supplying the missing room after midnight preserves the original evening range");
assert.equal(clarifiedAfterMidnight.anchoredAt,initial.anchoredAt);
assert.equal(planOwnerHistory("今天吃什么", followup, beforeMidnight, "Asia/Shanghai"), null);
assert.equal(planOwnerHistory("换个话题吧", followup, beforeMidnight, "Asia/Shanghai"), null);
assert.equal(readOwnerHistoryPlan(initial, new Date(beforeMidnight.getTime()+OWNER_HISTORY_TTL_MS)), null);
const afterMidnight = planOwnerHistory("查今晚群里聊过什么", null, new Date("2026-11-17T16:05:00Z"), "Asia/Shanghai")!;
assert.equal(afterMidnight.start, "2026-11-17T10:00:00.000Z", "Tonight before dawn includes the preceding evening");
const named = planOwnerHistory("123456789这个群的某位群友", initial, beforeMidnight, "Asia/Shanghai")!;
assert.equal(named.participantName, "某位群友");
const groupWhere = JSON.stringify(ownerHistoryGroupWhere("character-a", initial));
assert(groupWhere.includes('"characterId":"character-a"'));
assert(groupWhere.includes('"externalConversationId":"g:123456789"'));
assert(groupWhere.includes('"platform":"qq-onebot"'));
const privateWhere = ownerHistoryConversationWhere({ characterId: "character-a", bindingId: "binding-a", privateScopeId: "owner-private", conversationId: "private-a", ownerUid: "111111111" });
assert.equal(privateWhere.memoryScopeId, "owner-private");
assert.equal(privateWhere.externalConversationId, "c:111111111");
assert.equal(privateWhere.channelBindingId, "binding-a");

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const row = (n: number, minute: number, role: string, content: string, uid = "person-a"): OwnerHistoryRow => ({
  id: uuid(n), conversationId: "group-a", externalMessageId: `external-${n}`, role, content,
  occurredAt: new Date(beforeMidnight.getTime()-10*60_000+minute*60_000),
  metadata: { authorOpenId: uid, authorDisplayName: uid === "person-a" ? "某位群友" : "另一位群友" },
});
const history: OwnerHistoryRow[] = [row(1,0,"USER","我们可以做朋友吗"), row(2,0.2,"ASSISTANT","可以，我们先聊聊"),
  ...Array.from({length:30},(_,i)=>row(10+i,0.3+i/100,"USER","不相关的讨论", "other")),
  row(3,1,"USER","我是说特别要好的好朋友"), row(4,1.2,"ASSISTANT","原来是好朋友，这个可以"),
  row(5,2,"USER","那你喜欢我吗"), row(6,2.2,"ASSISTANT","当朋友我愿意")];
const plan: OwnerHistoryPlan = { ...initial, participantName: "某位群友", query: "某位群友问喜不喜欢，后来解释哪一种", evidenceIds: [] };
const bundle = selectOwnerHistoryEvidence(history, plan, ["person-a"]);
assert(bundle.some(x=>x.id===uuid(3)), "Keep the participant clarification through noisy intervening chat");
assert(bundle.some(x=>x.id===uuid(4)), "Keep the assistant answer, not just the question");
assert(!bundle.some(x=>x.content==="不相关的讨论"));
assert.equal(selectOwnerHistoryEvidence(history, plan, []).length,0,"Ambiguous or missing identity must fail closed");
const queries: unknown[] = [];
const corpus = [...history, ...Array.from({length:1000},(_,i)=>row(300+i,0.25+i/2000,"USER","热群无关消息","other"))];
const matches = (row: OwnerHistoryRow, predicate: Record<string,unknown>): boolean => {
 if (Array.isArray(predicate.AND) && !predicate.AND.every(p=>matches(row,p))) return false;
 if (Array.isArray(predicate.OR) && !predicate.OR.some(p=>matches(row,p))) return false;
 if (typeof predicate.role === "string" && row.role !== predicate.role) return false;
 if (typeof predicate.conversationId === "string" && row.conversationId !== predicate.conversationId) return false;
 const id = predicate.id as {lt?:string;in?:string[]} | undefined;
 if (id && ((id.lt && row.id >= id.lt) || (id.in && !id.in.includes(row.id)))) return false;
 if (typeof predicate.id === "string" && row.id !== predicate.id) return false;
 const roles = predicate.role as {in?:string[]} | undefined;
 if (roles?.in && !roles.in.includes(row.role)) return false;
 const conversation = predicate.conversation as Record<string,unknown> | undefined;
 if (conversation?.externalConversationId && typeof conversation.externalConversationId === "string"
   && (row.conversation?.externalConversationId ?? "g:123456789") !== conversation.externalConversationId) return false;
 const time = predicate.occurredAt as Record<string,Date> | undefined;
 if (predicate.occurredAt instanceof Date && row.occurredAt.getTime() !== predicate.occurredAt.getTime()) return false;
 if (time && ((time.gte && row.occurredAt < time.gte) || (time.lte && row.occurredAt > time.lte) || (time.lt && row.occurredAt >= time.lt))) return false;
 const metadata = predicate.metadata as {path:string[];equals:string} | undefined;
 if (metadata && (row.metadata as Record<string,unknown>)[metadata.path[0]!] !== metadata.equals) return false;
 const content = predicate.content as {contains:string} | undefined;
 if (content && !row.content.includes(content.contains)) return false;
 return true;
};
const db = { message: { findMany: async (args: {where:Record<string,unknown>;orderBy:Array<Record<string,string>>;take:number}) => {
 queries.push(args);
 return corpus.filter(row=>matches(row,args.where)).sort((a,b)=>(a.occurredAt.getTime()-b.occurredAt.getTime() || a.id.localeCompare(b.id))*(args.orderBy[0]?.occurredAt==="desc"?-1:1)).slice(0,args.take);
}, count: async (args:{where:Record<string,unknown>}) => { queries.push(args);return corpus.filter(row=>matches(row,args.where)).length; } } } as unknown as Pick<PrismaClient,"message">;
const loadedBundle = await loadOwnerHistoryEvidence(db,"character-a",plan,["person-a"]);
assert(loadedBundle.some(x=>x.id===uuid(3)) && loadedBundle.some(x=>x.id===uuid(4)),"Executing role/time/order/take filters must preserve clarification and answer despite a thousand intervening messages");
assert(queries.length>=2);
for(const query of queries) {
 const text = JSON.stringify(query);
 assert(text.includes('"characterId":"character-a"'));
 assert(text.includes('"g:123456789"'));
 assert(text.includes('"platform":"qq-onebot"'));
 assert(text.includes('"lt"'),"All reads retain a bounded upper time or cursor predicate");
 if (text.includes('"take":1') && !text.includes('"gte"')) assert(text.includes('"role":"USER"'),"Earlier existence probes keep authorized target filtering");
}

assert.equal(planOwnerHistory("他后来怎么说", initial, new Date(beforeMidnight.getTime()+OWNER_HISTORY_TTL_MS), "Asia/Shanghai"),null);
assert.equal(planOwnerHistory("查询这个群的聊天记录",initial,beforeMidnight,"Asia/Shanghai")?.participantName,undefined);
assert.equal(planOwnerHistory("好哦，我去看看，小宝继续聊天吧",initial,beforeMidnight,"Asia/Shanghai"),null);
assert.equal(planOwnerHistory("987654321",initial,beforeMidnight,"Asia/Shanghai")?.groupId,"987654321");
assert.equal(planOwnerHistory("987654321",null,beforeMidnight,"Asia/Shanghai"),null);
const auth = { characterId:"character-a",bindingId:"binding-a",privateScopeId:"owner-private",conversationId:"private-a",ownerUid:"111111111" };
let saved: Record<string,unknown> | undefined;
const storage = { conversation: {
 findFirst: async (args: unknown) => { assert(JSON.stringify(args).includes('"c:111111111"')); return {metadata:{unrelated:"preserve",ownerHistoryContext:initial},updatedAt:beforeMidnight}; },
 updateMany: async (args: unknown) => { saved=args as Record<string,unknown>; return {count:1}; },
}, $transaction: async (run: (tx:unknown)=>Promise<boolean>) => run(storage) } as unknown as PrismaClient;
const stored = await loadOwnerHistoryContext(storage,auth,beforeMidnight);
assert.equal(stored?.plan?.groupId,initial.groupId);
assert.equal(await saveOwnerHistoryContext(storage,auth,stored!.historyContext,followup),true);
const serialized = JSON.stringify(saved);
assert(serialized.includes('"equals":{"unrelated":"preserve"'),"Write must compare original metadata before merging");
assert(serialized.includes('"unrelated":"preserve"'));
assert(!serialized.includes("特别要好的好朋友"),"Continuity stores IDs and query conditions, not copied chat text");
const rejectedStorage = { conversation:{findFirst:async()=>null} } as unknown as PrismaClient;
assert.equal(await loadOwnerHistoryContext(rejectedStorage,auth,beforeMidnight),null);

const base = { characterName:"测试角色", characterPrompt:"简洁回答。", model:"test-chat", apiKey:"test-only", apiBaseUrl:"https://model.invalid/v1", currentMessage:"读取群里那段记录", recentMessages:[], memories:[], snapshots:[], speaker:{isOwner:true}, readOnlyTools:{searchMemory:async()=>[]} };
const earlierNow = new Date("2026-11-17T18:25:00Z");
const recentPlan = planOwnerHistory("现在看看能获取群聊消息了吗",null,earlierNow,"Asia/Shanghai")!;
assert(recentPlan);
const earlier = planOwnerHistory("123456789 那边只能到 00:30 前后吗，更早的到不了了？",recentPlan,new Date(earlierNow.getTime()+1000),"Asia/Shanghai")!;
assert(earlier); assert.equal(earlier.groupId,"123456789");
assert.equal(earlier.end,recentPlan.end);
assert.equal(earlier.start,recentPlan.start,"Planning earlier does not skip unsampled records within the current range");
assert.equal(earlier.direction,"earlier");
assert.equal(earlier.anchoredAt,recentPlan.anchoredAt);
for(const message of ["再往前查", "之前的呢", "更早还能找到吗"]) {
 const next=planOwnerHistory(message,earlier,new Date(earlierNow.getTime()+2000),"Asia/Shanghai")!;
 assert.equal(next.groupId,earlier.groupId); assert.equal(next.end,earlier.end); assert.equal(next.direction,"earlier");
}
const onlyRoom=planOwnerHistory("123456789 那边只能到00:30前后吗",recentPlan,new Date(earlierNow.getTime()+1000),"Asia/Shanghai")!;
assert.equal(onlyRoom.start,recentPlan.start);
assert.equal(onlyRoom.groupId,"123456789");
const olderRow={...row(2000,0,"USER","更早的群讨论原文"),occurredAt:new Date(Date.parse(recentPlan.start)-3_600_000)};
corpus.push(olderRow);
const earlierSources=await loadOwnerHistoryEvidence(db,"character-a",earlier,[]);
assert(earlierSources.some(source=>source.id===olderRow.id),"Expanded frozen page must actually retrieve evidence outside the original two-hour window");
assert(earlierSources.every(source=>Date.parse(source.occurredAt!)<Date.parse(recentPlan.start)));
// A summary writer can win once without losing the history task or being overwritten.
let currentMetadata:Record<string,unknown>={ownerHistoryContext:initial,continuitySummary:"new summary"};
let races=0;
const concurrent={conversation:{
 findFirst:async()=>({metadata:structuredClone(currentMetadata)}),
 updateMany:async(args:{where:{metadata:{equals:unknown}};data:{metadata:Record<string,unknown>}})=>{
  if(races++===0){currentMetadata.continuitySummary="newer summary";return {count:0};}
  assert.deepEqual(args.where.metadata.equals,currentMetadata);currentMetadata=args.data.metadata;return {count:1};
 },
},$transaction:async(run:(tx:unknown)=>Promise<unknown>)=>run(concurrent)} as unknown as PrismaClient;
assert.equal(await saveOwnerHistoryContext(concurrent,auth,initial,followup),true);
assert.equal(currentMetadata.continuitySummary,"newer summary");
assert.equal(races,2,"Only one retry is allowed for unrelated metadata conflict");
assert.equal(await saveOwnerHistoryContext(concurrent,auth,initial,earlier),false,"Stale history task must not replace a newer history update");
// Explicit time must not cancel chronological direction: earliest evening evidence is reachable.
const eveningQuestion = { ...row(3000,0,"USER","晚间最早的问题"), occurredAt:new Date("2026-11-17T14:41:00Z") };
const eveningAnswer = { ...row(3001,0,"ASSISTANT","晚间问题的回答"), occurredAt:new Date("2026-11-17T14:41:30Z") };
const lateQuestion = { ...row(3002,0,"USER","零点后的问题"), occurredAt:new Date("2026-11-17T16:16:00Z") };
const lateAnswer = { ...row(3003,0,"ASSISTANT","零点后的回答"), occurredAt:new Date("2026-11-17T16:16:30Z") };
corpus.push(eveningQuestion,eveningAnswer,lateQuestion,lateAnswer);
const tonightEarlier = planOwnerHistory("查一下今晚那个群更早的聊天记录",{...recentPlan,groupId:"123456789"},earlierNow,"Asia/Shanghai")!;
assert.equal(tonightEarlier.direction,"earlier");
assert.equal(tonightEarlier.start,"2026-11-17T10:00:00.000Z");
const eveningPage = await loadOwnerHistoryPage(db,"character-a",tonightEarlier,[]);
assert(eveningPage.sources.some(source=>source.id===eveningQuestion.id));
assert(eveningPage.sources.some(source=>source.id===eveningAnswer.id),"An early page preserves its answer despite a thousand unrelated later messages");
assert.equal(eveningPage.coverage.actualFirst,eveningQuestion.occurredAt.toISOString());
assert.equal(eveningPage.coverage.actualLast,lateAnswer.occurredAt.toISOString());
assert.equal(eveningPage.coverage.count,corpus.filter(item=>item.occurredAt>=new Date(tonightEarlier.start)&&item.occurredAt<new Date(tonightEarlier.end)).length);
assert.equal(eveningPage.coverage.sampledFirst,eveningQuestion.occurredAt.toISOString());
assert.equal(eveningPage.coverage.truncated,true);
assert.equal(eveningPage.coverage.hasEarlier,false);
const assistantOnlyPlan = {...tonightEarlier,start:lateAnswer.occurredAt.toISOString(),end:new Date(lateAnswer.occurredAt.getTime()+1000).toISOString()};
const assistantOnlyPage = await loadOwnerHistoryPage(db,"character-a",assistantOnlyPlan,[]);
assert.equal(assistantOnlyPage.sources[0]?.id,lateAnswer.id,"An assistant-only page is real evidence, not an empty range to skip");
assert.equal(assistantOnlyPage.coverage.start,assistantOnlyPlan.start);
const latestPage = await loadOwnerHistoryPage(db,"character-a",{...tonightEarlier,direction:"latest",query:"群里聊天记录"},[]);
assert(latestPage.coverage.oldestCursor);
assert.equal(latestPage.coverage.hasEarlier,true,"Existence query sees older records outside the sampled bundle");
const priorPlan = planOwnerHistory("再往前查",{...tonightEarlier,direction:"latest",cursor:latestPage.coverage.oldestCursor},earlierNow,"Asia/Shanghai")!;
assert.equal(priorPlan.start,tonightEarlier.start);
const priorPage = await loadOwnerHistoryPage(db,"character-a",priorPlan,[]);
assert(priorPage.sources.length>0,"A preceding page is loaded before moving the range back a day");
assert.equal(priorPage.coverage.start,tonightEarlier.start);
assert(priorPage.sources.every(source=>Date.parse(source.occurredAt!)<=Date.parse(latestPage.coverage.oldestCursor!.occurredAt)));
assert.equal(readOwnerHistoryPlan({...tonightEarlier,direction:"bad"},earlierNow),null);
assert.equal(readOwnerHistoryPlan({...tonightEarlier,cursor:{id:"bad",occurredAt:earlierNow.toISOString()}},earlierNow),null);
// Simulate the persisted JSON loaded by a fresh adapter process: coverage dates and
// cursor are strings, not in-memory Dates. Retrying must preserve this exact page.
const restartNow = new Date("2026-11-17T18:59:00Z");
const persistedEarlier: OwnerHistoryPlan = JSON.parse(JSON.stringify({
 ...tonightEarlier, groupId: "123456789", anchoredAt: "2026-11-17T18:54:00.000Z",
 start: eveningPage.coverage.start, end: eveningPage.coverage.end,
 direction: "earlier", cursor: latestPage.coverage.oldestCursor,
 evidenceIds: latestPage.sources.map(source => source.id),
}));
const rehydratedEarlier = readOwnerHistoryPlan(persistedEarlier, restartNow);
assert(rehydratedEarlier, "Persisted coverage dates and UUID cursor survive adapter restart");
let retryNow: OwnerHistoryPlan | null = null;
for (const message of ["现在呢", "还是呢？", "再看看", "再试试！"]) {
 const retry = planOwnerHistory(message, rehydratedEarlier, restartNow, "Asia/Shanghai");
 assert(retry, "A short retry must continue a live earlier-history task");
 assert.equal(retry.groupId, persistedEarlier.groupId);
 assert.equal(retry.start, persistedEarlier.start); assert.equal(retry.end, persistedEarlier.end);
 assert.equal(retry.direction, "earlier"); assert.equal(retry.cursor, undefined,
  "A bare retry re-reads the same page instead of silently moving the window backwards");
 assert.deepEqual(retry.evidenceIds, persistedEarlier.evidenceIds);
 assert.equal(retry.anchoredAt, persistedEarlier.anchoredAt, "A retry cannot extend the TTL");
 assert.equal(planOwnerHistory(message, null, restartNow, "Asia/Shanghai"), null);
 assert.equal(planOwnerHistory(message, {...persistedEarlier,direction:"latest"}, restartNow, "Asia/Shanghai"), null);
 assert.equal(planOwnerHistory(message, {...persistedEarlier,anchoredAt:"2026-11-17T18:37:00.000Z"}, restartNow, "Asia/Shanghai"), null,
  "A process restart cannot resurrect an already expired history task");
}
retryNow = planOwnerHistory("现在呢", {...tonightEarlier,direction:"earlier",anchoredAt:restartNow.toISOString()}, restartNow, "Asia/Shanghai");
assert(retryNow, "A live earlier task re-reads its own page on a bare retry");
assert.equal(retryNow.cursor, undefined, "Re-reading must not advance the window");
assert.equal(planOwnerHistory("现在呢今天吃什么", persistedEarlier, restartNow, "Asia/Shanghai"), null,
 "Only the complete short retry utterance is recognized");
const originalFetch = globalThis.fetch;
let calls=0,loaded=0;
const details: TurnDetailPatch[]=[];
const context = createAssistantTurnContext({turnId:uuid(200),identity:{characterId:uuid(201),channel:"qq-private",channelBindingId:uuid(202),conversationKey:"c:111111111",readableScopeIds:[uuid(203)],allowPrivate:true},evidenceIds:[]});
try {
 let retryLoaded = false;
 globalThis.fetch = async (_url, init) => {
  assert(retryLoaded, "The short retry must query history before response generation");
  assert(JSON.stringify(JSON.parse(String(init?.body)).messages).includes("不完整检索片段"));
  return Response.json({choices:[{message:{content:JSON.stringify({reply:"我重新查了这一页。"})},finish_reason:"stop"}]});
 };
 const retryResult = await generateConversationReplyWithMemoryAssistant({
  chatInput:{...base,currentMessage:"现在呢"},assistant:null,candidates:[],
  requiredHistoryLookup:{query:retryNow!.query,load:async()=>{retryLoaded=true;return loadOwnerHistoryPage(db,"character-a",retryNow!,[]);}},
 });
 assert(retryLoaded); assert.equal(retryResult.memoryAssistantStatus,"success");
 let earlierLoaded=false;
 globalThis.fetch=async(_url,init)=>{
  assert(earlierLoaded,"Earlier follow-up must query before generation");
  const actualPrompt=JSON.stringify(JSON.parse(String(init?.body)).messages);
  assert(actualPrompt.includes("晚间最早的问题") && actualPrompt.includes("晚间问题的回答"),"Tonight-earlier question and answer both reach the actual generation request");
  return Response.json({choices:[{message:{content:JSON.stringify({reply:"我查到了更早的一段，但不能据此断言最早边界。"})},finish_reason:"stop"}]});
 };
 const earlierResult=await generateConversationReplyWithMemoryAssistant({chatInput:{...base,currentMessage:tonightEarlier.query},assistant:null,candidates:[],requiredHistoryLookup:{query:tonightEarlier.query},loadCandidates:async()=>{earlierLoaded=true;return loadOwnerHistoryEvidence(db,"character-a",tonightEarlier,[]);}});
 assert.equal(earlierResult.memoryAssistantStatus,"success");
 globalThis.fetch = async (_url,init) => {
  calls++; assert.equal(loaded,1,"SQL lookup must execute before the first generation even on the tools path");
  const body = JSON.parse(String(init?.body));
  const prompt = JSON.stringify(body.messages);
  assert(prompt.includes("特别要好的好朋友") && prompt.includes("原来是好朋友"),"Whole exchange reaches actual generation prompt");
  return Response.json({model:"test-chat",choices:[{message:{content:JSON.stringify({reply:"他说的是朋友。",usedRawMessageIds:[uuid(3),uuid(4),"invented"]})},finish_reason:"stop"}]});
 };
 const result = await generateConversationReplyWithMemoryAssistant({turnContext:context,chatInput:base,assistant:null,candidates:[],requiredHistoryLookup:{query:plan.query},loadCandidates:async()=>{loaded++;return bundle;},onTurnDetail:detail=>details.push(detail)});
 assert.equal(calls,1); assert.equal(loaded,1); assert.equal(result.memoryAssistantStatus,"success");
 assert.deepEqual(result.usedRawMessageIds,[uuid(3),uuid(4)]);
 assert.equal(details.at(-1)?.memory?.status,"success");
 assert.equal(context.snapshot().stages.find(x=>x.stage==="memory")?.logicalCalls,1);
 for(const failure of [false,true]) {
  const result = await generateConversationReplyWithMemoryAssistant({chatInput:base,assistant:null,candidates:[],requiredHistoryLookup:{query:plan.query},loadCandidates:async()=>{if(failure)throw new Error("offline database failure");return [];}});
  assert.equal(result.memoryAssistantStatus,failure?"failed":"no_sources");
  assert.equal(result.localHistoryReceipt,true); assert.equal(result.model,"local-history-lookup");
  assert(result.reply.includes(failure?"没成功":"指定范围"));
 }
 assert.equal(calls,1,"No-result and failure use truthful receipts without speculative generation");
 for(const chatInput of [{...base,speaker:{isOwner:false}},{...base,groupChat:true}]) {
  let leaked=false;
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify({reply:"普通回复"})},finish_reason:"stop"}]});
  await generateConversationReplyWithMemoryAssistant({chatInput,assistant:null,candidates:[],requiredHistoryLookup:{query:plan.query},loadCandidates:async()=>{leaked=true;return bundle;}});
  assert.equal(leaked,false,"Non-owner and group turns cannot enter the required owner lookup");
 }
} finally {globalThis.fetch=originalFetch;}
console.log("owner private history offline regressions passed");
