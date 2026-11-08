-- Prisma 的默认约束/索引命名与第一批手写迁移中的 PostgreSQL 63 字符截断结果不一致。
-- 这里只重命名数据库对象，不改变字段、约束语义或任何业务数据。
ALTER TABLE "social_relationship_assessment_evidence"
  RENAME CONSTRAINT "social_relationship_assessment_evidence_assessment_scope_fkey"
  TO "social_relationship_assessment_evidence_assessmentId_scope_fkey";

ALTER TABLE "social_relationship_assessment_evidence"
  RENAME CONSTRAINT "social_relationship_assessment_evidence_experience_scope_fkey"
  TO "social_relationship_assessment_evidence_experienceId_scope_fkey";

ALTER INDEX "social_relationship_assessment_evidence_assessmentId_experience"
  RENAME TO "social_relationship_assessment_evidence_assessmentId_experi_key";
