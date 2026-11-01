-- 表情包与 QQ 收藏夹双向同步。
--
-- 要解决的问题：QQ 号里收藏的表情（`fetch_custom_face_detail` 能看到的那批）
-- 和本地表情库（`character_stickers`）本来是两套互不相干的数据。她在 QQ 里加了一张，
-- 本地不知道；本地上传一张，QQ 里也没有。用户要的是「两边是同一批表情，
-- 一边改了另一边跟着变，一边删了另一边也没了」。
--
-- 靠什么把两边认成同一张：
--   * qqEmojiId —— QQ 收藏的唯一 id，形如 `<QQ号>_0_0_0_<md5>_0_0`。加了就回传，列表里也在。
--   * qqMd5     —— 从 emoji_id 拆出来的 md5。同一张图在 QQ 里删了再加，id 会变、md5 不变，
--                  只有 id 会漏掉这种情况，所以多存一份内容指纹。
--
-- 为什么不直接硬删：QQ 那边一删，本地连标签一起没了，下次再收藏回来还得重新打标。
-- 所以删除一律软删（deletedAt + deletedReason），进回收站还能捞回来；
-- deletedReason 区分「本地删的（要顺手去删 QQ）」和「QQ 那边没了（本地跟着收起来）」。

ALTER TABLE "character_stickers" ADD COLUMN "qqEmojiId" VARCHAR(120);
ALTER TABLE "character_stickers" ADD COLUMN "qqMd5" VARCHAR(64);
ALTER TABLE "character_stickers" ADD COLUMN "deletedAt" TIMESTAMPTZ(6);
ALTER TABLE "character_stickers" ADD COLUMN "deletedReason" VARCHAR(20);

-- 同一个角色的收藏里不该出现两条同一个 emoji_id。
-- PostgreSQL 的唯一索引允许多行 NULL，所以「只在本地、还没推上去」的那些互不冲突。
CREATE UNIQUE INDEX "character_stickers_characterId_qqEmojiId_key"
    ON "character_stickers"("characterId", "qqEmojiId");

-- 挑表情时的查询条件是 (characterId, enabled)，回收站列表是 (characterId, deletedAt)，
-- 后者要单独一条索引，否则回收站一多就全表扫。
CREATE INDEX "character_stickers_characterId_deletedAt_idx"
    ON "character_stickers"("characterId", "deletedAt");
