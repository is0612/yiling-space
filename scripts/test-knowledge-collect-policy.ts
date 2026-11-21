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

/** 分开模拟身份排除与来源白名单：ALL 免白名单查询，但仍须查已验证 AI 身份。 */
function fakePrisma(row: Record<string, unknown> | null, ai = false) {
  const state = { calls: 0, identityCalls: 0, whitelistCalls: 0, lastArgs: undefined as unknown, identityArgs: undefined as unknown };
  return {
    state,
    client: {
      memoryScope: {
        findFirst: async (args: unknown) => {
          state.calls += 1;
          const query = args as { select?: { externalIdentity?: unknown }; where?: { externalIdentity?: { kind?: string } } };
          if (query.select?.externalIdentity || query.where?.externalIdentity?.kind === "AI") {
            state.identityCalls += 1;
            state.identityArgs = args;
            return query.select?.externalIdentity
              ? { externalIdentity: { kind: ai ? "AI" : "HUMAN" } }
              : ai ? { id: "ai-scope" } : null;
          }
          state.whitelistCalls += 1;
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
  assert.equal(state.identityCalls, 1, "ALL 仍须排除已验证的 AI 来源");
  assert.equal(state.whitelistCalls, 0, "ALL 模式不该额外查来源白名单");
  assert.deepEqual(state.identityArgs, {
    where: { id: "s1", characterId: "c1" },
    select: { externalIdentity: { select: { kind: true } } },
  }, "身份检查必须限定角色与当前范围");
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
  assert.equal(state.identityCalls, 1, "群聊 ALL 仍须查 AI 身份");
  assert.equal(state.whitelistCalls, 0, "群聊 ALL 不查来源白名单");
  assert.deepEqual(state.identityArgs, {
    where: { characterId: "c1", scopeType: "EXTERNAL_IDENTITY",
      externalIdentity: { platform: "qq-onebot", platformUid: { in: ["10001"] }, kind: "AI" } },
    select: { id: true },
  }, "群聊身份排除必须限定角色、平台与证据账号");
}
{
  const { state, client } = fakePrisma(null);
  assert.equal(await isGroupKnowledgeSource(client as unknown as GroupDeps, {
    characterId: "c1", platform: "qq-onebot",
    evidence: [{ platformUid: "10001", isOwner: false }, { platformUid: "10002", isOwner: true }], scope: "SELECTED",
  }), true);
  assert.equal(state.identityCalls, 1, "混合证据仍须排除非主人 AI 来源");
  assert.equal(state.whitelistCalls, 0, "证据里有主人就不必再查白名单");
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

// ALL 只绕过来源白名单，不绕过 AI 排除；SELECTED 的授权也不能覆盖 AI 排除。
for (const scope of ["ALL", "SELECTED"] as const) {
  const privateAi = fakePrisma({ knowledgeCollectEnabled: true }, true);
  assert.equal(await isPrivateKnowledgeSource(privateAi.client as unknown as PrivateDeps, {
    characterId: "c1", memoryScopeId: "s1", isOwnerTurn: false, scope,
  }), false, `${scope} 私聊不能自动收集 AI 来源`);
  assert.equal(privateAi.state.identityCalls, 1);
  assert.equal(privateAi.state.whitelistCalls, 0, "AI 命中后不再查白名单");

  for (const includeOwner of [false, true]) {
    const groupAi = fakePrisma({ id: "selected-scope" }, true);
    assert.equal(await isGroupKnowledgeSource(groupAi.client as unknown as GroupDeps, {
      characterId: "c1", platform: "qq-onebot", scope,
      evidence: [{ platformUid: "10001", isOwner: false },
        ...(includeOwner ? [{ platformUid: "10002", isOwner: true }] : [])],
    }), false, `${scope} 群聊混有 AI 证据时不能由主人或白名单绕过排除`);
    assert.equal(groupAi.state.identityCalls, 1);
    assert.equal(groupAi.state.whitelistCalls, 0);
  }
}

console.log("Knowledge collect source tests passed: default ALL, owner shortcut, scoped AI exclusion before whitelist, fail-closed on unknown authors.");
