import assert from "node:assert/strict";
import { buildSocialAssessmentSourceManifest } from "../server/utils/social-assessment-evidence";
import { socialAssessmentAvailability } from "../server/utils/social-assessment-history";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixture() {
  const source = (n: number) => ({ id: id(n), memoryScopeId: id(20), status: "ACTIVE", title: "测试依据", detail: "合成测试正文", occurredAt: new Date("2026-11-10T00:00:00Z"), participants: [], confidence: 0.8 });
  const evidence = [1, 2].map((n) => ({ kind: n === 1 ? "NEW" : "CONTEXT", experience: { id: id(n + 2), scopeId: id(10), assessmentDispatchStatus: "LEGACY", memoryEvent: source(n) } }));
  return { status: "SUCCEEDED", outcome: "CHANGE", reviewStatus: "PENDING", relationshipVersion: 0, evaluatedStage: "STRANGER", evaluatedStatus: "UNOBSERVED",
    scope: { id: id(10), relationshipVersion: 0, relationshipStage: "STRANGER", relationshipStatus: "UNOBSERVED" }, evidence,
    observations: { evidenceExperienceIds: [id(4)], newEvidenceExperienceIds: [id(3)], sourceManifest: buildSocialAssessmentSourceManifest(evidence.map(item => item.experience)) } };
}
assert.equal(socialAssessmentAvailability(fixture()).canReview, true);
for (const mutate of [
  (row: ReturnType<typeof fixture>) => { row.evidence[0]!.experience.memoryEvent.status = "ARCHIVED"; },
  (row: ReturnType<typeof fixture>) => { row.evidence[0]!.experience.memoryEvent.detail = "来源已变更"; },
  (row: ReturnType<typeof fixture>) => { row.evidence[0]!.experience.scopeId = id(99); },
  (row: ReturnType<typeof fixture>) => { row.evidence[0]!.experience.assessmentDispatchStatus = "PENDING"; },
  (row: ReturnType<typeof fixture>) => { row.observations.sourceManifest.push(row.observations.sourceManifest[0]!); },
  (row: ReturnType<typeof fixture>) => { row.scope.relationshipVersion++; },
]) {
  const row = fixture(); mutate(row);
  assert.equal(socialAssessmentAvailability(row).canReview, false, "NEW evidence is required even when only CONTEXT was cited");
}
const newOnly = fixture(); newOnly.observations.evidenceExperienceIds = [];
assert.equal(socialAssessmentAvailability(newOnly).canReview, true, "Acceptance validates the union of cited and NEW evidence");
const finished = fixture(); finished.reviewStatus = "ACCEPTED";
assert.deepEqual(socialAssessmentAvailability(finished), { canReview: false, staleReason: null });
console.log("Social assessment availability: NEW/cited source union, status, hash, relationship scope, dispatch state, malformed manifests and resolved history passed (no database/model calls).");
