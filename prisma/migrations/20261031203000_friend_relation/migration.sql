-- 「她的朋友」：把 EXTERNAL_IDENTITY 记忆范围同时当作「某角色认识的某个人」这条关系。
--
-- 不新建关系表：scopeKey 已经是 character:{characterId}:external:{platform}:{uid}，
-- 天然按角色区分 —— 同一个 QQ 号跟两个角色聊过就是两条关系，各记各的次数和时间。

-- 最近一次互动（私聊进来一次、群聊里她回过一次都算）
ALTER TABLE "memory_scopes" ADD COLUMN "lastInteractedAt" TIMESTAMPTZ(6);

-- 累计互动次数。群聊里她没回的那几句不算。
ALTER TABLE "memory_scopes" ADD COLUMN "interactionCount" INTEGER NOT NULL DEFAULT 0;

-- PRIVATE / GROUP：第一次是怎么认识的。群聊里认识的人后来私聊，这个值不改。
ALTER TABLE "memory_scopes" ADD COLUMN "firstSource" VARCHAR(20);

-- 列表默认按「最近互动」倒序，没有记录的排在后面。
CREATE INDEX "memory_scopes_characterId_interactionCount_idx"
  ON "memory_scopes" ("characterId", "interactionCount");
