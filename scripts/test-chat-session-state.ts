import assert from "node:assert/strict";
import { createChatSessionState } from "../app/utils/chat-session-state";

const base = {
  characterId: "character-a",
  conversationId: "conversation-a",
  view: "ACTIVE" as const,
  search: "",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function testOutOfOrderHistoryResponses() {
  const state = createChatSessionState();
  const oldResponse = deferred<string>();
  const newResponse = deferred<string>();
  const commits: string[] = [];
  const oldTicket = state.begin(base);
  const oldRequest = oldResponse.promise.then((value) => {
    if (state.isCurrent(oldTicket, base)) commits.push(value);
  });
  const newTicket = state.begin({ ...base, conversationId: "conversation-b" });
  const newRequest = newResponse.promise.then((value) => {
    if (state.isCurrent(newTicket, base)) commits.push(value);
  });

  newResponse.resolve("new");
  await newRequest;
  oldResponse.resolve("old");
  await oldRequest;
  assert.deepEqual(commits, ["new"]);
}

async function testSendResponseAcceptsCreatedConversation() {
  const state = createChatSessionState();
  const ticket = state.begin({ ...base, conversationId: null });
  const current = { ...base, conversationId: "new-conversation" };
  assert.equal(state.isCurrent(ticket, current), true);
}

async function testCharacterSwitchInvalidatesInFlightRequest() {
  const state = createChatSessionState();
  const response = deferred<string>();
  const request = state.begin(base);
  let committed: string | null = null;
  const pending = response.promise.then((value) => {
    if (state.isCurrent(request, { ...base, characterId: "character-b", conversationId: null })) committed = value;
  });

  state.invalidate();
  response.resolve("from old character");
  await pending;
  assert.equal(committed, null);
}

async function testSearchAndViewChangesRejectLateResponses() {
  const state = createChatSessionState();
  const response = deferred<void>();
  const searchTicket = state.begin(base);
  let searchCommitted = false;
  const searchRequest = response.promise.then(() => {
    searchCommitted = state.isCurrent(searchTicket, { ...base, search: "keyword" });
  });
  response.resolve();
  await searchRequest;
  assert.equal(searchCommitted, false);

  const viewTicket = state.begin(base);
  assert.equal(state.isCurrent(viewTicket, { ...base, view: "ARCHIVED" }), false);
}

async function testInvalidatedTicketCannotOwnLoadingState() {
  const state = createChatSessionState();
  const ticket = state.begin(base);
  state.begin({ ...base, characterId: "character-b" });
  await Promise.resolve();

  assert.equal(state.isCurrent(ticket, base), false);
}

await testOutOfOrderHistoryResponses();
await testSendResponseAcceptsCreatedConversation();
await testCharacterSwitchInvalidatesInFlightRequest();
await testSearchAndViewChangesRejectLateResponses();
await testInvalidatedTicketCannotOwnLoadingState();
console.log("chat session async race tests passed");
