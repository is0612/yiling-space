-- 表情包「自动收图」：来源与内容指纹。
-- contentHash 给去重（群里同一张图转发 N 次只收一次），source 区分手动上传 / 群里自动收的。

ALTER TABLE "character_stickers" ADD COLUMN "contentHash" character varying(64);
ALTER TABLE "character_stickers" ADD COLUMN "source" character varying(20) NOT NULL DEFAULT 'manual';

CREATE INDEX "character_stickers_characterId_contentHash_idx" ON "character_stickers"("characterId", "contentHash");
