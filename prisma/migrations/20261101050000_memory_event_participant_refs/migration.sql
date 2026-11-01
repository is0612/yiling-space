-- 忆泡参与者的结构化引用：从证据消息的作者推导，不依赖模型写的显示名。
ALTER TABLE "memory_events" ADD COLUMN "participantRefs" JSONB;
