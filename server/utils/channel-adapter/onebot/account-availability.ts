import { createError } from "h3";
import type { OnebotConnectionRecord } from "./configure";
import { panelListProcesses, panelLogin, pickQqProcess } from "./panel";
import { parseWsEndpoint } from "./runtime";
export type OnebotAccountPresence = "logged_in" | "waiting_login" | "unknown";
const local = (host: string) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
/** Unknown auth/panel status must not be presented as proof that an account is logged out. */
export async function readOnebotAccountPresence(records: readonly OnebotConnectionRecord[], panelPort: number): Promise<Map<string, OnebotAccountPresence>> {
  const output = new Map<string, OnebotAccountPresence>();
  const sessions = new Map<string, Promise<Awaited<ReturnType<typeof panelListProcesses>> | null>>();
  for (const record of records) {
    const endpoint = parseWsEndpoint(record.config.wsUrl);
    if (!endpoint || !local(endpoint.host) || !record.accountQq) { output.set(record.id, "unknown"); continue; }
    const password = record.snowlumaPassword;
    if (!sessions.has(password)) sessions.set(password, (async () => {
      try { const login = await panelLogin(panelPort, password); return login.ok ? await panelListProcesses(login.session) : null; } catch { return null; }
    })());
    const processes = await sessions.get(password)!;
    output.set(record.id, processes === null ? "unknown" : pickQqProcess(processes, record.accountQq) ? "logged_in" : "waiting_login");
  }
  return output;
}
export function chooseOnebotRuntimeConnection<T extends { id: string }>(records: readonly T[], readyIds: ReadonlySet<string>, requested?: string): T | undefined {
  if (requested) { const record = records.find(item => item.id === requested); if (!record) throw createError({ statusCode: 404, statusMessage: "QQ 连接不存在或已停用。" }); return record; }
  return records.find(record => readyIds.has(record.id)) ?? records[0];
}
