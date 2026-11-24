-- 形象档案接入本机 LoRA：文件名、强度、触发词。
-- 三列都带默认值，老档案读出来就是「不用 LoRA」，行为与加列前完全一致。
ALTER TABLE "character_visual_profiles"
  ADD COLUMN "loraName" VARCHAR(200) NOT NULL DEFAULT '',
  ADD COLUMN "loraStrength" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN "loraTrigger" VARCHAR(200) NOT NULL DEFAULT '';
