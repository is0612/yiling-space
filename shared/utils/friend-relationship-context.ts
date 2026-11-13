/** Reviewed relationship facts only; interaction counts and chat permissions are not feelings. */
export type FriendRelationshipContext = {
  relationshipStage?: "STRANGER" | "ACQUAINTANCE" | "FRIEND" | "CLOSE_FRIEND";
  relationshipStatus?: "NORMAL" | "DISTANT" | "CONFLICT" | "REPAIRING" | "UNOBSERVED";
};

const stages = new Set(["STRANGER", "ACQUAINTANCE", "FRIEND", "CLOSE_FRIEND"]);
const statuses = new Set(["NORMAL", "DISTANT", "CONFLICT", "REPAIRING", "UNOBSERVED"]);

/** Revalidate at serialization boundaries; never copy arbitrary fields into model context. */
export function friendRelationshipForPrompt(value: {
  relationshipStage?: unknown; relationshipStatus?: unknown;
}): FriendRelationshipContext {
  return {
    ...(typeof value.relationshipStage === "string" && stages.has(value.relationshipStage)
      ? { relationshipStage: value.relationshipStage as FriendRelationshipContext["relationshipStage"] } : {}),
    ...(typeof value.relationshipStatus === "string" && statuses.has(value.relationshipStatus)
      ? { relationshipStatus: value.relationshipStatus as FriendRelationshipContext["relationshipStatus"] } : {}),
  };
}

/** Version zero is the unreviewed initial STRANGER/UNOBSERVED default, not a relationship decision. */
export function readReviewedFriendRelationship(value: {
  relationshipVersion: number; relationshipStage?: unknown; relationshipStatus?: unknown;
}): FriendRelationshipContext {
  if (!Number.isInteger(value.relationshipVersion) || value.relationshipVersion <= 0) return {};
  return friendRelationshipForPrompt(value);
}
