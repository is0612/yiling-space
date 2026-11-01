-- 人设拆成两半：`basePrompt` 保留「她是谁」（身份 / 性格 / 说话风格 / 底线），
-- 新增 `styleExamples` 只放对话示例。
--
-- 为什么拆：basePrompt 是三端共用的，B站 值班的粗筛和终判每条候选都会带一次（一轮最多 30 次），
-- 而对话示例对「这条视频值不值得看」毫无帮助，还会把 30 字理由带成碎碎念。
-- 拆开之后示例只进聊天和 QQ/B站 被动回复。
--
-- 存量角色默认空字符串：不注入示例，行为与迁移前完全一致。
ALTER TABLE "characters" ADD COLUMN "styleExamples" TEXT NOT NULL DEFAULT '';
