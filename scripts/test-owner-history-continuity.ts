import assert from "node:assert/strict";
import type { PrismaClient } from "../src/generated/prisma/client";
import { applyOwnerHistoryIntent, loadOwnerHistoryPage, planOwnerHistory, readOwnerHistoryPlan, ownerHistoryTopicTerms, type OwnerHistoryRow } from "../server/utils/owner-private-history";
import { analyzeOwnerHistoryIntent, parseOwnerHistoryIntent, privateContextPurpose, type OwnerHistoryIntent } from "../server/utils/owner-history-intent";
import { generateConversationReplyWithMemoryAssistant } from "../server/utils/memory-assistant";
import { createAssistantTurnContext } from "../server/utils/assistant-turn-context";
import type { TurnDetailPatch } from "../server/utils/model-turn-detail";
import { normalizeOwnerHistoryTerms } from "../server/utils/owner-history-terms";
assert.deepEqual(normalizeOwnerHistoryTerms(["看看", "聊聊", "精确主题", "123456", "a"]), ["看看", "看", "聊聊", "聊", "精确主题"]);
assert.equal(normalizeOwnerHistoryTerms(Array.from({ length: 20 }, (_, i) => `主题${i}`)).length, 8);
assert(normalizeOwnerHistoryTerms(["看看"]).some(term => "看一下".includes(term)), "Reduplicated action retains a suffix-independent core");
assert.equal(privateContextPurpose(true, true), "history", "History intent and knowledge eligibility cannot consume two context operations");
assert.equal(privateContextPurpose(false, true), "knowledge", "Ordinary private knowledge analysis remains available");
assert.equal(privateContextPurpose(false, false), "none");
const now = new Date("2026-02-03T16:01:00Z");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const row = (n:number, at:string, content:string, role="USER", room="123456789", person="person-a"): OwnerHistoryRow => ({id:id(n), conversationId:room,externalMessageId:`e${n}`,role,content,occurredAt:new Date(at),metadata:{authorOpenId:person,authorDisplayName:person},conversation:{externalConversationId:`g:${room}`}});
const corpus = [row(1,"2026-02-03T12:00:00Z","最早的聊天"),row(2,"2026-02-03T12:00:10Z","最早回应","ASSISTANT"),
 row(3,"2026-02-03T15:20:00Z","一起学陶艺吗"),row(4,"2026-02-03T15:20:20Z","可以周末一起学陶艺","ASSISTANT"),
 ...Array.from({length:300},(_,i)=>row(20+i,"2026-02-03T15:20:15Z","无关聊天","USER","987654321","other"))];
function matches(r:OwnerHistoryRow,p:Record<string,unknown>):boolean {
 if(Array.isArray(p.AND)&&!p.AND.every(x=>matches(r,x)))return false;
 if(Array.isArray(p.OR)&&!p.OR.some(x=>matches(r,x)))return false;
 if(typeof p.role==="string"&&r.role!==p.role)return false;
 if(p.role&&typeof p.role==="object"&&!(p.role as {in:string[]}).in.includes(r.role))return false;
 if(typeof p.conversationId==="string"&&r.conversationId!==p.conversationId)return false;
 const c=p.conversation as {externalConversationId?:string|{startsWith:string}}|undefined;
 if(c?.externalConversationId&&typeof c.externalConversationId==="string"&&r.conversation?.externalConversationId!==c.externalConversationId)return false;
 const time=p.occurredAt as Record<string,Date>|Date|undefined;
 if(time instanceof Date&&r.occurredAt.getTime()!==time.getTime())return false;
 if(time&&!(time instanceof Date)&&((time.gte&&r.occurredAt<time.gte)||(time.lte&&r.occurredAt>time.lte)||(time.lt&&r.occurredAt>=time.lt)))return false;
 const text=p.content as {contains:string}|undefined;if(text&&!r.content.toLowerCase().includes(text.contains.toLowerCase()))return false;
 const meta=p.metadata as {path:string[];equals:string}|undefined;if(meta&&(r.metadata as Record<string,unknown>)[meta.path[0]!]!==meta.equals)return false;
 const ids=p.id as {in?:string[];lt?:string}|undefined;if(ids?.in&&!ids.in.includes(r.id))return false;if(ids?.lt&&r.id>=ids.lt)return false;
 return true;
}
let sqlReads=0;
const db={message:{findMany:async(a:{where:Record<string,unknown>;orderBy?:Array<Record<string,string>>;take:number})=>{sqlReads++;const query=JSON.stringify(a.where);assert(query.includes('"characterId":"character-a"'));assert(query.includes('"platform":"qq-onebot"'));return corpus.filter(r=>matches(r,a.where)).sort((a1,b)=>((a1.occurredAt.getTime()-b.occurredAt.getTime())||a1.id.localeCompare(b.id))*(a.orderBy?.[0]?.occurredAt==="desc"?-1:1)).slice(0,a.take);},count:async(a:{where:Record<string,unknown>})=>corpus.filter(r=>matches(r,a.where)).length}} as unknown as Pick<PrismaClient,"message">;
// The owner asks in the afternoon, then supplies only the requested group number.
const afternoon = new Date("2026-02-04T06:46:00Z");
const initialNight = planOwnerHistory("查一下昨晚那个群里，聊陶艺的那段", null, afternoon, "Asia/Shanghai")!;
assert.equal(initialNight.start, "2026-02-03T10:00:00.000Z");
assert.equal(initialNight.end, "2026-02-03T22:00:00.000Z");
const pendingNight = applyOwnerHistoryIntent(null, initialNight, { action: "topic", query: "陶艺邀请", keywords: ["陶艺"] }, "查昨晚群聊").plan!;
const firstRead = await loadOwnerHistoryPage(db, "character-a", pendingNight, []);
assert.equal(firstRead.coverage.reason, "unresolved_group");
const clarifiedNight = planOwnerHistory("123456789", pendingNight, new Date(afternoon.getTime() + 10_000), "Asia/Shanghai")!;
assert.deepEqual(clarifiedNight, { ...readOwnerHistoryPlan(pendingNight, afternoon), groupId: "123456789" }, "A bare group clarification must preserve all topic and time parameters");
corpus.push(row(8800, "2026-02-03T16:15:00Z", "陶艺课几点开始？"));
const nightPage = await loadOwnerHistoryPage(db, "character-a", clarifiedNight, []);
assert(nightPage.sources.some(source => source.id === id(8800)), "Last night includes records after midnight");
assert(nightPage.sources.some(source => source.id === id(4)), "Last night includes earlier evening replies");
const staleStart = "2026-02-04T04:46:00.000Z", staleEnd = afternoon.toISOString();
const staleNight = { ...clarifiedNight, anchoredAt: afternoon.toISOString(), start: staleStart, end: staleEnd,
  rootStart: staleStart, rootEnd: staleEnd, direction: "earlier" as const,
  cursor: { id: id(8800), occurredAt: staleStart }, evidenceIds: [id(8800)] };
const recheckAt = new Date(afternoon.getTime() + 30_000);
const dateRetry = planOwnerHistory("现在能查到昨晚的了吗", staleNight, recheckAt, "Asia/Shanghai")!;
assert.equal(dateRetry.groupId, staleNight.groupId);
assert.equal(dateRetry.query, staleNight.query);
assert.deepEqual(dateRetry.topicTerms, staleNight.topicTerms);
assert.deepEqual([dateRetry.start, dateRetry.end, dateRetry.rootStart, dateRetry.rootEnd],
  [initialNight.start, initialNight.end, initialNight.start, initialNight.end]);
assert.deepEqual(dateRetry.evidenceIds, []);
assert.equal(dateRetry.cursor, undefined);
const retriedPage = await loadOwnerHistoryPage(db, "character-a", dateRetry, []);
assert(retriedPage.sources.some(source => source.id === id(8800)));
const bareRetry = planOwnerHistory("现在呢", staleNight, recheckAt, "Asia/Shanghai")!;
assert.deepEqual([bareRetry.start, bareRetry.end], [staleStart, staleEnd]);
assert.equal(planOwnerHistory("现在能查到昨晚的了吗", null, recheckAt, "Asia/Shanghai"), null, "A date alone does not authorize searching a group");
corpus.push(row(8801, "2026-02-03T10:30:00Z", "我喜欢春天的花"),
  row(8802, "2026-02-03T16:16:00Z", "你喜不喜欢我呀"),
  row(8803, "2026-02-03T16:16:10Z", "你指哪一种？", "ASSISTANT"),
  row(8804, "2026-02-03T16:16:30Z", "我说的是好朋友"),
  row(8805, "2026-02-03T18:00:00Z", "你们喜欢什么天气"));
const exactQuestion = await loadOwnerHistoryPage(db, "character-a", {
  ...clarifiedNight, query: "有人问喜不喜欢他", topicTerms: ["喜欢"],
}, []);
assert(exactQuestion.sources.some(source => source.id === id(8802)), "The original question must survive common-word matches at both ends of the window");
assert(exactQuestion.sources.some(source => source.id === id(8804)), "Keep the speaker's clarification alongside the question");
corpus.splice(corpus.findIndex(item => item.id === id(8801)), 5);
const original=globalThis.fetch;
let semantic:OwnerHistoryIntent={action:"hold"},responseCalls=0;
const runtime={model:"mock-context",apiKey:"test-only",apiBaseUrl:"https://model.invalid/v1",temperature:0,maxInputTokens:8192,maxOutputTokens:1200};
try {
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.model==="mock-context")return Response.json({choices:[{message:{content:JSON.stringify(semantic)},finish_reason:"stop"}]});responseCalls++;const prompt=JSON.stringify(body.messages);assert(!prompt.includes("无关聊天"));return Response.json({choices:[{message:{content:JSON.stringify({reply:"已核对。"})},finish_reason:"stop"}]});};
 let state=planOwnerHistory("查今晚群123456789更早的记录",null,now,"Asia/Shanghai")!;
 state={...state,rootStart:state.start,rootEnd:state.end,mode:"page"};
 const page=await loadOwnerHistoryPage(db,"character-a",state,[]);assert(page.sources.some(s=>s.id===id(1)));
 state={...state,cursor:page.coverage.oldestCursor};
 semantic={action:"hold"};const held=applyOwnerHistoryIntent(state,null,await analyzeOwnerHistoryIntent(runtime,{message:"太好了，修好了",recent:[],previous:state},()=>{}),"太好了，修好了");
 assert.equal(held.lookup,false);assert.equal(held.plan,state,"Acknowledgement retains unfinished task");
 semantic={action:"boundary"};const boundary=applyOwnerHistoryIntent(held.plan,null,semantic,"能看到多早");assert(boundary.lookup);const stats=await loadOwnerHistoryPage(db,"character-a",boundary.plan!,[]);
 assert.equal(stats.sources.length,0);assert.equal(stats.coverage.actualFirst,"2026-02-03T12:00:00.000Z");assert.equal(stats.coverage.count,4);
 semantic={action:"topic",query:"陶艺",participantName:"person-a"};const topic=applyOwnerHistoryIntent({...state,start:"2026-02-02T10:00:00Z",end:state.start},null,semantic,"那个人邀请一起做陶艺的事");
 assert.equal(topic.plan!.mode,"topic");assert.equal(topic.plan!.cursor,undefined);assert.equal(topic.plan!.start,state.rootStart);
 const sources=await loadOwnerHistoryPage(db,"character-a",topic.plan!,["person-a"]);assert(sources.sources.some(s=>s.id===id(3)));assert(sources.sources.some(s=>s.id===id(4)));
 const base={characterName:"角色",characterPrompt:"简洁",model:"mock-response",apiKey:"test-only",apiBaseUrl:"https://model.invalid/v1",speaker:{isOwner:true},currentMessage:"那他想做什么",recentMessages:[],memories:[],snapshots:[]};
 const diagnostics: TurnDetailPatch[] = [];
 const turn = createAssistantTurnContext({ turnId: id(9000), identity: { characterId:id(9001), channel:"qq-private", channelBindingId:id(9002), conversationKey:"private-owner", readableScopeIds:[id(9003)],allowPrivate:true }, evidenceIds:[] });
 const result=await generateConversationReplyWithMemoryAssistant({turnContext:turn,chatInput:base,assistant:null,candidates:[],requiredHistoryLookup:{query:topic.plan!.query,mode:"topic",load:async()=>sources},onTurnDetail:detail=>diagnostics.push(detail)});assert.equal(result.memoryAssistantStatus,"success");
 assert.equal(diagnostics.at(-1)?.memory?.status,"success");
 assert(diagnostics.at(-1)?.memory?.sources?.some(source=>source.id===id(4)),"Answer evidence is visible in diagnostic sources");
 assert.equal(turn.snapshot().stages.find(stage=>stage.stage==="memory")?.logicalCalls,1);
 const referential=applyOwnerHistoryIntent(topic.plan,null,{action:"topic",query:"陶艺",participantName:"person-a"},base.currentMessage);assert.equal(referential.plan!.groupId,"123456789");
 const absent=await loadOwnerHistoryPage(db,"character-a",{...referential.plan!,query:"不存在的主题"},["person-a"]);assert.equal(absent.sources.length,0,"No keyword hit cannot become unrelated latest messages");
 const assistantTopic=await loadOwnerHistoryPage(db,"character-a",{...referential.plan!,participantName:undefined,query:"周末"},[]);
 assert(assistantTopic.sources.some(source=>source.id===id(4)),"A topic can match the character answer even if the user question lacks its wording");
 assert(assistantTopic.sources.some(source=>source.id===id(3)),"An assistant hit retains the nearby user question");
 corpus.push(row(4000,"2026-02-03T14:01:00Z","想请你抱一下"),row(4001,"2026-02-03T14:01:15Z","过来一下，轻一点","ASSISTANT"),
  row(4002,"2026-02-03T14:08:00Z","你喜欢我吗"),row(4003,"2026-02-03T14:08:15Z","先说明喜欢是哪一种","ASSISTANT"),
  row(4004,"2026-02-03T14:09:00Z","我的意思是好朋友"),row(4005,"2026-02-03T14:09:15Z","朋友可以一起玩","ASSISTANT"),
  ...Array.from({length:300},(_,i)=>row(5000+i,"2026-02-03T15:40:00Z","群里的消息记录和聊天历史内容","USER","123456789","person-a")));
 for(let i=0;i<8;i++) corpus.push(row(6000+i*2,`2026-02-03T14:${String(10+i*2).padStart(2,"0")}:00Z`,"你喜欢哪种朋友"),
  row(6001+i*2,`2026-02-03T14:${String(10+i*2).padStart(2,"0")}:20Z`,"先把朋友的意思说明白","ASSISTANT"));
 for(const item of corpus.filter(item=>Number(item.id.slice(-12))>=4000)) item.metadata={...item.metadata as Record<string,unknown>,authorOpenId:"person-b",authorDisplayName:"person-b"};
 const exactIntent=parseOwnerHistoryIntent(JSON.stringify({action:"topic",participantName:"person-b",query:"查询这个群当时说过的消息以及这一段发生的事情，先看此前聊天历史并把前面的情况放在一起理解，最后需要核实请求抱抱、喜欢、好朋友的问答",keywords:["拥抱","喜欢","好朋友"]}));
 const exactPlan=applyOwnerHistoryIntent(state,null,exactIntent,"他想表达什么").plan!;
 assert.deepEqual(ownerHistoryTopicTerms({...exactPlan,topicTerms:["person-b",...exactPlan.topicTerms!]}),["拥抱","喜欢","好朋友"],"Participant name is not a topic anchor budget consumer");
 assert.deepEqual(ownerHistoryTopicTerms(exactPlan),["拥抱","喜欢","好朋友"],"Precise terms at the end of a long query cannot be lost to generic ngrams or stopwords");
 const reloaded=readOwnerHistoryPlan(JSON.parse(JSON.stringify(exactPlan)),now)!;
 assert.deepEqual(reloaded.topicTerms,exactPlan.topicTerms);
 const exactPage=await loadOwnerHistoryPage(db,"character-a",reloaded,["person-b"]);
 for(const n of [4000,4001,4002,4003,4004,4005]) assert(exactPage.sources.some(source=>source.id===id(n)),"Specific questions, clarification and answers survive 300 later generic messages");
 assert(exactPage.sources.filter(source=>source.content?.includes("群里的消息记录")).length <= 1,"Only the single latest participant context anchor may contain generic noise");
 const exactDiagnostics: TurnDetailPatch[]=[];
 const exactResult=await generateConversationReplyWithMemoryAssistant({chatInput:{...base,currentMessage:"他这里指哪种喜欢"},assistant:null,candidates:[],requiredHistoryLookup:{query:reloaded.query,mode:"topic",load:async()=>exactPage},onTurnDetail:detail=>exactDiagnostics.push(detail)});
 assert.equal(exactResult.memoryAssistantStatus,"success");
 assert(exactDiagnostics.at(-1)?.memory?.sources?.some(source=>source.id===id(4004)),"Friend clarification reaches actual response diagnostics");
 assert(exactDiagnostics.at(-1)?.memory?.sources?.some(source=>source.id===id(4001)),"Earlier answer reaches actual response diagnostics");
 assert.deepEqual(parseOwnerHistoryIntent('{"action":"topic","keywords":["x","喜欢","喜欢","  好朋友  ",123,"12345"]}').keywords,["喜欢","好朋友"]);
 const before=sqlReads;const correction=applyOwnerHistoryIntent(referential.plan,null,{action:"hold"},"你这句表达太绕了");assert.equal(correction.lookup,false);assert.equal(sqlReads,before);
 await generateConversationReplyWithMemoryAssistant({chatInput:{...base,currentMessage:"这句表达太绕了"},assistant:null,candidates:[],suppressHistoryLookup:true});assert.equal(sqlReads,before,"Expression correction never invokes history loader");
 assert.equal(responseCalls,3);
 assert.throws(()=>parseOwnerHistoryIntent('{"action":"delete"}'));
 const clear=applyOwnerHistoryIntent(state,null,{action:"clear"},"不查了");assert.equal(clear.plan,null);
} finally {globalThis.fetch=original;}
console.log("Owner history continuity sequence passed (semantic/model/SQL mocks only).");
