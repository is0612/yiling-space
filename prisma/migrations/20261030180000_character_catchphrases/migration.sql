-- 角色的梗语录：她会原样说出来的那几句口头禅。
--
-- 和 styleExamples（对话示例）分开存是有意的：后者注入时带着「别把句子原样搬出来」，
-- 目的是对齐语气；梗要的恰好是反的 —— 原封不动说出口。
-- 单独成表还因为每个梗需要自己的「什么时候说」「是否启用」「上次什么时候说过」，
-- 后者是防复读的依据，一个长文本框给不了。

CREATE TABLE "character_catchphrases" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "characterId" uuid NOT NULL,
    "phrase" character varying(200) NOT NULL,
    "usage" text NOT NULL DEFAULT '',
    "enabled" boolean NOT NULL DEFAULT true,
    "useCount" integer NOT NULL DEFAULT 0,
    "lastUsedAt" timestamptz(6),
    "source" character varying(20) NOT NULL DEFAULT 'manual',
    "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
    "updatedAt" timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT "character_catchphrases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "character_catchphrases_characterId_enabled_idx" ON "character_catchphrases"("characterId", "enabled");

ALTER TABLE "character_catchphrases"
    ADD CONSTRAINT "character_catchphrases_characterId_fkey"
    FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
