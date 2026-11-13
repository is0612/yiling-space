import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { getPrisma } from "../server/utils/prisma";
import { archiveDuplicate, duplicateSelect, duplicateToken } from "../server/utils/memory-event-duplicates";
const source = new URL(process.env.DATABASE_URL!);
assert(["localhost","127.0.0.1","[::1]"].includes(source.hostname));
source.pathname="/postgres";
const name=`yiling_duplicates_test_${randomUUID().replaceAll("-","")}`;
assert(/^yiling_duplicates_test_[a-f0-9]{32}$/.test(name));
const target=new URL(source); target.pathname=`/${name}`;
const admin=new Client({connectionString:source.toString()}); await admin.connect();
let created=false;
try {
 await admin.query(`CREATE DATABASE "${name}"`); created=true;
 process.env.DATABASE_URL=target.toString();
 const result=spawnSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:process.env,stdio:"inherit"});
 assert.equal(result.status,0);
 const db=getPrisma();
 try {
 const owner=await db.user.create({data:{username:`test-${randomUUID()}`,passwordHash:"not-a-login-hash"}});
 const other=await db.user.create({data:{username:`test-${randomUUID()}`,passwordHash:"not-a-login-hash"}});
 const character=await db.character.create({data:{ownerId:owner.id,name:"隔离验证",basePrompt:"test"}});
 const scope=await db.memoryScope.create({data:{characterId:character.id,scopeType:"CHARACTER_GLOBAL",scopeKey:"global"}});
 const room=await db.conversation.create({data:{characterId:character.id,memoryScopeId:scope.id,title:"test"}});
 const base={memoryScopeId:scope.id,conversationId:room.id,dayKey:"2026-11-13",occurredAt:new Date(),title:"相同事件",detail:"相同详情"};
 const keep=await db.memoryEvent.create({data:{...base,dedupeKey:"a"},select:duplicateSelect});
 const candidate=await db.memoryEvent.create({data:{...base,dedupeKey:"b"},select:duplicateSelect});
 const input={ownerId:owner.id,characterId:character.id,keepId:keep.id,candidateId:candidate.id,token:duplicateToken(keep,candidate)};
 await assert.rejects(archiveDuplicate(db,{...input,ownerId:other.id}),{statusCode:404});
 await assert.rejects(archiveDuplicate(db,{...input,token:"0".repeat(64)}),{statusCode:409});
 const outcomes=await Promise.allSettled([archiveDuplicate(db,input),archiveDuplicate(db,input)]);
 assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
 assert.equal((await db.memoryEvent.findUniqueOrThrow({where:{id:keep.id}})).status,"ACTIVE");
 assert.equal((await db.memoryEvent.findUniqueOrThrow({where:{id:candidate.id}})).status,"ARCHIVED");
 assert.equal(await db.auditLog.count({where:{entityId:candidate.id,action:"memory.event_archived"}}),1);
 const privateScope=await db.memoryScope.create({data:{characterId:character.id,scopeType:"USER_PRIVATE",scopeKey:"other-private",userId:other.id}});
 const x=await db.memoryEvent.create({data:{...base,memoryScopeId:privateScope.id,conversationId:null,dedupeKey:"x"},select:duplicateSelect});
 const y=await db.memoryEvent.create({data:{...base,memoryScopeId:privateScope.id,conversationId:null,dedupeKey:"y"},select:duplicateSelect});
 await assert.rejects(archiveDuplicate(db,{...input,keepId:x.id,candidateId:y.id,token:duplicateToken(x,y)}),{statusCode:404});
 console.log("Isolated duplicate DB checks passed: authorization, stale token, concurrent submission, audit and preserved record.");
 } finally {await db.$disconnect();}
} finally {
 if(created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
 await admin.end();
}
