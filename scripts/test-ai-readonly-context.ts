import assert from "node:assert/strict";
import { shouldBlockFriendSpeaker, shouldHideFriendContent, isReadOnlyFriendContent } from "../server/utils/friend-chat-policy";
import { createGroupContext } from "../server/utils/channel-adapter/onebot/group-context";
for(const policy of ["DEFAULT","BLOCK"] as const){
 assert(shouldBlockFriendSpeaker("AI",policy),"AI read access never grants interaction");
 assert(!shouldHideFriendContent("AI",policy));
 assert(isReadOnlyFriendContent("AI",policy));
}
assert(shouldHideFriendContent("HUMAN","BLOCK"));assert(shouldHideFriendContent("UNKNOWN","BLOCK"));
assert(!shouldBlockFriendSpeaker("AI","ALLOW"));assert(!isReadOnlyFriendContent("AI","ALLOW"));
let now=100_000;const ctx=createGroupContext({selfQq:"999",now:()=>now});
ctx.remember("room",{messageId:"human",senderQq:"111",displayName:"真人",text:"做陶艺吗",at:now,mentionTargets:["self"],replyToMessageId:""});
ctx.recordReply("room",[{messageId:"human",senderQq:"111",displayName:"真人",text:"做陶艺吗",at:now,mentionTargets:["self"],replyToMessageId:""}],{source:"mention"});
ctx.remember("room",{messageId:"ai",senderQq:"222",displayName:"其他AI",text:"@111 主人，接着聊",at:now,mentionTargets:["other"],mentionQqs:["111"],replyToMessageId:"human",kind:"AI",readOnly:true,excludeFromGrowth:true});
assert(!ctx.addressedOtherWithin("room","222",now+1,120_000),"Read-only AI cannot seed addressed-to-other continuation");
assert(!ctx.members("room").some(row=>row.member===ctx.memberCode("room","222")),"Read-only AI cannot seed ownership");
const line=ctx.background("room",[]).find(row=>row.id==="ai")!;
assert.equal(line.kind,"AI");assert.equal(line.readOnly,true);assert.equal(line.excludeFromGrowth,true);
now+=1;
console.log("AI read-only context policy passed: interaction remains blocked, human BLOCK hidden, no ownership or continuation side effects.");
