-- 梗语录加「待确认」状态：从群里捡回来的梗不能直接生效。
--
-- 表情包可以直接入库（贴错了只是贴错一张图），梗不行 —— 那是群里某个人的说法，
-- 冒用错一次就很难收回。所以捡回来先 PENDING，用户在弹窗里点「入库」才转 ACTIVE。
--
-- REJECTED 的行不删：删了下一轮扫描会把它重新捡回来，用户就永远否不掉。

ALTER TABLE "character_catchphrases" ADD COLUMN "status" character varying(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "character_catchphrases" ADD COLUMN "evidence" jsonb;

-- 已有的手动梗都是 ACTIVE（默认值已经填上），不需要 UPDATE。

CREATE INDEX "character_catchphrases_characterId_status_idx" ON "character_catchphrases"("characterId", "status");
