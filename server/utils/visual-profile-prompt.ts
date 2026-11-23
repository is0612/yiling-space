export type PublishedVisualSnapshot = {
  coreAppearance?: unknown;
  corePrompt?: unknown;
  negativePrompt?: unknown;
  outfits?: unknown;
};

/**
 * Compose only a published visual snapshot with the independently authored scene.
 * Draft profile fields must never be passed to this function.
 */
export function composePublishedVisualPrompt(snapshot: PublishedVisualSnapshot, scenePrompt: string): string {
  const parts: string[] = [];
  if (typeof snapshot.coreAppearance === "string" && snapshot.coreAppearance.trim()) parts.push(snapshot.coreAppearance.trim());
  if (typeof snapshot.corePrompt === "string" && snapshot.corePrompt.trim()) parts.push(snapshot.corePrompt.trim());

  if (Array.isArray(snapshot.outfits)) {
    const selected = snapshot.outfits.find((value) => value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).isDefault === true) as Record<string, unknown> | undefined;
    if (typeof selected?.prompt === "string" && selected.prompt.trim()) parts.push(selected.prompt.trim());
  }

  if (typeof snapshot.negativePrompt === "string" && snapshot.negativePrompt.trim()) {
    parts.push(`避免：${snapshot.negativePrompt.trim()}`);
  }
  const identity = parts.join("；");
  const scene = scenePrompt.trim();
  if (!scene) return identity.slice(0, 1200).trim();
  if (scene.length >= 1200) return scene.slice(0, 1200).trim();
  const identityBudget = Math.max(0, 1199 - scene.length);
  const boundedIdentity = identity.slice(0, identityBudget).trim();
  return [boundedIdentity, scene].filter(Boolean).join("；").trim();
}
