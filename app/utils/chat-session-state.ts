export type ChatRequestContext = {
  characterId: string;
  conversationId: string | null;
  view: "ACTIVE" | "ARCHIVED";
  search: string;
};

export type ChatRequestTicket = {
  generation: number;
  context: ChatRequestContext;
};

export function createChatSessionState() {
  let generation = 0;

  return {
    begin(context: ChatRequestContext): ChatRequestTicket {
      generation += 1;
      return { generation, context: { ...context } };
    },
    invalidate(): void {
      generation += 1;
    },
    isCurrent(ticket: ChatRequestTicket, current: ChatRequestContext): boolean {
      return generation === ticket.generation
        && ticket.context.characterId === current.characterId
        && ticket.context.view === current.view
        && ticket.context.search === current.search;
    },
  };
}
