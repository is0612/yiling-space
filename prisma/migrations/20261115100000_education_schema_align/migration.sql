-- 对齐 schema 与首版迁移之间的两处差异（只改元数据，不动数据）。

-- 1) ChannelBehaviorPolicy.sourceRefs 在 Prisma 里声明了 @default("[]")，
--    首版迁移建表时漏写 DEFAULT。Prisma 写入会自带这个值，所以一直没暴露；
--    但 migrate diff 会一直把它读成漂移，手工 SQL 插入也会失败。
ALTER TABLE "channel_behavior_policies" ALTER COLUMN "sourceRefs" SET DEFAULT '[]';

-- 2) PostgreSQL 把超过 63 字节的标识符截断，首版迁移里的唯一索引实际落库叫
--    ..._guidanceId_revision_ke，而 Prisma 按自己的截断规则算出 ..._guidanceId_revisio_key。
--    索引功能不受影响，名字不一致会让每次 migrate diff 都报一次「重命名」。
ALTER INDEX "character_interaction_guidance_revisions_guidanceId_revision_ke"
  RENAME TO "character_interaction_guidance_revisions_guidanceId_revisio_key";
