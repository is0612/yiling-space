/** Shared API, DTO, UI and runtime limits. Reasoning and visible JSON share output tokens. */
export const SOCIAL_ASSESSMENT_OUTPUT_DEFAULT = 8192;
export const SOCIAL_ASSESSMENT_OUTPUT_MIN = 1024;
export const SOCIAL_ASSESSMENT_OUTPUT_MAX = 32768;
export function resolveSocialAssessmentOutputBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(SOCIAL_ASSESSMENT_OUTPUT_MAX, Math.max(SOCIAL_ASSESSMENT_OUTPUT_MIN, value)))
    : SOCIAL_ASSESSMENT_OUTPUT_DEFAULT;
}
export function nextSocialAssessmentOutputBudget(current: number): number | null {
  if (current >= SOCIAL_ASSESSMENT_OUTPUT_MAX) return null;
  return Math.min(SOCIAL_ASSESSMENT_OUTPUT_MAX, Math.max(current * 3, SOCIAL_ASSESSMENT_OUTPUT_DEFAULT));
}
