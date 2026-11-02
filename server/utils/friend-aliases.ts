/**
 * 「她怎么叫这个人」：备注的切分、清洗与上限。
 *
 * 录入是人的动作 —— 页面上就一个逗号分隔的输入框，所以中英文逗号、顿号、斜杠、分号、
 * 换行都得认。不能让人为了格式失败一次。存下来是数组（`MemoryScope.aliases`），
 * 读的时候直接进提示词。
 *
 * 为什么上限卡在这里、而不是只在前端卡：
 * 1. 备注会原样进系统提示词，换行是最省事的注入入口 —— 一条 200 字的「备注」
 *    够把后面整段规则淹掉；
 * 2. 8 个名字 × 8 个熟人就是 64 个词，每条都带上等于把上下文的税交两遍；
 * 3. 前端只是提示，接口才是口径。两边共用这一份常量，页面上的计数才不会和保存结果打架。
 *
 * 清洗策略是「截断」而不是「整条拒绝」：一个 13 字的名字不该让整次保存失败，
 * 截成 12 字仍然能用；只有空片段和重复项会被丢掉，并计入 `dropped` 让人知道。
 */

/** 一个人最多存几个叫法。 */
export const MAX_FRIEND_ALIASES = 8;

/** 单条最多几个字符（按码点算，一个 emoji 算一个）。 */
export const MAX_FRIEND_ALIAS_CHARS = 12;

/** 进提示词时每人最多带几个 —— 存得下 8 个，但没必要每轮都念给模型看。 */
export const PROMPT_FRIEND_ALIAS_LIMIT = 3;

/**
 * 分隔符：中英文逗号、顿号、斜杠、竖线、分号、换行。
 * 不把空格当分隔符 —— 「小 鱼」这种带空格的名字会被切碎。
 */
const ALIAS_SEPARATORS = /[,，、;；/|｜\n\r]+/;

/** 控制字符与零宽字符：前者会破坏提示词结构，后者肉眼看不见、只会让去重失效。 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g;

/** 首尾的引号括号：有人习惯写成「小鱼干」，存进去不该把括号也带上。 */
const WRAPPING_QUOTES = /^["'“”‘’「」『』【】]+|["'“”‘’「」『』【】]+$/g;

/** 清洗单条：摊平空白、去首尾引号、按码点截断。非字符串一律当空。 */
export function cleanFriendAlias(value: unknown): string {
  if (typeof value !== "string") return "";
  const flattened = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  const unquoted = flattened.replace(WRAPPING_QUOTES, "").trim();
  if (!unquoted) return "";
  return Array.from(unquoted).slice(0, MAX_FRIEND_ALIAS_CHARS).join("");
}

export type NormalizedAliases = {
  aliases: string[];
  /** 因为重复或超出上限而没保存的条数。空片段不算 —— 「a,,b」不该提示丢了东西。 */
  dropped: number;
};

/**
 * 把页面上的一段文本（或一组文本）归一成最终要落库的数组。
 *
 * 传数组时每一项还会再切一次：接口允许 "小鱼干,宝" 这种整串，也允许前端已经切好的数组，
 * 两种都从同一个口径出去。
 */
export function normalizeFriendAliases(input: unknown): NormalizedAliases {
  const pieces: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value !== "string") return;
    pieces.push(...value.split(ALIAS_SEPARATORS));
  };
  if (Array.isArray(input)) input.forEach(collect);
  else collect(input);

  const seen = new Set<string>();
  const aliases: string[] = [];
  let dropped = 0;
  for (const piece of pieces) {
    const alias = cleanFriendAlias(piece);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key) || aliases.length >= MAX_FRIEND_ALIASES) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    aliases.push(alias);
  }
  return { aliases, dropped };
}

/**
 * 剔除跟本名相同的叫法。
 *
 * 存着也不会出错，但提示词里会变成「name: 小鱼干 / aliases: ["小鱼干"]」，
 * 模型读起来像两个不同的人。所以入库前就把重复的去掉。
 */
export function dropAliasesMatchingName(
  aliases: readonly string[],
  name: string | null | undefined,
): string[] {
  const key = cleanFriendAlias(name ?? "").toLowerCase();
  if (!key) return [...aliases];
  return aliases.filter((alias) => alias.toLowerCase() !== key);
}

/**
 * 进提示词的形态：再清洗一遍、去重、只留前三个。
 *
 * 这里不信任库里的数据 —— 备注可能来自旧版本、手工 SQL、或者迁移时带进来的脏串，
 * 而提示词是最不该赌的地方。
 */
export function aliasesForPrompt(value: readonly string[] | null | undefined): string[] {
  if (!value?.length) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const alias = cleanFriendAlias(item);
    if (!alias) continue;
    const key = alias.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= PROMPT_FRIEND_ALIAS_LIMIT) break;
  }
  return out;
}
