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
  if (scenePrompt.trim()) parts.push(scenePrompt.trim());
  return parts.join("；").slice(0, 1200).trim();
}
