import type { ApiRequest } from "../utils/request";

export type JournalKind = "DIARY" | "HANDBOOK";

export type JournalListItem = {
  id: string;
  dayKey: string;
  status: "ACTIVE" | "SKIPPED";
  diaryTitle: string | null;
  diaryFirstLine: string;
  handbookQuote: string | null;
  diaryVersion: number;
  handbookVersion: number;
  updatedAt: string;
};

export type JournalRevision = {
  id: string;
  kind: JournalKind;
  version: number;
  title: string | null;
  content: string;
  thought: string | null;
  quote: string | null;
  tags: string[];
  sourceDiaryRevisionId: string | null;
  sourceDiaryVersion: number | null;
  revisionType: string;
  promptVersion: string | null;
  model: string | null;
  editedByUserId: string | null;
  createdAt: string;
  sources: { messages: number; events: number };
};

export type JournalDetail = {
  id: string;
  dayKey: string;
  status: "ACTIVE" | "SKIPPED";
  skipReason: string | null;
  createdAt: string;
  updatedAt: string;
  diaryState: "PENDING" | "GENERATED" | "SKIPPED";
  handbookState: "PENDING" | "GENERATED" | "SKIPPED";
  diaryDecidedAt: string | null;
  handbookDecidedAt: string | null;
  revisionCounts: { diary: number; handbook: number };
  diary: JournalRevision | null;
  handbook: JournalRevision | null;
};

export type JournalPage = {
  items: JournalListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  timeZone: string;
  todayKey: string;
  yesterdayKey: string;
};

export type JournalWriteResult = { status: string; reason?: string };

export type ListJournalsReq = {
  characterId: string;
  page: number;
  pageSize: number;
  month?: string;
};

export type JournalDetailReq = {
  characterId: string;
  dayKey: string;
};

export type WriteJournalDayReq = {
  characterId: string;
  dayKey: string;
  target?: JournalKind | "BOTH";
};

export type RegenerateJournalReq = {
  characterId: string;
  dayKey: string;
  kind: JournalKind;
};

export type SaveJournalEntryReq = {
  characterId: string;
  dayKey: string;
  kind: JournalKind;
  title: string;
  content: string;
  thought: string;
  quote: string;
  tags: string[];
};

export type JournalRevisionsReq = {
  characterId: string;
  dayKey: string;
  kind: JournalKind;
};

export type RestoreJournalRevisionReq = JournalRevisionsReq & { version: number };

const base = (characterId: string) => `/characters/${encodeURIComponent(characterId)}/journals`;
const dayPath = (characterId: string, dayKey: string) =>
  `${base(characterId)}/${encodeURIComponent(dayKey)}`;

export function createJournalApi(request: ApiRequest) {
  function listJournals(payload: ListJournalsReq): Promise<JournalPage> {
    return request<JournalPage>({
      url: base(payload.characterId),
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        ...(payload.month ? { month: payload.month } : {}),
      },
    });
  }

  function getJournalDetail(payload: JournalDetailReq): Promise<JournalDetail> {
    return request<JournalDetail>({
      url: dayPath(payload.characterId, payload.dayKey),
      method: "get",
    });
  }

  function writeJournalDay(payload: WriteJournalDayReq): Promise<JournalWriteResult> {
    return request<JournalWriteResult>({
      url: base(payload.characterId),
      method: "post",
      data: { dayKey: payload.dayKey, target: payload.target ?? "BOTH" },
    });
  }

  function regenerateJournal(payload: RegenerateJournalReq): Promise<JournalWriteResult> {
    return request<JournalWriteResult>({
      url: `${dayPath(payload.characterId, payload.dayKey)}/regenerate`,
      method: "post",
      data: { target: payload.kind },
    });
  }

  function saveJournalEntry(payload: SaveJournalEntryReq): Promise<unknown> {
    const { characterId, dayKey, ...data } = payload;
    return request<unknown>({
      url: dayPath(characterId, dayKey),
      method: "patch",
      data,
    });
  }

  function listJournalRevisions(payload: JournalRevisionsReq): Promise<{ items: JournalRevision[] }> {
    return request<{ items: JournalRevision[] }>({
      url: `${dayPath(payload.characterId, payload.dayKey)}/revisions`,
      method: "get",
      params: { kind: payload.kind },
    });
  }

  function restoreJournalRevision(payload: RestoreJournalRevisionReq): Promise<unknown> {
    return request<unknown>({
      url: `${dayPath(payload.characterId, payload.dayKey)}/restore`,
      method: "post",
      data: { kind: payload.kind, version: payload.version },
    });
  }

  return { listJournals, getJournalDetail, writeJournalDay, regenerateJournal, saveJournalEntry, listJournalRevisions, restoreJournalRevision };
}
