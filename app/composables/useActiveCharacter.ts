import type { Character } from "~/utils/mock-data";

/**
 * 角色列表的共享状态。布局与页面共用同一份数据，避免重复请求 /api/characters。
 */
export function useCharacterList() {
  return useState<Character[]>("character-list", () => []);
}

/**
 * 上一次拉取角色列表的失败原因。列表本身失败时返回空数组，
 * 光看空数组分不清「一个角色都没有」和「库没迁移 / 没登录」，页面需要这句话来区分两种空态。
 */
export function useCharacterListError() {
  return useState<string | null>("character-list-error", () => null);
}

/** 拉取角色列表并写入共享状态。数据库未就绪或未登录时不抛出，交由页面自行提示。 */
export async function loadCharacters(): Promise<Character[]> {
  const characters = useCharacterList();
  const error = useCharacterListError();
  // SSR 阶段使用 useRequestFetch 转发 cookie，避免把已登录用户的请求变成匿名请求。
  const request = import.meta.server ? useRequestFetch() : $fetch;
  try {
    characters.value = await request<Character[]>("/api/characters");
    error.value = null;
  } catch (cause) {
    // 保持已有列表，调用方按空列表处理。
    const message = cause && typeof cause === "object" && "statusMessage" in cause
      ? String((cause as { statusMessage?: unknown }).statusMessage ?? "")
      : "";
    error.value = message || "读取角色失败，请检查登录状态与本地数据库。";
  }
  return characters.value;
}

/**
 * 在 SSR 与客户端共享同一份角色数据：同 key 在一次请求内只拉取一次，
 * 让首屏渲染（侧边栏导航、首页卡片）就能拿到真实角色 id。
 */
export function useCharacterListData() {
  return useAsyncData("character-list", () => loadCharacters());
}

/** 菜单页记「上次选的谁」用的 cookie。以前叫 memory_last_character，改名后仍读旧值兜底。 */
const CHARACTER_COOKIE = "active_character";
const LEGACY_CHARACTER_COOKIE = "memory_last_character";
const CHARACTER_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * 菜单页（/memory、/chat、/snapshots）的「当前角色」选择逻辑。
 *
 * 真值是地址栏的 `?c=`：分享链接、从别处带 `c=` 进来都以链接为准；
 * cookie 只负责「下次打开还记得上次选了谁」，再没有就回退到列表第一个。
 *
 * 三个菜单页共用同一个 cookie，切了角色就一起走 —— 否则在这页选了 A、
 * 点侧栏去另一页还是 B。
 *
 * @param path 切换角色后要停留的页面路径（如 "/memory"）
 */
export function useCharacterSelection(path: string) {
  const route = useRoute();
  const characters = useCharacterList();
  const stored = useCookie<string | null>(CHARACTER_COOKIE, {
    maxAge: CHARACTER_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
  const legacy = useCookie<string | null>(LEGACY_CHARACTER_COOKIE, {
    maxAge: CHARACTER_COOKIE_MAX_AGE,
    sameSite: "lax",
  });

  function isAvailable(candidate: string) {
    if (!candidate) return false;
    // 角色列表还没到（首屏）时先信链接，免得闪回第一个角色
    return !characters.value.length || characters.value.some((item) => item.id === candidate);
  }

  const id = computed(() => {
    const fromQuery = String(route.query.c || "");
    if (isAvailable(fromQuery)) return fromQuery;
    const remembered = String(stored.value || legacy.value || "");
    if (isAvailable(remembered)) return remembered;
    return characters.value[0]?.id || "";
  });

  function remember(nextId: string) {
    if (!nextId) return;
    stored.value = nextId;
  }

  /** 切换角色：先记住再跳，跳过去的地址里带着 ?c= */
  function go(nextId: string) {
    if (!nextId || nextId === id.value) return;
    remember(nextId);
    return navigateTo({ path, query: { c: nextId } }, { replace: true });
  }

  return { id, remember, go };
}
