import assert from "node:assert/strict";
import { friendRelationshipForPrompt, readReviewedFriendRelationship } from "../shared/utils/friend-relationship-context";

assert.deepEqual(readReviewedFriendRelationship({ relationshipVersion: 0, relationshipStage: "STRANGER", relationshipStatus: "UNOBSERVED" }), {}, "Initial defaults are not reviewed relationship decisions");
assert.deepEqual(readReviewedFriendRelationship({ relationshipVersion: 2, relationshipStage: "CLOSE_FRIEND", relationshipStatus: "DISTANT" }), { relationshipStage: "CLOSE_FRIEND", relationshipStatus: "DISTANT" }, "Closeness and current state remain independent");
assert.deepEqual(readReviewedFriendRelationship({ relationshipVersion: 1, relationshipStage: "STRANGER", relationshipStatus: "CONFLICT" }), { relationshipStage: "STRANGER", relationshipStatus: "CONFLICT" }, "A reviewed stranger/conflict decision must not be discarded");
for (const relationshipVersion of [-1, NaN, Infinity, 0.5]) {
  assert.deepEqual(readReviewedFriendRelationship({ relationshipVersion, relationshipStage: "FRIEND" }), {});
}
assert.deepEqual(friendRelationshipForPrompt({ relationshipStage: "BLOCK", relationshipStatus: "ALLOW" }), {}, "Chat permissions must never become emotional relationship labels");
assert.deepEqual(friendRelationshipForPrompt({ relationshipStage: "FRIEND", relationshipStatus: null }), { relationshipStage: "FRIEND" });
assert.deepEqual(friendRelationshipForPrompt({}), {}, "Missing data must not infer closeness from interaction counts");
console.log("Reviewed friend relationship context passed: version gate, independent stage/status, whitelist and permission separation (no DB/model).");
