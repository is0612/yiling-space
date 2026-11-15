import assert from "node:assert/strict";
import {
  isGroupKnowledgeSource,
  isPrivateKnowledgeSource,
  readKnowledgeCollectScope,
} from "../server/utils/knowledge-collect-policy";
import { readKnowledgeAssistantSettingsPatch } from "../server/utils/knowledge-assistant-config";
import { toCharacterDto } from "../server/utils/character-dto";

/**
 * 「收谁的聊天」要么不判、要么按账号判。
 * 这里盯三件事：缺省必须还是 ALL（老角色升级后行为不能变）、主人永远算来源、
 * 判不出来必须 fail-closed。
 */

// —— 读范围：没有这个键 / 值不合法，一律回到 ALL ——
assert.equal(readKnowledgeCollectScope({}), "ALL");
assert.equal(readKnowledgeCollectScope(undefined), "ALL");
assert.equal(readKnowledgeCollectScope(null), "ALL");
assert.equal(readKnowledgeCollectScope([]), "ALL");
assert.equal(readKnowledgeCollectScope({ knowledgeCollectScope: "SELECTED" }), "SELECTED");
assert.equal(readKnowledgeCollectScope({ knowledgeCollectScope: "ALL" }), "ALL");
assert.equal(readKnowledgeCollectScope({ knowledgeCollectScope: "SOMEONE" }), "ALL");

// —— 配置校验：只认这两个值，写库前就拦住 ——
assert.equal(readKnowledgeAssistantSettingsPatch({ knowledgeCollectScope: "SELECTED" }).config.knowledgeCollectScope, "SELECTED");
assert.throws(() => readKnowledgeAssistantSettingsPatch({ knowledgeCollectScope: "EVERYBODY" }));
assert.throws(() => readKnowledgeAssistantSettingsPatch({ knowledgeCollectScope: 1 }));

// —— DTO：缺省补 ALL，配了照原样回 ——
const record = { id: "test", name: "角色", avatar: null, basePrompt: "", styleExamples: "", userAddress: "", status: "ACTIVE" as const, modelConfig: {}, updatedAt: new Date(), memorySetting: null, channelBindings: [], memoryScopes: [] };
assert.equal(toCharacterDto(record).knowledgeCollectScope, "ALL");
assert.equal(toCharacterDto({ ...record, modelConfig: { knowledgeCollectScope: "SELECTED" } }).knowledgeCollectScope, "SELECTED");
assert.equal(toCharacterDto({ ...record, modelConfig: { knowledgeCollectScope: "WHATEVER" } }).knowledgeCollectScope, "ALL");

/** 只回放我们要的行，并记下被问了几次 —— 「ALL 模式一次都不查库」本身是契约。 */
function fakePrisma(row: Record<string, unknown> | null) {
  const state = { calls: 0, lastArgs: undefined as unknown };
  return {
    state,
    client: {
      memoryScope: {
        findFirst: async (args: unknown) => {
          state.calls += 1;
          state.lastArgs = args;
          return row;
        },
      },
    },
  };
}
type PrivateDeps = Parameters<typeof isPrivateKnowledgeSource>[0];
type GroupDeps = Parameters<typeof isGroupKnowledgeSource>[0];

// —— 私聊 ——
{
  const { state, client } = fakePrisma({ knowledgeCollectEnabled: false });
  assert.equal(await isPrivateKnowledgeSource(client as unknown as PrivateDeps, {
    characterId: "c1", memoryScopeId: "s1", isOwnerTurn: false, scope: "ALL",
  }), true);
  assert.equal(state.calls, 0, "ALL 模式不该为白名单多查一次库");
}
{
  // 主人的私聊挂 USER_PRIVATE 范围，那一行取 knowledgeCollectEnabled 只会是 false；
  // 按列判会把最该记住的人挡在外面，所以这里必须直接放行。
  const { state, client } = fakePrisma(null);
  assert.equal(await isPrivateKnowledgeSource(client as unknown as PrivateDeps, {
    characterId: "c1", memoryScopeId: "owner-scope", isOwnerTurn: true, scope: "SELECTED",
  }), true);
  assert.equal(state.calls, 0, "主人不需要查白名单");
}
{
  const { client } = fakePrisma({ knowledgeCollectEnabled: true });
  assert.equal(await isPrivateKnowledgeSource(client as unknown as PrivateDeps, {
    characterId: "c1", memoryScopeId: "s1", isOwnerTurn: false, scope: "SELECTED",
  }), true);
}
{
  const { client } = fakePrisma({ knowledgeCollectEnabled: false });
  assert.equal(await isPrivateKnowledgeSource(client as unknown as PrivateDeps, {
    characterId: "c1", memoryScopeId: "s1", isOwnerTurn: false, scope: "SELECTED",
  }), false);
}
{
  // 认不出是哪个身份范围就不收：宁可漏，也不要又堆一屏噪音。
  const { state, client } = fakePrisma({ knowledgeCollectEnabled: true });
  assert.equal(await isPrivateKnowledgeSource(client as unknown as PrivateDeps, {
    characterId: "c1", memoryScopeId: null, isOwnerTurn: false, scope: "SELECTED",
  }), false);
  assert.equal(state.calls, 0);
}

// —— 群聊 ——
{
  const { state, client } = fakePrisma(null);
  assert.equal(await isGroupKnowledgeSource(client as unknown as GroupDeps, {
    characterId: "c1", platform: "qq-onebot",
    evidence: [{ platformUid: "10001", isOwner: false }], scope: "ALL",
  }), true);
  assert.equal(state.calls, 0);
}
{
  const { state, client } = fakePrisma(null);
  assert.equal(await isGroupKnowledgeSource(client as unknown as GroupDeps, {
    characterId: "c1", platform: "qq-onebot",
    evidence: [{ platformUid: "10001", isOwner: false }, { platformUid: "10002", isOwner: true }], scope: "SELECTED",
  }), true);
  assert.equal(state.calls, 0, "证据里有主人就不必再查白名单");
}
{
  const { state, client } = fakePrisma({ id: "scope-1" });
  assert.equal(await isGroupKnowledgeSource(client as unknown as GroupDeps, {
    characterId: "c1", platform: "qq-onebot",
    evidence: [{ platformUid: "10001", isOwner: false }, { platformUid: "10001", isOwner: false }], scope: "SELECTED",
  }), true);
  const args = state.lastArgs as { where: { externalIdentity: { platformUid: { in: string[] } } } };
  assert.deepEqual(args.where.externalIdentity.platformUid.in, ["10001"], "同一人的多条证据只查一次");
}
{
  const { client } = fakePrisma(null);
  assert.equal(await isGroupKnowledgeSource(client as unknown as GroupDeps, {
    characterId: "c1", platform: "qq-onebot",
    evidence: [{ platformUid: "10003", isOwner: false }], scope: "SELECTED",
  }), false);
}
{
  // 证据一条都没对上人：查不了库，按不收处理。
  const { state, client } = fakePrisma({ id: "scope-1" });
  assert.equal(await isGroupKnowledgeSource(client as unknown as GroupDeps, {
    characterId: "c1", platform: "qq-onebot", evidence: [], scope: "SELECTED",
  }), false);
  assert.equal(state.calls, 0);
}

console.log("Knowledge collect source tests passed: default ALL, owner always collected, fail-closed on unknown authors.");
