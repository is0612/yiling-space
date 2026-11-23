export type PublishedVisualSnapshot = {
  coreAppearance?: unknown;
  corePrompt?: unknown;
  negativePrompt?: unknown;
  outfits?: unknown;
};

/**
 * 单条提示词预算。与 image-generation 侧最终交给服务商的长度保持一致，
 * 免得这里拼好、那边再被硬截掉半句话。
 */
const MAX_PROMPT_CHARS = 1200;

/** 造型名只用来做段落标题，太长会把预算吃光。 */
const MAX_OUTFIT_NAME_CHARS = 20;

const readText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * 画面里是否已经写明了服装。命中就不拼默认造型 —— 否则会变成
 * 「默认造型一套 + 画面里另一套」的混搭。
 *
 * 判据保留款式名词（裙 / 制服 / 礼服……），因为「一条百褶裙」这种写法可能只有名词、没有动词。
 * 唯一排除的是「裙摆」：它描述的是已经穿在身上的衣服在动，不构成「另换了一套」。
 */
const EXPLICIT_OUTFIT =
  /(穿着|身穿|换上|换上了|穿上|换装|衣服|服装|裙(?!摆)|制服|女仆装|礼服|婚纱|外套|毛衣|衬衫|连衣裙|和服|汉服|盔甲|披风|wearing|outfit|dress|uniform|coat|shirt|sweater)/iu;

type OutfitPick = { name: string; prompt: string };

/** 取当前默认造型；画面显式写了服装时返回 null。 */
function pickDefaultOutfit(outfits: unknown, scene: string): OutfitPick | null {
  if (EXPLICIT_OUTFIT.test(scene)) return null;
  if (!Array.isArray(outfits)) return null;
  for (const item of outfits) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (record.isDefault !== true) continue;
    const prompt = readText(record.prompt);
    if (!prompt) continue;
    return { name: readText(record.name).slice(0, MAX_OUTFIT_NAME_CHARS), prompt };
  }
  return null;
}

/**
 * Compose only a published visual snapshot with the independently authored scene.
 * Draft profile fields must never be passed to this function.
 *
 * 分段而不是散句：每段前面标明它是什么，模型才知道哪句在定长相、哪句在定这一张的构图。
 * 顺序固定为 人物 → 造型 → 画面 → 避免，和「核心形象 + 造型 + 场景」的层次一致。
 *
 * 长度预算：画面先占位、且不截断（这一张画什么由它决定），剩下的才分给人物和造型。
 * 画面自己就超预算时放弃身份段 —— 与「没有档案就只用场景」保持同一条退路。
 */
export function composePublishedVisualPrompt(snapshot: PublishedVisualSnapshot, scenePrompt: string): string {
  const scene = String(scenePrompt ?? "").trim();
  const person = [readText(snapshot.coreAppearance), readText(snapshot.corePrompt)].filter(Boolean).join("，");
  const outfit = pickDefaultOutfit(snapshot.outfits, scene);
  const negative = readText(snapshot.negativePrompt);

  // 档案里什么都没有：保持「只有本轮场景」的老行为，也不加标签。
  if (!person && !outfit && !negative) return scene.slice(0, MAX_PROMPT_CHARS).trim();

  const outfitLabel = outfit?.name ? `【造型·${outfit.name}】` : "【造型】";
  const sceneSection = scene ? `【画面】${scene}` : "";

  if (!sceneSection) {
    const only = [
      person ? `【人物】${person}` : "",
      outfit ? `${outfitLabel}${outfit.prompt}` : "",
      negative ? `【避免】${negative}` : "",
    ].filter(Boolean).join("；");
    return only.slice(0, MAX_PROMPT_CHARS).trim();
  }

  if (sceneSection.length >= MAX_PROMPT_CHARS) return scene.slice(0, MAX_PROMPT_CHARS).trim();

  // 扣掉画面和它前面的一个分隔符，剩下的是身份段的额度。
  let room = MAX_PROMPT_CHARS - sceneSection.length - 1;
  const head: string[] = [];

  /** 放一段；放不下就按剩余额度截断正文，标签本身一定保留。 */
  const place = (label: string, body: string) => {
    if (!body) return;
    const separator = head.length ? 1 : 0;
    const available = room - separator - label.length;
    if (available <= 0) return;
    const text = body.length <= available ? body : body.slice(0, available).trim();
    if (!text) return;
    head.push(`${label}${text}`);
    room -= label.length + text.length + separator;
  };

  place("【人物】", person);
  if (outfit) place(outfitLabel, outfit.prompt);

  // 负面词排在画面之后；额度不够就别硬留半句残缺的约束。
  let tail = "";
  if (negative) {
    const available = room - 1 - "【避免】".length;
    const text = available >= negative.length
      ? negative
      : available >= negative.length * 0.6 ? negative.slice(0, available).trim() : "";
    if (text) tail = `【避免】${text}`;
  }

  return [...head, sceneSection, tail].filter(Boolean).join("；").trim();
}
