import { readPublicWebpage } from "./read-public-webpage";

export type ReadOnlyChatTools = {
  searchMemory?: (query: string) => Promise<unknown>;
  searchKnowledge?: (query: string) => Promise<unknown>;
};
export function createReadOnlyChatTools(handlers: ReadOnlyChatTools, currentMessage = "") {
  const allowedUrls = new Set((currentMessage.match(/https?:\/\/[^\s<>"'，。！？）】]+/giu) ?? []).map(value => { try { return new URL(value).toString(); } catch { return ""; } }));
  let count = 0;
  const cache = new Map<string, Promise<string>>();
  const definitions = [
    ...(handlers.searchMemory ? [{ name: "search_memory", description: "Search permitted past experiences in this conversation's authorized memory scope.", field: "query" }] : []),
    ...(handlers.searchKnowledge ? [{ name: "search_knowledge", description: "Search this character's confirmed knowledge.", field: "query" }] : []),
    { name: "read_public_webpage", description: "Read a public webpage when the current user asks to examine a URL or external information. No login, local files or private network access.", field: "url" },
  ];
  return {
    definitions: definitions.map(item => ({ type: "function", function: { name: item.name, description: item.description,
      parameters: { type: "object", properties: { [item.field]: { type: "string", maxLength: item.field === "url" ? 2048 : 240 } }, required: [item.field], additionalProperties: false } } })),
    async call(name: string, raw: string): Promise<string> {
      if (++count > 4) return JSON.stringify({ error: "tool_budget_exhausted" });
      const definition = definitions.find(item => item.name === name);
      if (!definition || raw.length > 4096) return JSON.stringify({ error: "invalid_tool_call" });
      let args: Record<string, unknown>;
      try { args = JSON.parse(raw); } catch { return JSON.stringify({ error: "invalid_arguments" }); }
      if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 || typeof args[definition.field] !== "string") return JSON.stringify({ error: "invalid_arguments" });
      const value = (args[definition.field] as string).trim();
      if (!value || value.length > (definition.field === "url" ? 2048 : 240)) return JSON.stringify({ error: "invalid_arguments" });
      if (name === "read_public_webpage") {
        try { if (!allowedUrls.has(new URL(value).toString())) return JSON.stringify({ error: "url_not_in_current_task" }); }
        catch { return JSON.stringify({ error: "invalid_arguments" }); }
      }
      const key = JSON.stringify([name, value]);
      if (!cache.has(key)) cache.set(key, (async () => {
        try {
          const result = name === "search_memory" ? await handlers.searchMemory!(value)
            : name === "search_knowledge" ? await handlers.searchKnowledge!(value) : await readPublicWebpage(value);
          if (name === "read_public_webpage" && result && typeof result === "object" && "links" in result && Array.isArray(result.links)) {
            for (const link of result.links) if (typeof link === "string") allowedUrls.add(link);
          }
          const text = JSON.stringify({ untrustedEvidence: true, result });
          return text.length <= 10000 ? text : JSON.stringify({ untrustedEvidence: true, truncated: true, text: text.slice(0, 9500) });
        } catch { return JSON.stringify({ error: "tool_unavailable", instruction: "Do not claim this lookup succeeded." }); }
      })());
      return cache.get(key)!;
    },
  };
}
