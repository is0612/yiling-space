import assert from "node:assert/strict";
import { chooseOnebotRuntimeConnection, readOnebotAccountPresence } from "../server/utils/channel-adapter/onebot/account-availability";
import type { OnebotConnectionRecord } from "../server/utils/channel-adapter/onebot/configure";
const records = [{ id: "offline", accountQq: "111", snowlumaPassword: "test", config: { wsUrl: "ws://127.0.0.1:3001" } }, { id: "online", accountQq: "222", snowlumaPassword: "test", config: { wsUrl: "ws://127.0.0.1:3003" } }] as unknown as OnebotConnectionRecord[];
assert.equal(chooseOnebotRuntimeConnection(records, new Set(["online"]))?.id, "online");
assert.equal(chooseOnebotRuntimeConnection(records, new Set(["online"]), "offline")?.id, "offline");
assert.throws(() => chooseOnebotRuntimeConnection(records, new Set(), "foreign"), { statusCode: 404 });
const original = globalThis.fetch; let calls = 0;
globalThis.fetch = async input => {
  calls++;
  const url = String(input);
  if (url.endsWith("/api/login")) return Response.json({ success: true, token: "synthetic-session" });
  if (url.endsWith("/api/processes")) return Response.json({ list: [{ pid: 1, uin: "0", account: { uin: "222" } }] });
  throw Error("Unexpected panel operation");
};
try {
  const states = await readOnebotAccountPresence(records, 9999);
  assert.equal(states.get("offline"), "waiting_login"); assert.equal(states.get("online"), "logged_in");
  assert.equal(calls, 2, "Shared credentials read panel once, never hook another account");
  calls = 0; globalThis.fetch = async () => { calls++; return new Response("error", { status: 401 }); };
  const unknown = await readOnebotAccountPresence(records, 9999); assert.equal(unknown.get("offline"), "unknown"); assert.equal(unknown.get("online"), "unknown"); assert.equal(calls, 1);
} finally { globalThis.fetch = original; }
console.log("QQ availability: ready preference, explicit account isolation, exact login matching and shared failed-login bound passed.");
