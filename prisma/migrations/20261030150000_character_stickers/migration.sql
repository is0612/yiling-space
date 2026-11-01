-- 角色自己的表情包（贴图）。
-- QQ 内置表情（face 段）只有那几十个官方脸，模型挑来挑去都是同一张脸；
-- 表情包是用户自己存的图，走 image 段发送，这才是「她自己的表情」。
-- 库里只存清单与文件名，图片本体在 .data/stickers/<characterId>/。

CREATE TABLE "character_stickers" (
    "id" uuid NOT NULL DEFAULT gen_random_uuid(),
    "characterId" uuid NOT NULL,
    "name" character varying(60) NOT NULL,
    "usage" text NOT NULL DEFAULT '',
    "fileName" character varying(120) NOT NULL,
    "mimeType" character varying(60) NOT NULL,
    "sizeBytes" integer NOT NULL,
    "enabled" boolean NOT NULL DEFAULT true,
    "useCount" integer NOT NULL DEFAULT 0,
    "lastUsedAt" timestamptz(6),
    "createdAt" timestamptz(6) NOT NULL DEFAULT now(),
    "updatedAt" timestamptz(6) NOT NULL DEFAULT now(),
    CONSTRAINT "character_stickers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "character_stickers_characterId_enabled_idx" ON "character_stickers"("characterId", "enabled");

ALTER TABLE "character_stickers"
    ADD CONSTRAINT "character_stickers_characterId_fkey"
    FOREIGN KEY ("characterId") REFERENCES "characters"("id") ON DELETE CASCADE ON UPDATE CASCADE;
