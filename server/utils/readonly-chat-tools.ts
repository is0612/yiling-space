import { readPublicWebpage } from "./read-public-webpage";

export type ReadOnlyChatTools = {
  searchMemory?: (query: string) => Promise<unknown>;
  searchKnowledge?: (query: string) => Promise<unknown>;
  /** 本地只读观察：root 是授权目录的 id 或显示名。 */
  localRoots?: () => Promise<unknown>;
  listLocalFiles?: (root: string, path: string) => Promise<unknown>;
  readLocalFile?: (root: string, path: string) => Promise<unknown>;
  searchLocalFiles?: (root: string, query: string, path: string) => Promise<unknown>;
  /** 只创建审批请求，不直接写盘。 */
  proposeFileWrite?: (root: string, path: string, content: string, reason: string, taskId?: string) => Promise<unknown>;
  /** 建一条任务档案；不产生文件/命令副作用。 */
  createLocalTask?: (title: string, goal: string, plan: string) => Promise<unknown>;
};

type LocalToolSpec = {
  name: string;
  description: string;
  fields: Array<{ name: string; required: boolean; maxLength: number }>;
  maxRaw?: number;
  call: (args: Record<string, string>) => Promise<unknown>;
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
  const localSpecs: LocalToolSpec[] = [
    ...(handlers.localRoots ? [{
      name: "list_local_roots",
      description: "List the local directories the owner has explicitly authorized for read-only observation. Call this before reading files if you do not know the root name.",
      fields: [],
      call: async () => handlers.localRoots!(),
    }] : []),
    ...(handlers.listLocalFiles ? [{
      name: "list_local_directory",
      description: "List files in an authorized local directory. Use root from list_local_roots and a relative path (empty for the root). Read-only.",
      fields: [{ name: "root", required: true, maxLength: 200 }, { name: "path", required: false, maxLength: 500 }],
      call: async (args: Record<string, string>) => handlers.listLocalFiles!(args.root ?? "", args.path ?? ""),
    }] : []),
    ...(handlers.readLocalFile ? [{
      name: "read_local_file",
      description: "Read a UTF-8 text file in an authorized local directory. Use a relative path. Read-only; binary and files over 256 KB are rejected.",
      fields: [{ name: "root", required: true, maxLength: 200 }, { name: "path", required: true, maxLength: 500 }],
      call: async (args: Record<string, string>) => handlers.readLocalFile!(args.root ?? "", args.path ?? ""),
    }] : []),
    ...(handlers.searchLocalFiles ? [{
      name: "search_local_files",
      description: "Search file names or text content inside an authorized local directory. Read-only; returns bounded matches.",
      fields: [
        { name: "root", required: true, maxLength: 200 },
        { name: "query", required: true, maxLength: 100 },
        { name: "path", required: false, maxLength: 500 },
      ],
      call: async (args: Record<string, string>) => handlers.searchLocalFiles!(args.root ?? "", args.query ?? "", args.path ?? ""),
    }] : []),
    ...(handlers.createLocalTask ? [{
      name: "create_local_task",
      description: "Create a local task archive entry with title, goal and plan. This does not write files or run commands; use the returned taskId when proposing file writes.",
      fields: [
        { name: "title", required: true, maxLength: 200 },
        { name: "goal", required: true, maxLength: 4000 },
        { name: "plan", required: true, maxLength: 8000 },
      ],
      maxRaw: 16000,
      call: async (args: Record<string, string>) => handlers.createLocalTask!(args.title ?? "", args.goal ?? "", args.plan ?? ""),
    }] : []),
    ...(handlers.proposeFileWrite ? [{
      name: "propose_file_write",
      description: "Propose writing a UTF-8 text file inside an authorized writable directory. This does NOT write immediately: it creates a pending request that the owner must approve. Never claim the file was written.",
      fields: [
        { name: "root", required: true, maxLength: 200 },
        { name: "path", required: true, maxLength: 500 },
        { name: "content", required: true, maxLength: 20000 },
        { name: "reason", required: true, maxLength: 500 },
        { name: "taskId", required: false, maxLength: 80 },
      ],
      maxRaw: 24000,
      call: async (args: Record<string, string>) => handlers.proposeFileWrite!(args.root ?? "", args.path ?? "", args.content ?? "", args.reason ?? "", args.taskId || undefined),
    }] : []),
  ];

  function localDefinitions() {
    return localSpecs.map((spec) => ({
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(spec.fields.map((field) => [field.name, { type: "string", maxLength: field.maxLength }])),
          required: spec.fields.filter((field) => field.required).map((field) => field.name),
          additionalProperties: false,
        },
      },
    }));
  }

  async function callLocal(name: string, raw: string): Promise<string> {
    const spec = localSpecs.find((item) => item.name === name);
    if (!spec || raw.length > (spec.maxRaw ?? 4096)) return JSON.stringify({ error: "invalid_tool_call" });
    let args: Record<string, unknown>;
    try { args = JSON.parse(raw); } catch { return JSON.stringify({ error: "invalid_arguments" }); }
    if (!args || typeof args !== "object" || Array.isArray(args)) return JSON.stringify({ error: "invalid_arguments" });
    const allowed = new Set(spec.fields.map((field) => field.name));
    if (Object.keys(args).some((key) => !allowed.has(key))) return JSON.stringify({ error: "invalid_arguments" });
    const values: Record<string, string> = {};
    for (const field of spec.fields) {
      const value = args[field.name];
      if (value === undefined) {
        if (field.required) return JSON.stringify({ error: "invalid_arguments" });
        values[field.name] = "";
        continue;
      }
      if (typeof value !== "string" || value.length > field.maxLength) return JSON.stringify({ error: "invalid_arguments" });
      values[field.name] = value.trim();
    }
    const key = JSON.stringify([name, values]);
    if (!cache.has(key)) cache.set(key, (async () => {
      try {
        const result = await spec.call(values);
        const text = JSON.stringify({ untrustedEvidence: true, result });
        return text.length <= 10000 ? text : JSON.stringify({ untrustedEvidence: true, truncated: true, text: text.slice(0, 9500) });
      } catch (error) {
        return JSON.stringify({
          error: "tool_unavailable",
          instruction: "Do not claim this lookup succeeded.",
          ...(error instanceof Error ? { message: error.message.slice(0, 200) } : {}),
        });
      }
    })());
    return cache.get(key)!;
  }

  return {
    definitions: [...definitions.map(item => ({ type: "function", function: { name: item.name, description: item.description,
      parameters: { type: "object", properties: { [item.field]: { type: "string", maxLength: item.field === "url" ? 2048 : 240 } }, required: [item.field], additionalProperties: false } } })), ...localDefinitions()],
    async call(name: string, raw: string): Promise<string> {
      if (++count > 4) return JSON.stringify({ error: "tool_budget_exhausted" });
      if (localSpecs.some((spec) => spec.name === name)) return callLocal(name, raw);
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
