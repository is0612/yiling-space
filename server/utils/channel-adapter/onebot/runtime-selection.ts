import { readBody, type H3Event } from "h3";
import { requireUuid } from "../../local-api";
import { loadOnebotConnections } from "./configure";
import { chooseOnebotRuntimeConnection, readOnebotAccountPresence } from "./account-availability";
import { parseWsEndpoint, probeTcp } from "./runtime";
/** Explicit actions stay on the selected account. Legacy callers prefer a usable account. */
export async function selectOnebotActionConnection(event: H3Event, panelPort: number) {
  const body = await readBody(event) as { connectionId?: unknown } | undefined;
  const requested = body?.connectionId === undefined ? undefined : requireUuid(String(body.connectionId), "QQ 连接");
  const records = await loadOnebotConnections();
  if (requested) return chooseOnebotRuntimeConnection(records, new Set(), requested);
  const presence = await readOnebotAccountPresence(records, panelPort);
  const readyIds = new Set<string>();
  for (const record of records) {
    if (presence.get(record.id) === "waiting_login") continue;
    const endpoint = parseWsEndpoint(record.config.wsUrl);
    if (presence.get(record.id) === "logged_in" || (endpoint && await probeTcp(endpoint.host, endpoint.port))) readyIds.add(record.id);
  }
  return chooseOnebotRuntimeConnection(records, readyIds);
}
