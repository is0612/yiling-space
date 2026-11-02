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

/**
 * 群里**正在聊**的时候，被叫过去插一句。
 *
 * 和上面那套（冷场起头）只差一件事，但差得很关键：这里有人在说话，她要做的是接住，
 * 不是开场。两份提示词不能合并：
 *
 * - 起头那句必须自己立得住（「这个点还没睡啊」），接话那句必须挂在别人刚说的话上；
 * - 起头禁止寒暄（「大家好」是公告腔），接话则要像随口插进去，越轻越好；
 * - 起头给了 `-` 出口（冷场里硬凑一句比不说更尴尬）；**这里不给** —— 主人明确要她来说一句，
 *   沉默等于抗命。接不上时要求她转成「说点自己的事」，而不是闭麦；
 * - 起头看的是「安静了多久」，这里看的是「刚才聊到哪」，所以素材重点从 idleMinutes
 *   转到了 recentLines，记忆只当背景（3 条），免得她拿私聊记忆在群里念。
 *
 * 不写"主人让你来说两句"：那等于让她当众宣布自己是被人差遣来的，比不说话更破坏气氛。
 */
export type GroupJoinMaterials = {
  /** 场合：`QQ群 123456`。只用于让她知道自己在哪，不要求她提及。 */
  groupLabel: string;
  /** 现在几点：`21:30`。 */
  nowLabel: string;
  /** 最后一条群消息是几分钟前。让她知道「刚才」有多刚。 */
  idleMinutes: number;
  /** 最近几条群消息，按时间正序；格式 `谁：内容`。 */
  recentLines: string[];
  /** 长期记忆（角色全局）。这里只当背景，最多 3 条。 */
  memories: string[];
};

export function buildGroupJoinSystemPrompt(
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
    "你在一个 QQ 群里。群里正在聊天，你过来插一句 —— 你自己也想说两句。",
    "这不是回复某一条消息，是接进他们正在说的话里。",
    "",
    "## 怎么开口",
    "- 一两句话，合计不超过 40 个字。群里刷得快，长了没人看完。",
    "- 接住最近那一两句：说你的看法、补一个细节，或者不同意其中一点。",
    "- 不要复述他们刚说过的话，不要总结，也不要问「你们在聊什么」—— 那说明你根本没看。",
    "- 不要 @ 任何人，也不要叫谁的名字。群里点名等于把私聊搬到台面上。",
    "- 别人 @ 谁、叫谁的名字，都不一定是在跟你说话；别把别人的对话认成自己的。",
    "- 不要寒暄开场（「大家好」「我来了」「在聊什么呢」），那是公告腔。",
    "- 实在接不上，就说一句跟你自己有关、别人接得下去的话；不要空着不说话。",
    "- 不要提「记忆」「系统」「资料」「刚才看到」这类暴露机制的话，也不要提是谁让你来的。",
    "- 只输出这句话本身：不要引号、不要前缀、不要括号里的动作说明。",
  );
  return lines.join("\n");
}

export function buildGroupJoinUserPrompt(materials: GroupJoinMaterials): string {
  const recent = materials.recentLines.length
    ? materials.recentLines.map((line) => `- ${line}`).join("\n")
    : "（他们刚说过的几句没留下来，只有这个群还热着）";
  // 比冷场起头再少一条：这里的主料是 live 的对话，记忆给多了她会开始讲自己的事。
  const memories = materials.memories.slice(0, 3);

  return [
    `场合：${materials.groupLabel}，最后一条消息是 ${materials.idleMinutes} 分钟前，现在 ${materials.nowLabel}。`,
    "",
    "## 他们刚才在说什么（按时间正序，最后一条是最新的）",
    recent,
    "",
    ...(memories.length
      ? ["## 你记得的事（只是背景，不要整段复述，也不要说「我记得」）", ...memories.map((line) => `- ${line}`), ""]
      : []),
    "写那句你想插进去的话。",
  ].join("\n");
}
