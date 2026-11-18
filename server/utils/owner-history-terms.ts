/** Model-produced keywords are bounded read hints, never routing or authorization. */
export function normalizeOwnerHistoryTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const terms = value.filter((term): term is string => typeof term === "string")
    .map(term => term.trim()).filter(term => Array.from(term).length >= 2 && Array.from(term).length <= 32
      && !/^\d+$/u.test(term));
  // A reduplicated Han action can occur in the record with a different suffix.
  // Keep the exact term and its shared core (not a character-wide n-gram expansion).
  // This deterministic lexical normalization remains within the same eight read hints.
  return [...new Set(terms.flatMap(term => {
    const chars = Array.from(term);
    return chars.length === 2 && chars[0] === chars[1] && /\p{Script=Han}/u.test(chars[0]!)
      ? [term, chars[0]!] : [term];
  }))].slice(0, 8);
}
