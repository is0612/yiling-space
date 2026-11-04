export type CopyableCharacterProfile = {
  name: string;
  alias: string;
  description: string;
  personality: string;
  examples?: string;
  userAddress?: string;
  avatarTone: string;
};

/** Explicit allow-list: copies profile only, never credentials, memory, or channel bindings. */
export function characterCopyInput(character: CopyableCharacterProfile) {
  const suffix = " 副本";
  return {
    name: character.name.slice(0, 100 - suffix.length) + suffix,
    alias: character.alias,
    description: character.description,
    personality: character.personality,
    examples: character.examples ?? "",
    userAddress: character.userAddress,
    avatarTone: character.avatarTone,
  };
}

/** One operation per character, including the confirmation phase; release even on cancel/error. */
export function createCharacterOperationGuard() {
  const pending = new Set<string>();
  return {
    isPending: (id: string) => pending.has(id),
    async run(id: string, operation: () => Promise<void>) {
      if (pending.has(id)) return;
      pending.add(id);
      try { await operation(); } finally { pending.delete(id); }
    },
  };
}

/** Only replace existing entries: a late PATCH must not resurrect a deleted character. */
export function replaceCharacter<T extends { id: string }>(characters: T[], updated: T) {
  const index = characters.findIndex((item) => item.id === updated.id);
  if (index >= 0) characters.splice(index, 1, updated);
}
