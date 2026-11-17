import type { ApiRequest } from "../utils/request";
import type { Character } from "../utils/mock-data";

export type CharacterCreateInput = {
  name: string;
  alias?: string;
  description: string;
  personality: string;
  examples: string;
  userAddress?: string;
  avatarTone?: string;
};

const characterPath = (characterId: string) => `/characters/${encodeURIComponent(characterId)}`;

/**
 * 角色管理接口：新建、复制、启停、深度思考开关与删除。
 *
 * 导出角色卡要的是原始文件流和 `Content-Disposition` 头，不经过 JSON 入口，仍由页面用原生 `fetch`。
 */
export function createCharactersApi(request: ApiRequest) {
  function listCharacters(): Promise<Character[]> {
    return request<Character[]>({ url: "/characters", method: "get" });
  }

  function createCharacter(payload: CharacterCreateInput): Promise<Character> {
    return request<Character>({ url: "/characters", method: "post", data: payload });
  }

  function updateCharacter(
    characterId: string,
    data: { status?: "运行中" | "已暂停"; chatThinking?: boolean },
  ): Promise<Character> {
    return request<Character>({ url: characterPath(characterId), method: "patch", data });
  }

  function deleteCharacter(characterId: string): Promise<{ cleanupWarning?: string }> {
    return request<{ cleanupWarning?: string }>({
      url: characterPath(characterId),
      method: "delete",
    });
  }

  return { listCharacters, createCharacter, updateCharacter, deleteCharacter };
}

export type CharactersApi = ReturnType<typeof createCharactersApi>;
