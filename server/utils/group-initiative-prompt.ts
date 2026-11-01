/**
 * QQ 群「自己找话题」的提示词。
 *
 * 和私聊主动找话复用同一个人设，但**不能复用同一份提示词**：私聊里她可以「我想你了」，
 * 群里那句话是当众说的，性质完全变了。三件事必须写死：
 *   - 不 @ 任何人（群里点名等于把私人对话搬到台面上）；
 *   - 不寒暄开场（「大家好」「好久不见」是公告腔，不是聊天）；
 *   - 必须给她「不说」的出口（`-`），否则每个冷场她都要硬凑一句，那就成了定时播报。
 */

export type GroupInitiativeMaterials = {
  /** 群怎么称呼：`QQ群 123456` 这种，只用于让她知道场合，不要求她提及。 */
  groupLabel: string;
  /** 已经安静了多少分钟。 */
  idleMinutes: number;
  /** 现在几点：`21:30`。让她能说「这个点还不睡」。 */
  nowLabel: string;
  /** 最近几条群消息，按时间正序；格式 `谁：内容`。 */
  recentLines: string[];
  /** 长期记忆（角色全局），用来给她「自己想说的东西」。 */
  memories: string[];
};

export function buildGroupInitiativeSystemPrompt(
  characterName: string,
  persona: string,
  styleExamples?: string,
): string {
  const lines = [
    `你是「${characterName}」。下面是你的设定：`,
    "",
    persona.slice(0, 12_000),
  ];
  const style = (styleExamples ?? "").trim();
  if (style) {
    lines.push(
      "",
      "## 你平时说话的样子（只学语气，不要照抄句子）",
      style.slice(0, 4_000),
    );
  }
  lines.push(
    "",
    "## 现在的场合",
    "你在一个 QQ 群里，大家已经有一阵没说话了。你要不要先开个头？",
    "这不是回复谁，也没有人在问你。你是自己想说点什么。",
    "",
    "## 怎么开口",
    "- 一两句话，合计不超过 30 个字。群里刷得快，长了没人看。",
    "- 不要 @ 任何人，也不要叫谁的名字 —— 群里点名等于把私聊搬到台面上。",
    "- 不要寒暄开场（「大家好」「好久不见」「有人吗」），那是公告腔，不是聊天。",
    "- 可以接着刚才的话题说一句，也可以抛个轻的（问件小事、说点自己的事、吐槽一下时间/天气/吃的）。",
    "- 不要提「记忆」「系统」「资料」「刚才看到」这类暴露机制的话。",
    "- 想不出像人话的句子就只输出一个减号 `-`，宁可不发 —— 冷场里硬凑一句比不说更尴尬。",
    "- 只输出这句话本身：不要引号、不要前缀、不要括号里的动作说明。",
  );
  return lines.join("\n");
}

export function buildGroupInitiativeUserPrompt(materials: GroupInitiativeMaterials): string {
  const recent = materials.recentLines.length
    ? materials.recentLines.map((line) => `- ${line}`).join("\n")
    : "（这个群最近没留下能看的话）";
  // 记忆只给几条：给多了她会开始复述「我记得你说过……」—— 那是私聊的说法，群里很怪。
  const memories = materials.memories.slice(0, 4);

  return [
    `场合：${materials.groupLabel}，已经安静了 ${materials.idleMinutes} 分钟，现在 ${materials.nowLabel}。`,
    "",
    "## 这个群刚才在聊什么（按时间正序，最后一条是最新的）",
    recent,
    "",
    ...(memories.length
      ? ["## 你记得的事（只是背景，不要整段复述，也不要说「我记得」）", ...memories.map((line) => `- ${line}`), ""]
      : []),
    "写那句你此刻想在群里说的话。不想说就只输出 -。",
  ].join("\n");
}
