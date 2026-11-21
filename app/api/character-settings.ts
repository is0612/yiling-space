// 角色设置域的输入输出与后端共用（`shared/types/character-settings.ts`）。
// ProactiveSettings / GroupInitiativeSettings 属于角色本体，源头在 character.ts。
import type { ApiRequest } from "../utils/request";
import type { Character, GroupInitiativeSettings, ProactiveSettings } from "#shared/types/character";
export type { GroupInitiativeSettings, ProactiveSettings } from "#shared/types/character";
import type {
  AssistantKind, AssistantWithProbe, CatchphraseEvidence, CatchphraseItem, CatchphraseScanResult, ConnectionProbeResult, DailyUsage, GroupInitiativeSnapshot, GroupProactiveTryResult, ImportedCharacterResult, MemoryCleanupSummary, MemorySettings, MemorySettingsPatch, ModelCatalogResult, ProactiveSnapshot, ProactiveTryResult, QqSideEffect, StickerItem, StickerList, StickerRelabelResult, StickerSortKey, StickerStats, StickerSyncReport, StickerTrashPayload, StickerUsageSuggestion,
} from "#shared/types/character-settings";
export type * from "#shared/types/character-settings";


const characterBase = (characterId: string) => `/characters/${encodeURIComponent(characterId)}`;
const catchphraseBase = (characterId: string) => `${characterBase(characterId)}/catchphrases`;
const catchphrasePath = (characterId: string, catchphraseId: string) =>
  `${catchphraseBase(characterId)}/${encodeURIComponent(catchphraseId)}`;
const stickerBase = (characterId: string) => `${characterBase(characterId)}/stickers`;
const assistantModelPaths: Record<AssistantKind, string> = {
  memory: "/chat/memory-assistant/models",
  context: "/chat/context-assistant/models",
  knowledge: "/growth/knowledge/models",
  social: "/growth/social/assessment-models",
};
const assistantTestPaths: Record<AssistantWithProbe, string> = {
  memory: "/chat/test-memory-assistant-connection",
  context: "/chat/test-context-assistant-connection",
  social: "/growth/social/assessment-test",
};
const stickerPath = (characterId: string, stickerId: string) =>
  `${stickerBase(characterId)}/${encodeURIComponent(stickerId)}`;

export function assistantHasProbe(kind: AssistantKind): kind is AssistantWithProbe {
  return kind !== "knowledge";
}

/**
 * 角色设置接口：记忆周期、角色资料与模型、梗语录、表情包。
 *
 * 表情包上传是 multipart，仍由页面用 `$fetch` 单独发送；其余 JSON 请求统一走这里。
 * 模型设置里的代际校验（换角色后丢弃旧响应）留在组件里，这个文件只负责端点。
 */
export function createCharacterSettingsApi(request: ApiRequest) {
  function getCharacter(characterId: string): Promise<Character> {
    return request<Character>({ url: characterBase(characterId), method: "get" });
  }

  function updateCharacter(characterId: string, data: Record<string, unknown>): Promise<Character> {
    return request<Character>({ url: characterBase(characterId), method: "patch", data });
  }

  function getMemorySettings(characterId: string): Promise<MemorySettings> {
    return request<MemorySettings>({ url: `${characterBase(characterId)}/memory-settings`, method: "get" });
  }

  function getMemoryCleanup(characterId: string): Promise<{ cleanup: MemoryCleanupSummary | null }> {
    return request<{ cleanup: MemoryCleanupSummary | null }>({
      url: `${characterBase(characterId)}/memory-cleanup`, method: "get",
    });
  }

  function updateMemorySettings(characterId: string, data: MemorySettingsPatch): Promise<MemorySettings> {
    return request<MemorySettings>({
      url: `${characterBase(characterId)}/memory-settings`,
      method: "patch",
      data,
    });
  }

  function listCatchphrases(characterId: string, payload: { status?: string } = {}): Promise<CatchphraseItem[]> {
    return request<CatchphraseItem[]>({
      url: catchphraseBase(characterId),
      method: "get",
      ...(payload.status ? { params: { status: payload.status } } : {}),
    });
  }

  function scanCatchphrases(characterId: string): Promise<CatchphraseScanResult> {
    return request<CatchphraseScanResult>({ url: `${catchphraseBase(characterId)}/mine`, method: "post" });
  }

  function createCatchphrases(payload: {
    characterId: string;
    phrases: string[];
    usage: string;
  }): Promise<{ created: CatchphraseItem[]; skipped: string[] }> {
    return request<{ created: CatchphraseItem[]; skipped: string[] }>({
      url: catchphraseBase(payload.characterId),
      method: "post",
      data: { phrases: payload.phrases, usage: payload.usage },
    });
  }

  function updateCatchphrase(payload: {
    characterId: string;
    catchphraseId: string;
    status?: CatchphraseItem["status"];
    enabled?: boolean;
    phrase?: string;
    usage?: string;
  }): Promise<CatchphraseItem> {
    return request<CatchphraseItem>({
      url: catchphrasePath(payload.characterId, payload.catchphraseId),
      method: "patch",
      data: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        ...(payload.phrase !== undefined ? { phrase: payload.phrase } : {}),
        ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
      },
    });
  }

  function deleteCatchphrase(payload: { characterId: string; catchphraseId: string }): Promise<unknown> {
    return request<unknown>({
      url: catchphrasePath(payload.characterId, payload.catchphraseId),
      method: "delete",
    });
  }

  function listStickers(payload: {
    characterId: string;
    page: number;
    pageSize: number;
    sort: StickerSortKey;
    untagged?: boolean;
  }): Promise<StickerList> {
    return request<StickerList>({
      url: stickerBase(payload.characterId),
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        sort: payload.sort,
        ...(payload.untagged ? { untagged: "1" } : {}),
      },
    });
  }

  function suggestStickerUsage(payload: {
    characterId: string;
    name: string;
    image?: string | null;
  }): Promise<StickerUsageSuggestion> {
    return request<StickerUsageSuggestion>({
      url: `${stickerBase(payload.characterId)}/usage-suggestion`,
      method: "post",
      data: payload.image ? { name: payload.name, image: payload.image } : { name: payload.name },
    });
  }

  function suggestStickerUsageFor(payload: {
    characterId: string;
    stickerId: string;
    name: string;
  }): Promise<StickerUsageSuggestion> {
    return request<StickerUsageSuggestion>({
      url: `${stickerPath(payload.characterId, payload.stickerId)}/usage-suggestion`,
      method: "post",
      data: { name: payload.name },
    });
  }

  function updateSticker(payload: {
    characterId: string;
    stickerId: string;
    enabled?: boolean;
    name?: string;
    usage?: string;
  }): Promise<StickerItem & { qqDesc?: QqSideEffect | null }> {
    return request<StickerItem & { qqDesc?: QqSideEffect | null }>({
      url: stickerPath(payload.characterId, payload.stickerId),
      method: "patch",
      data: {
        ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
        ...(payload.name !== undefined ? { name: payload.name } : {}),
        ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
      },
    });
  }

  function deleteSticker(payload: {
    characterId: string;
    stickerId: string;
  }): Promise<{ ok: boolean; qq?: QqSideEffect }> {
    return request<{ ok: boolean; qq?: QqSideEffect }>({
      url: stickerPath(payload.characterId, payload.stickerId),
      method: "delete",
    });
  }

  function relabelSticker(payload: { characterId: string; stickerId: string }): Promise<StickerRelabelResult> {
    return request<StickerRelabelResult>({
      url: `${stickerPath(payload.characterId, payload.stickerId)}/relabel`,
      method: "post",
    });
  }

  function syncStickersWithQq(characterId: string): Promise<StickerSyncReport> {
    return request<StickerSyncReport>({ url: `${stickerBase(characterId)}/qq-sync`, method: "post" });
  }

  function listStickerTrash(characterId: string): Promise<StickerTrashPayload> {
    return request<StickerTrashPayload>({ url: `${stickerBase(characterId)}/trash`, method: "get" });
  }

  function restoreSticker(payload: { characterId: string; stickerId: string }): Promise<StickerItem> {
    return request<StickerItem>({
      url: `${stickerBase(payload.characterId)}/trash/${encodeURIComponent(payload.stickerId)}/restore`,
      method: "post",
    });
  }

  function purgeSticker(payload: { characterId: string; stickerId: string }): Promise<unknown> {
    return request<unknown>({
      url: `${stickerBase(payload.characterId)}/trash/${encodeURIComponent(payload.stickerId)}/purge`,
      method: "delete",
    });
  }

  function clearStickerTrash(characterId: string): Promise<{ purged: number }> {
    return request<{ purged: number }>({ url: `${stickerBase(characterId)}/trash`, method: "delete" });
  }

  function getDailyUsage(characterId: string): Promise<DailyUsage> {
    return request<DailyUsage>({ url: `${characterBase(characterId)}/usage`, method: "get" });
  }

  function getChatModels(characterId: string): Promise<ModelCatalogResult> {
    return request<ModelCatalogResult>({ url: `${characterBase(characterId)}/chat/models`, method: "get" });
  }

  function testChatConnection(characterId: string): Promise<ConnectionProbeResult> {
    return request<ConnectionProbeResult>({
      url: `${characterBase(characterId)}/chat/test-connection`,
      method: "post",
    });
  }

  function getVoiceModels(characterId: string): Promise<ModelCatalogResult> {
    return request<ModelCatalogResult>({ url: `${characterBase(characterId)}/voice/models`, method: "get" });
  }

  function testVoiceConnection(characterId: string): Promise<ConnectionProbeResult> {
    return request<ConnectionProbeResult>({
      url: `${characterBase(characterId)}/voice/test-connection`,
      method: "post",
    });
  }

  function getVisionModels(characterId: string): Promise<ModelCatalogResult> {
    return request<ModelCatalogResult>({
      url: `${characterBase(characterId)}/chat/models`,
      method: "get",
      params: { target: "vision" },
    });
  }

  function testVisionConnection(characterId: string): Promise<ConnectionProbeResult> {
    return request<ConnectionProbeResult>({
      url: `${characterBase(characterId)}/vision/test-connection`,
      method: "post",
    });
  }

  function getAssistantModels(characterId: string, kind: AssistantKind): Promise<ModelCatalogResult> {
    return request<ModelCatalogResult>({
      url: `${characterBase(characterId)}${assistantModelPaths[kind]}`,
      method: "get",
    });
  }

  function testAssistantConnection(characterId: string, kind: AssistantWithProbe): Promise<ConnectionProbeResult> {
    return request<ConnectionProbeResult>({
      url: `${characterBase(characterId)}${assistantTestPaths[kind]}`,
      method: "post",
    });
  }

  function getProactiveSnapshot(characterId: string): Promise<ProactiveSnapshot> {
    return request<ProactiveSnapshot>({ url: `${characterBase(characterId)}/proactive`, method: "get" });
  }

  function tryProactive(characterId: string): Promise<ProactiveTryResult> {
    return request<ProactiveTryResult>({ url: `${characterBase(characterId)}/proactive/try`, method: "post" });
  }

  function tryGroupProactive(characterId: string): Promise<GroupProactiveTryResult> {
    return request<GroupProactiveTryResult>({
      url: `${characterBase(characterId)}/proactive/group-try`,
      method: "post",
    });
  }

  function importCharacter<
    TAdded = Record<string, unknown>,
    TCounts = Record<string, unknown>,
  >(payload: {
    bundle: Record<string, unknown>;
    targetCharacterId?: string;
  }): Promise<ImportedCharacterResult<TAdded, TCounts>> {
    return request<ImportedCharacterResult<TAdded, TCounts>>({
      url: "/characters/import",
      method: "post",
      data: payload.bundle,
      ...(payload.targetCharacterId ? { params: { target: payload.targetCharacterId } } : {}),
    });
  }

  return {
    getCharacter,
    updateCharacter,
    getMemorySettings,
    updateMemorySettings,
    listCatchphrases,
    scanCatchphrases,
    createCatchphrases,
    updateCatchphrase,
    deleteCatchphrase,
    listStickers,
    suggestStickerUsage,
    suggestStickerUsageFor,
    updateSticker,
    deleteSticker,
    relabelSticker,
    syncStickersWithQq,
    listStickerTrash,
    restoreSticker,
    purgeSticker,
    clearStickerTrash,
    getDailyUsage,
    getChatModels,
    testChatConnection,
    getVoiceModels,
    testVoiceConnection,
    getVisionModels,
    testVisionConnection,
    getAssistantModels,
    testAssistantConnection,
    getProactiveSnapshot,
    tryProactive,
    tryGroupProactive,
    importCharacter,
  };
}

export type CharacterSettingsApi = ReturnType<typeof createCharacterSettingsApi>;
