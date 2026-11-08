export type KnowledgeSearchRecord = {
  id: string;
  title: string;
  content: string;
  category: string;
  tags: string[];
  confidence: number | null;
  updatedAt: Date | string;
};

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function termsOf(query: string): string[] {
  const compact = normalize(query);
  const terms = new Set<string>();
  for (const word of query.toLocaleLowerCase().match(/[a-z0-9_+-]{2,}/g) ?? []) terms.add(word);
  const cjk = compact.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of cjk) {
    if (run.length <= 2) terms.add(run);
    else {
      for (let i = 0; i < run.length - 1; i += 1) terms.add(run.slice(i, i + 2));
    }
  }
  if (compact.length >= 3) terms.add(compact);
  return [...terms].filter(term => term.length >= 2).slice(0, 40);
}

export function rankKnowledgeItems<T extends KnowledgeSearchRecord>(
  query: string,
  items: readonly T[],
  limit = 8,
): Array<T & { relevanceScore: number }> {
  const terms = termsOf(query);
  if (!terms.length) return [];
  const ranked = items.map(item => {
    const title = normalize(item.title);
    const content = normalize(item.content);
    const tags = item.tags.map(normalize);
    let score = 0;
    for (const term of terms) {
      if (title.includes(term)) score += 5;
      if (tags.some(tag => tag.includes(term))) score += 4;
      if (content.includes(term)) score += 1;
    }
    const full = normalize(query);
    if (full.length >= 3 && title.includes(full)) score += 8;
    if (full.length >= 3 && content.includes(full)) score += 3;
    return { item, relevanceScore: score };
  }).filter(row => row.relevanceScore > 0);
  ranked.sort((a, b) => b.relevanceScore - a.relevanceScore
    || new Date(b.item.updatedAt).getTime() - new Date(a.item.updatedAt).getTime());
  return ranked.slice(0, Math.max(1, Math.min(20, Math.round(limit))))
    .map(row => ({ ...row.item, relevanceScore: row.relevanceScore }));
}
