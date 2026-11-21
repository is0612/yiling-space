import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolveOnebotGroupQuote, resolveOnebotGroupQuotes, resolveOnebotEvent, type OnebotResolvedEvent, type OnebotGroupQuote } from "../server/utils/channel-adapter/onebot/client";
import { createGroupContext } from "../server/utils/channel-adapter/onebot/group-context";
import { generateConversationReply } from "../server/utils/chat-reply";

const SELF = "999999999", ROOM = "123456789", AUTHOR = "111111111", BLOCKED = "222222222";
const payloads = new Map<string, unknown>();
const calls: string[] = [];
const server = createServer(async (req, res) => {
  assert.equal(req.url, "/get_msg", "Quote reads must not send any messages");
  let text = ""; for await (const part of req) text += part;
  const id = String(JSON.parse(text).message_id); calls.push(id);
  if (id === "-99") return; // Deliberately never answer; client must abort promptly.
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ retcode: 0, data: payloads.get(id) }));
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert(address && typeof address !== "string");
const config = { wsUrl: "", httpUrl: `http://127.0.0.1:${address.port}` };
function event(messageId: string, quote?: string): OnebotResolvedEvent {
  const resolved = resolveOnebotEvent({ post_type: "message", message_type: "group", group_id: Number(ROOM), self_id: Number(SELF),
    message_id: Number(messageId), user_id: Number(AUTHOR), sender: { user_id: Number(AUTHOR), nickname: "群友" },
    message: [...(quote ? [{ type: "reply", data: { id: quote } }] : []), { type: "text", data: { text: "接这一句" } }],
  });
  assert(resolved); return resolved;
}
function message(id: string, author = SELF, content = "自己发出的单条原文") {
  return { message_id: Number(id), message_type: "group", group_id: Number(ROOM),
    sender: { user_id: Number(author), nickname: author === SELF ? "角色" : "群友甲" },
    message: [{ type: "text", data: { text: content } }],
  };
}
let now = 1_000_000;
const context = createGroupContext({ selfQq: SELF, now: () => now });
const key = `binding:g:${ROOM}`;
const options = {
  cached: (id: string): OnebotGroupQuote | undefined => {
    const q = context.quoteOf(key, id);
    return q ? { messageId: q.id, authorQq: q.authorQq, speaker: q.speaker, content: q.text, isSelf: q.isSelf } : undefined;
  },
  canReadAuthor: (id: string) => id !== BLOCKED,
  formatText: (text: string) => context.formatText(key, text),
  memberCode: (id: string) => id === SELF ? "self" : context.memberCode(key, id),
  remember: (id: string, quote: OnebotGroupQuote & {member?:string}) => context.rememberQuote(key, id, {
    id: quote.messageId, text: quote.content, member: quote.member, speaker: quote.speaker, authorQq: quote.authorQq, isSelf: quote.isSelf,
  }),
  timeoutMs: 80,
};
function remember(e: OnebotResolvedEvent) {
  context.remember(key, { messageId: e.messageId, at: now, senderQq: e.userId, displayName: e.displayName, text: e.content,
    mentionTargets: [], replyToMessageId: String((e.data as {message:Array<{type:string;data:{id?:string}}>}).message.find(s=>s.type==="reply")?.data.id??"") });
}
try {
  payloads.set("-123", message("-123"));
  const ownEvent = event("1", "-123"); remember(ownEvent);
  const own = await resolveOnebotGroupQuotes(config, [ownEvent], options);
  assert.equal(own.get("1")?.isSelf, true);
  assert.equal(own.get("1")?.member, "self");
  assert.equal(own.get("1")?.content, "自己发出的单条原文");
  assert.equal(own.get("1")?.speaker, "角色");
  assert(!JSON.stringify(own.get("1")).includes(SELF), "Internal platform IDs never enter the quote for the pipeline");
  assert.equal(context.background(key, []).find(row => row.id === "1")?.quoted?.isSelf, true);

  payloads.set("-124", message("-124", AUTHOR, `你好 @${SELF}`));
  const other = await resolveOnebotGroupQuotes(config, [event("2", "-124")], options);
  assert.equal(other.get("2")?.isSelf, false);
  assert.equal(other.get("2")?.content, "你好 @self");

  // Old/outside the window targets can be resolved through the same-group gateway read.
  context.remember(key, { messageId:"-125", senderQq:AUTHOR,displayName:"甲",text:"窗口原文",at:now,mentionTargets:[],replyToMessageId:"" });
  const before = calls.length;
  const cached = await resolveOnebotGroupQuotes(config, [event("3", "-125")], options);
  assert.equal(cached.get("3")?.content, "窗口原文"); assert.equal(calls.length,before);
  now += 6*60_000; payloads.set("-125", message("-125", AUTHOR, "过期后的网关原文"));
  assert.equal((await resolveOnebotGroupQuotes(config,[event("4","-125")],options)).get("4")?.content,"过期后的网关原文");

  for (const bad of [
    {...message("-123"),group_id:987654321}, {...message("-123"),message_type:"private"},
    {...message("-123"),message_id:-999}, {...message("-123"),sender:{}},
    {...message("-123"),user_id:Number(AUTHOR)}, {...message("-123"),group_id:undefined},
  ]) {
    payloads.set("-123",bad);
    assert.deepEqual(await resolveOnebotGroupQuote(config,ownEvent),{messageId:"-123"},"An unverified quote must retain only its ID, not falsely isSelf:false");
  }
  assert.equal(await resolveOnebotGroupQuote(config,{...ownEvent,messageType:"private"}),undefined);
  assert.deepEqual(await resolveOnebotGroupQuote(config,{...ownEvent,selfId:""}),{messageId:"-123"});
  const started=Date.now();
  assert.deepEqual(await resolveOnebotGroupQuote(config,event("5","-99"),{timeoutMs:50}),{messageId:"-99"});
  assert(Date.now()-started<1_000,"Timeout must not block a whole conversation indefinitely");

  payloads.set("-123",message("-123"));
  const batch=[event("10"),event("11"),event("12"),event("13"),event("14","-123"),event("15","-123"),
    ...["-201","-202","-203","-204"].map((id,i)=>event(String(16+i),id))];
  for(const id of ["-201","-202","-203","-204"])payloads.set(id,message(id,AUTHOR));
  const batchStart=calls.length;
  const bounded=await resolveOnebotGroupQuotes(config,batch,options);
  assert.equal(bounded.get("14")?.content,"自己发出的单条原文","The fifth batch item may be the first actual quote");
  assert.deepEqual(bounded.get("14"),bounded.get("15"));
  assert.equal(calls.length-batchStart,4,"At most four unique target reads, duplicates share one read");
  assert.deepEqual(bounded.get("19"),{messageId:"-204"},"A quote beyond the budget still preserves its reference ID");

  payloads.set("-300",message("-300",BLOCKED,"BLOCKED_PRIVATE_POLICY_TEXT"));
  const blocked=await resolveOnebotGroupQuotes(config,[event("20","-300")],options);
  assert.deepEqual(blocked.get("20"),{messageId:"-300"},"A blocked author cannot leak through a gateway quote");
  const cachedBlocked={messageId:"-301",authorQq:BLOCKED,content:"BLOCKED_CACHED_TEXT",isSelf:false};
  const noReadStart=calls.length;
  assert.deepEqual((await resolveOnebotGroupQuotes(config,[event("21","-301")],{...options,cached:()=>cachedBlocked})).get("21"),{messageId:"-301"});
  assert.equal(calls.length,noReadStart);
  const aiReadable = await resolveOnebotGroupQuotes(config,[event("23","-300")],{
    ...options,canReadAuthor:()=>true,authorPolicy:()=>({kind:"AI",policy:"BLOCK"}),
  });
  assert.equal(aiReadable.get("23")?.content,"BLOCKED_PRIVATE_POLICY_TEXT");
  assert.equal(aiReadable.get("23")?.kind,"AI");
  assert.equal(aiReadable.get("23")?.readOnly,true);
  assert.equal(aiReadable.get("23")?.excludeFromGrowth,true);
  const humanHidden = await resolveOnebotGroupQuotes(config,[event("24","-300")],{
    ...options,canReadAuthor:()=>true,authorPolicy:()=>({kind:"HUMAN",policy:"BLOCK"}),
  });
  assert.deepEqual(humanHidden.get("24"),{messageId:"-300"},"Read permission cannot expose explicitly blocked humans");
  const aiAllowed = await resolveOnebotGroupQuotes(config,[event("25","-300")],{
    ...options,canReadAuthor:()=>true,authorPolicy:()=>({kind:"AI",policy:"ALLOW"}),
  });
  assert.equal(aiAllowed.get("25")?.readOnly,undefined);
  assert.equal(aiAllowed.get("25")?.excludeFromGrowth,true,"AI ALLOW does not imply training permission");
  const inbound=event("22","-300");remember(inbound);
  context.rememberQuote(key,"22",{id:"-300",authorQq:BLOCKED,text:"BLOCKED_BACKGROUND_TEXT",isSelf:false});
  assert.deepEqual(context.background(key,[],undefined,new Set([BLOCKED])).find(row=>row.id==="22")?.quoted,{id:"-300"});

  const budgetContext=createGroupContext({selfQq:SELF,now:()=>now,maxChars:30});
  for(const n of [1,2]){
    budgetContext.remember("budget",{messageId:`budget-${n}`,at:now,senderQq:AUTHOR,displayName:"甲",text:"短句",mentionTargets:[],replyToMessageId:`quote-${n}`});
    budgetContext.rememberQuote("budget",`budget-${n}`,{id:`quote-${n}`,authorQq:AUTHOR,text:"正文".repeat(10),isSelf:false});
  }
  assert.equal(budgetContext.background("budget",[]).length,1,"Resolved quote text consumes the same background budget");

  // The resolved single original also reaches final group-request JSON, without raw QQ.
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      const prompt=JSON.stringify(body.messages);
      assert(prompt.includes("自己发出的单条原文"));assert(!prompt.includes(SELF));
      const data=JSON.parse(body.messages.find((m:{role:string})=>m.role==="user").content);
      assert.equal(data.transcript[0].quoted.isSelf,true);assert.equal(data.transcript[0].quoted.available,true);
      return Response.json({choices:[{message:{content:JSON.stringify({reply:"看到了，这是我那一句。"})},finish_reason:"stop"}]});
    };
    const q=own.get("1")!;
    await generateConversationReply({characterName:"角色",characterPrompt:"自然回答",model:"mock",apiKey:"test",apiBaseUrl:"https://model.invalid/v1",
      currentMessage:"你刚才这句",groupChat:true,recentMessages:[],memories:[],snapshots:[],transcript:[{id:"1",member:"member_1",speaker:"群友",content:"你刚才这句",
        quoted:{id:q.messageId,content:q.content,speaker:q.speaker,member:q.member,isSelf:q.isSelf}}]});
  }finally{globalThis.fetch=originalFetch;}
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
console.log("OneBot group quote inbound HTTP integration passed: self/other, old, group identity, policy, timeout, de-duplication and four-target budget; no real QQ or database.");
