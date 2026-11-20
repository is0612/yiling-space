// Some OpenAI-compatible gateways put DeepSeek's tool envelope in message.content.
// Only recover the local file workflow; other tool families require native tool calls.
const marker = "<｜｜DSML｜｜";
const allowed = new Set(["list_local_roots", "list_local_directory", "read_local_file", "search_local_files", "propose_file_write"]);

export function decodeDeepSeekWriteMarkup(text: string, registered: ReadonlySet<string>) {
  if (text.length > 65_536) return null;
  const outer = /^<｜｜DSML｜｜\s*(calls|function_calls)>\s*([\s\S]*?)\s*<\/｜｜DSML｜｜\s*\1>$/.exec(text.trim());
  if (!outer) return null;
  let rest = outer[2] ?? "";
  const calls: { name: string; arguments: string }[] = [];
  while (rest.trim()) {
    const invoke = /^<｜｜DSML｜｜\s*invoke\s+name="([a-z_]+)">([\s\S]*?)<\/｜｜DSML｜｜\s*invoke>\s*/.exec(rest.trimStart());
    if (!invoke?.[1] || calls.length >= 4 || !allowed.has(invoke[1]) || !registered.has(invoke[1])) return null;
    let body = (invoke[2] ?? "").trimStart();
    const args = new Map<string, string>();
    while (body) {
      const param = /^<｜｜DSML｜｜\s*parameter\s+name="([a-zA-Z][a-zA-Z0-9_]*)"\s+string="true">([\s\S]*?)<\/｜｜DSML｜｜\s*parameter>\s*/.exec(body);
      if (!param?.[1] || args.size >= 10 || args.has(param[1]) || param[2]?.includes(marker) || param[2]?.includes("</｜｜DSML｜｜")) return null;
      args.set(param[1], param[2] ?? "");
      body = body.slice(param[0].length);
    }
    calls.push({ name: invoke[1], arguments: JSON.stringify(Object.fromEntries(args)) });
    rest = rest.trimStart().slice(invoke[0].length);
  }
  return calls.length ? calls : null;
}
