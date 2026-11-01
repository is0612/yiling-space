import assert from "node:assert/strict";
import {
  CATCHPHRASE_COOLDOWN_MS,
  CATCHPHRASE_PROMPT_LIMIT,
  CATCHPHRASE_STATUS,
  loadCatchphraseCatalog,
  pickCatchphraseCatalog,
  toCatchphraseDto,
  toCatchphrasePromptEntries,
  type CatchphraseCatalogEntry,
} from "../server/utils/catchphrases";
import {
  cleanMessageForMining,
  extractPhraseCandidates,
  isPhraseWorthConsidering,
  isCatchphraseAutoMineEnabled,
  looksLikeSystemMessage,
  normalizePhraseKey,
} from "../server/utils/catchphrase-mine";

/**
 * 梗语录回归测试。
 *
 * 这个功能唯一的失败模式是「她一直说同一句」和「她一句都不说」，
 * 所以测试重心全在挑选与冷却上：
 *   1. 刚说过的那几句必须排到最后（不是剔掉 —— 只有三条梗时剔掉就等于没了）；
 *   2. 没说过（useCount=0）的排最前，刚加的梗要能立刻听见；
 *   3. 台词一个字都不许截断，截一半的梗说出来是残句；
 *   4. 模型编造的 id 不认，否则冷却会盖到没说过的那句上。
 */

const MINUTE = 60 * 1000;
const NOW = Date.parse("2026-10-30T10:00:00.000Z");

const entry = (
  id: string,
  overrides: Partial<CatchphraseCatalogEntry> = {},
): CatchphraseCatalogEntry => ({
  id,
  phrase: `台词 ${id}`,
  usage: "测试场景",
  useCount: 0,
  lastUsedAtMs: null,
  ...overrides,
});

// ── 1. 分档顺序 ────────────────────────────────────────────────────────────
{
  const entries = [
    entry("cooling", { useCount: 3, lastUsedAtMs: NOW - 10 * MINUTE }),
    entry("ready", { useCount: 5, lastUsedAtMs: NOW - 5 * 60 * MINUTE }),
    entry("fresh-a"),
    entry("fresh-b"),
  ];
  const picked = pickCatchphraseCatalog(entries, 15, NOW, () => 0.5);
  const ids = picked.map((item) => item.id);
  assert.deepEqual(
    [...ids.slice(0, 2)].sort(),
    ["fresh-a", "fresh-b"],
    "没说过的排最前：刚加完一句，用户想马上听见她说。",
  );
  assert.equal(ids[2], "ready", "过了冷却的排第二档。");
  assert.equal(ids[3], "cooling", "还在冷却的必须垫底。");
  assert.equal(picked.length, 4, "垫底不等于剔除：只有三条梗时还得有梗可说。");
}

// ── 2. 冷却判定 ────────────────────────────────────────────────────────────
{
  const got = toCatchphrasePromptEntries([
    entry("just", { useCount: 1, lastUsedAtMs: NOW - MINUTE }),
    entry("expired", { useCount: 1, lastUsedAtMs: NOW - CATCHPHRASE_COOLDOWN_MS - MINUTE }),
    entry("never"),
  ], NOW);
  assert.equal(got[0]!.justSaid, true, "刚说过要打 justSaid：只靠排到末尾不够，模型会挑最有印象那句。");
  assert.equal(got[1]!.justSaid, undefined, "过了冷却就不再标记。");
  assert.equal(got[2]!.justSaid, undefined, "没说过的不标记。");
  assert.ok(
    CATCHPHRASE_COOLDOWN_MS >= 60 * MINUTE,
    "冷却至少一小时：三五轮就允许复用，一句梗一天能刷十几次。",
  );
}

// ── 3. 台词原样、封顶、不改原数组 ──────────────────────────────────────────
{
  const longPhrase = "你说这话之前不烧心吗？".repeat(20);
  const [prompt] = toCatchphrasePromptEntries([
    entry("long", { phrase: longPhrase, usage: "  关键时刻  " }),
  ], NOW);
  assert.equal(prompt!.phrase, longPhrase, "台词一个字都不能截：截一半的梗说出来是残句。");
  assert.equal(prompt!.usage, "关键时刻", "场景说明去掉首尾空白，但内容不动。");

  // 空场景不进提示词：一个空字符串字段只会白烧 token。
  const [withoutUsage] = toCatchphrasePromptEntries([entry("bare", { usage: "   " })], NOW);
  assert.equal("usage" in withoutUsage!, false, "场景为空时不该输出这个字段。");

  const many = Array.from({ length: 40 }, (_, index) => entry(`item-${index}`));
  assert.equal(
    pickCatchphraseCatalog(many, undefined, NOW).length,
    CATCHPHRASE_PROMPT_LIMIT,
    "一次最多进 15 条：40 条全塞进去，模型挑的时候会犹豫。",
  );

  const snapshot = many.map((item) => item.id);
  pickCatchphraseCatalog(many, 10, NOW, () => 0.3);
  assert.deepEqual(many.map((item) => item.id), snapshot, "挑梗不能改动传入的清单（它来自 60 秒缓存）。");

  assert.deepEqual(
    pickCatchphraseCatalog(many, 15, NOW, () => 0.42).map((item) => item.id),
    pickCatchphraseCatalog(many, 15, NOW, () => 0.42).map((item) => item.id),
    "随机源固定时顺序必须固定。",
  );
  assert.notDeepEqual(
    pickCatchphraseCatalog(many, 15, NOW, () => 0.1).map((item) => item.id),
    pickCatchphraseCatalog(many, 15, NOW, () => 0.9).map((item) => item.id),
    "换随机源要换顺序，否则提示词里永远是同一批前置。",
  );
}

// ── 4. 清单读取：缓存与异常兜底 ────────────────────────────────────────────
{
  let calls = 0;
  const rows = [
    { id: "c1", phrase: "不烧心吗", usage: "熬夜时", useCount: 2, lastUsedAt: new Date(NOW - MINUTE) },
  ];
  const fakePrisma = {
    characterCatchphrase: {
      findMany: async () => {
        calls += 1;
        return rows;
      },
    },
  };
  const first = await loadCatchphraseCatalog("00000000-0000-4000-8000-00000000c001", fakePrisma);
  const second = await loadCatchphraseCatalog("00000000-0000-4000-8000-00000000c001", fakePrisma);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(calls, 1, "第二次走缓存：梗清单每轮都要读，内容却几乎不变。");

  // 查询抛错 = 当她没设过梗。一张附属表读不动，不该让整条回复失败。
  const broken = {
    characterCatchphrase: {
      findMany: async () => {
        throw new Error("db down");
      },
    },
  };
  assert.deepEqual(await loadCatchphraseCatalog("00000000-0000-4000-8000-00000000c002", broken), []);
}

// ── 5. DTO ─────────────────────────────────────────────────────────────────
{
  const row = {
    id: "d1", phrase: "不烧心吗", usage: "熬夜时", enabled: true,
    useCount: 1, lastUsedAt: new Date(NOW - MINUTE),
    source: null, createdAt: new Date(NOW - 60 * MINUTE),
  };
  const dto = toCatchphraseDto(row, NOW);
  assert.equal(dto.cooling, true, "页面要能标出「刚说过」——不然用户以为开关没生效。");
  assert.equal(dto.source, "manual", "老数据没有 source 时默认 manual。");
  assert.equal(dto.lastUsedAt, row.lastUsedAt.toISOString(), "时间统一转 ISO 字符串。");
  assert.equal(toCatchphraseDto({ ...row, lastUsedAt: null }, NOW).cooling, false);
  assert.equal(
    dto.status,
    CATCHPHRASE_STATUS.active,
    "迁移前建的梗没有 status 字段，必须当 ACTIVE —— 否则用户手填的梗会集体从页面上消失。",
  );
  assert.equal(toCatchphraseDto({ ...row, status: CATCHPHRASE_STATUS.pending }, NOW).status, "PENDING");

  // evidence 是 Json 列，读回来是 unknown。形状不对时宁可当没有，也不能把页面搞崩。
  assert.equal(toCatchphraseDto({ ...row, evidence: "not-an-object" }, NOW).evidence, null);
  assert.deepEqual(
    toCatchphraseDto({ ...row, evidence: { groupLabel: "QQ群 123", count: 5, speakers: 3, samples: ["原文"] } }, NOW).evidence,
    { groupLabel: "QQ群 123", count: 5, speakers: 3, samples: ["原文"] },
    "证据要原样给到弹窗：用户得看得出「她凭什么觉得这是梗」。",
  );
  assert.deepEqual(
    toCatchphraseDto({ ...row, evidence: { samples: [1, null, "  ", "真原话"] } }, NOW).evidence,
    { samples: ["真原话"] },
    "samples 里的脏值要滤掉，否则前端 join 会拼出 undefined。",
  );
}

// ── 6. 模型侧：进提示词、原样说、编造的 id 不认 ────────────────────────────
{
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  let modelReply: Record<string, unknown> = { reply: "还行。", usedMemoryIds: [], usedSnapshotIds: [] };

  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedBody = typeof init?.body === "string" ? init.body : "";
    return new Response(JSON.stringify({
      model: "test-model",
      choices: [{ message: { role: "assistant", content: JSON.stringify(modelReply) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const { generateConversationReply } = await import("../server/utils/chat-reply");
    const catchphrases = [
      { id: "cp-a", phrase: "xxx 不烧心吗", usage: "看到有人熬夜硬撑的时候" },
      { id: "cp-b", phrase: "本鱼不伺候了", usage: "被气到的时候", justSaid: true },
    ];
    const base = {
      characterName: "小鱼", characterPrompt: "温柔。", model: "test-model", apiKey: "sk-test",
      recentMessages: [], memories: [], snapshots: [],
    };

    // 6a. 台词与场景都要进提示词，并且系统提示词要开那一段约束。
    modelReply = { reply: "你又熬夜？", usedMemoryIds: [], usedSnapshotIds: [], usedCatchphraseIds: ["cp-a"] };
    const said = await generateConversationReply({
      ...base, currentMessage: "睡了睡了", catchphrases,
    });
    assert.deepEqual(said.usedCatchphraseIds, ["cp-a"], "清单内的梗 id 要收下（冷却靠它记账）。");
    assert.ok(capturedBody.includes("xxx 不烧心吗"), "台词要原样进提示词。");
    assert.ok(capturedBody.includes("看到有人熬夜硬撑"), "场景要进提示词，她靠它判断时机。");
    assert.ok(capturedBody.includes("justSaid"), "刚说过的标记要进提示词。");
    assert.ok(
      capturedBody.includes("verbatim"),
      "系统提示词必须写死「原样说」——只给清单，模型会改写成自己的话，那句梗永远等不到。",
    );

    // 6b. 编造的 id（或把台词当 id）→ 丢弃。
    modelReply = { reply: "嗯。", usedMemoryIds: [], usedSnapshotIds: [], usedCatchphraseIds: ["cp-zzz", "xxx 不烧心吗"] };
    const invented = await generateConversationReply({
      ...base, currentMessage: "在吗", catchphrases,
    });
    assert.deepEqual(invented.usedCatchphraseIds, [], "清单外的 id 不认，否则冷却会盖到没说过的梗上。");

    // 6c. 沉默轮不记账：她什么都没说，不能吃掉一次冷却。
    modelReply = { action: "silent", reply: "", usedMemoryIds: [], usedSnapshotIds: [], usedCatchphraseIds: ["cp-a"] };
    const silent = await generateConversationReply({
      ...base, currentMessage: "哈哈哈", catchphrases, groupChat: true, allowSilent: true,
      transcript: [{ id: "m1", content: "哈哈哈" }],
    });
    assert.equal(silent.action, "silent");
    assert.deepEqual(silent.usedCatchphraseIds, [], "沉默要吞掉梗 id，否则「没开口也算用过」。");

    // 6d. 没传梗 → 字段为空，提示词里不出现 catchphrases 段（省 token）。
    modelReply = { reply: "好。", usedMemoryIds: [], usedSnapshotIds: [], usedCatchphraseIds: ["cp-a"] };
    const withoutCatchphrases = await generateConversationReply({ ...base, currentMessage: "在吗" });
    assert.deepEqual(withoutCatchphrases.usedCatchphraseIds, [], "没传清单时恒为空。");
    assert.ok(!capturedBody.includes("catchphrases are your own verbal habits"), "没传梗就不该提这件事。");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ── 7. 从群里捡梗：清洗与噪声过滤 ──────────────────────────────────────────
// 「梗」的第一特征是**反复出现**，不是语义巧妙。所以这一层的活是：把不是人打的字清掉、
// 把没有信息量的说法砍掉、把同一句的不同写法并成一类。判断「像不像梗」交给模型。
{
  assert.equal(
    cleanMessageForMining("[图片：一只猫] 这也太离谱了吧"),
    "这也太离谱了吧",
    "段标记是渠道拼进去的，不清掉的话「[图片]」会成为群里最高频的「梗」。",
  );
  assert.equal(cleanMessageForMining("@self xxx 不烧心吗"), "xxx 不烧心吗", "@self 不是人打的字。");
  assert.equal(cleanMessageForMining("@小明 xxx不烧心吗"), "xxx不烧心吗", "行首 @昵称要摘掉。");
  assert.equal(
    cleanMessageForMining("看这个 https://example.com/a 笑死"),
    "看这个 笑死",
    "链接不该进候选：它只会让重复统计失真。",
  );

  assert.equal(normalizePhraseKey("不烧心吗？"), "不烧心吗", "标点不同要算同一句，否则统计永远到不了阈值。");
  assert.equal(normalizePhraseKey("XXX 不烧心吗！"), "xxx不烧心吗", "大小写和空格一并归一。");

  assert.equal(isPhraseWorthConsidering("不烧心吗"), true, "用户举的例子正好四个字 —— 不能因为短就砍掉。");
  assert.equal(isPhraseWorthConsidering("收到"), false, "两个字基本都是应答，不是梗。");
  assert.equal(isPhraseWorthConsidering("哈哈哈哈"), false, "全同一个字是笑，不是话。");
  assert.equal(isPhraseWorthConsidering("草草草草"), false);
  assert.equal(isPhraseWorthConsidering("😀😀😀😀"), false, "纯 emoji 没有可说的台词。");
  assert.equal(isPhraseWorthConsidering("笑死我了"), false, "在噪声名单里：她要是学会这句，每句都说。");
}

// ── 8. 从群里捡梗：频次与人数 ──────────────────────────────────────────────
{
  const repeated = [
    { content: "xxx 不烧心吗", speaker: "a" },
    { content: "xxx 不烧心吗？", speaker: "b" },
    { content: "xxx 不烧心吗！", speaker: "c" },
    { content: "哈哈哈哈", speaker: "a" },
    { content: "哈哈哈哈", speaker: "b" },
    { content: "哈哈哈哈", speaker: "c" },
  ];
  const found = extractPhraseCandidates(repeated);
  assert.equal(found.length, 1, "只有那句梗浮出来：「哈哈哈哈」是噪声。");
  assert.equal(found[0]!.count, 3, "三种标点算同一句，合并计数。");
  assert.equal(found[0]!.speakers, 3);
  assert.equal(found[0]!.phrase, "xxx 不烧心吗", "展示取最先出现的写法（次数并列时结果要稳定）。");
  assert.equal(found[0]!.samples.length, 3);

  // 同一个人刷三遍：那是口癖或刷屏，不是群体梗。
  const selfRepeat = Array.from({ length: 4 }, () => ({ content: "这就是我不熬夜的原因", speaker: "a" }));
  assert.deepEqual(extractPhraseCandidates(selfRepeat), [], "一个人反复说同一句不算梗。");
  assert.equal(
    extractPhraseCandidates(selfRepeat, { minSpeakers: 1 }).length,
    1,
    "数据里没有发言人信息时可以放宽到 1 —— 否则一条候选都过不了，功能看着像坏的。",
  );

  // 次数不够
  assert.deepEqual(
    extractPhraseCandidates([
      { content: "这波啊这波", speaker: "a" },
      { content: "这波啊这波", speaker: "b" },
    ]),
    [],
    "只出现两次还判断不了「反复」。",
  );

  // 排序与上限
  const wide = [
    ...Array.from({ length: 5 }, () => ({ content: "第一句梗在这里", speaker: "a" })),
    ...Array.from({ length: 4 }, () => ({ content: "第一句梗在这里", speaker: "b" })),
    ...Array.from({ length: 3 }, () => ({ content: "第二句梗在这里", speaker: "a" })),
    ...Array.from({ length: 3 }, () => ({ content: "第二句梗在这里", speaker: "b" })),
    ...Array.from({ length: 3 }, () => ({ content: "第三句梗在这里", speaker: "a" })),
    ...Array.from({ length: 3 }, () => ({ content: "第三句梗在这里", speaker: "b" })),
  ];
  const ranked = extractPhraseCandidates(wide);
  assert.equal(ranked[0]!.count, 9, "频次高的排前面：一次只送八条给模型，得先送最有把握的。");
  assert.equal(extractPhraseCandidates(wide, { maxCandidates: 2 }).length, 2, "上限要生效。");
}

// ── 9. 系统播报不能当梗 ────────────────────────────────────────────────────
// 实测踩到的坑：群里同时跑着几个机器人时，它们对同一条命令的回复
// （「管理命令仅管理员可用。」）被 onebot 当成普通群友消息收进来，
// 因为多个号各回一次，频次和人数都满足「群体反复使用」—— 直接成了最高频的「梗」。
// QQ 侧看不出谁是机器人，只能靠文本特征挡。
{
  assert.equal(looksLikeSystemMessage("管理命令仅管理员可用。"), true, "完整句子 + 句号 = 系统播报风格。");
  assert.equal(looksLikeSystemMessage("⏳ 系统服务重启中，消息已排队，恢复后自动处理。"), true);
  assert.equal(looksLikeSystemMessage("❌ 没有权限"), true, "状态 emoji 开头的一律当播报。");
  assert.equal(looksLikeSystemMessage("xxx 不烧心吗"), false, "人说梗不打句号。");
  assert.equal(looksLikeSystemMessage("确认发布"), false, "短句没句号，判断不了 —— 交给模型。");
  assert.equal(looksLikeSystemMessage("好。"), false, "极短的带句号句子不算播报，别误杀。");

  // 同一个人在同一个群里刷同一句系统播报，也不能变成候选。
  const systemSpam = Array.from({ length: 5 }, (_, index) => ({
    content: "管理命令仅管理员可用。",
    speaker: `bot-${index % 3}`,
  }));
  assert.deepEqual(
    extractPhraseCandidates(systemSpam),
    [],
    "系统播报必须在统计之前就被挡掉，否则它的频次比真梗还高。",
  );
}

// ── 10. 自动捡梗默认关 ─────────────────────────────────────────────────────
{
  assert.equal(isCatchphraseAutoMineEnabled({}), false, "默认关：自动扫会在用户不知情时花 token。");
  assert.equal(isCatchphraseAutoMineEnabled({ catchphraseAutoMine: false }), false);
  assert.equal(isCatchphraseAutoMineEnabled({ catchphraseAutoMine: true }), true);
  assert.equal(isCatchphraseAutoMineEnabled(null), false, "配置形状不对也不能抛错。");
}

console.log("梗语录：全部通过");
