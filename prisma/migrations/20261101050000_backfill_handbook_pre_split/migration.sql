-- 兼容拆分前的旧数据：当时的「想法 / 一句」存在日记版本上。
-- 拆分后它们属于手账：为每个还有 thought/quote 的日期补一条 HANDBOOK v1，
-- 指向当时那一版日记。正文留空（旧数据只有想法和一句），页面会按字段渲染。
WITH latest AS (
    SELECT DISTINCT ON ("journalId") *
    FROM "journal_revisions"
    WHERE "kind" = 'DIARY'
      AND ("thought" IS NOT NULL OR "quote" IS NOT NULL)
    ORDER BY "journalId", "version" DESC
)
INSERT INTO "journal_revisions" (
    "id", "journalId", "kind", "version", "content", "thought", "quote",
    "sourceDiaryRevisionId", "sourceMessageIds", "sourceEventIds",
    "revisionType", "promptVersion", "model", "createdAt"
)
SELECT
    gen_random_uuid(), latest."journalId", 'HANDBOOK', 1, '',
    latest."thought", latest."quote", latest."id",
    latest."sourceMessageIds", latest."sourceEventIds",
    'AI_GENERATED', latest."promptVersion", latest."model", latest."createdAt"
FROM latest
WHERE NOT EXISTS (
    SELECT 1 FROM "journal_revisions" existing
    WHERE existing."journalId" = latest."journalId" AND existing."kind" = 'HANDBOOK'
);
