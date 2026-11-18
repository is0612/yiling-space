import type { ApiRequest } from "../utils/request";

export type ModelCallLog = {
  id: string;
  turnId: string | null;
  hasTurnDetail: boolean;
  createdAt: string;
  kind: string;
  model: string;
  status: "success" | "failed" | "unknown";
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
  usageReported: boolean;
  attempts: number | null;
  durationMs?: number | null;
  finishReason: string | null;
  httpStatus: number | null;
  reason: string | null;
  costCny: number | null;
};

export type ModelCallLogsResponse = {
  items: ModelCallLog[];
  page: number;
  pageSize: number;
  total: number;
  summary: { records: number; totalTokens: number; failed: number; unknown: number; usageMissingRecords: number };
  models: string[];
  kinds: string[];
  note: string;
};

export type TurnMessage = {
  id?: string;
  member?: string;
  speaker?: string;
  content: string;
  occurredAt?: string;
};

export type TurnCollaboration = {
  version: 1;
  elapsedMs: number;
  stages: Array<{
    stage: "context" | "memory" | "knowledge" | "response";
    limit: number; logicalCalls: number; budgetRejections: number;
    skipped: "not_enabled" | "not_needed" | null;
    operations: Array<{
      state: "running" | "success" | "no_sources" | "failed" | "budget_exhausted";
      durationMs: number; reportedAttempts: number; rejectedDiagnostics: number;
      attempts: Array<{
        status: "success" | "failed" | "timeout" | "http_error" | "invalid_response" | "truncated";
        durationMs: number; usageReported: boolean;
        finishReason?: "stop" | "length" | "content_filter" | "unknown";
      }>;
    }>;
  }>;
};

export type GrowthReadDiagnostic = {
  domain: "preferences" | "language" | "goals" | "knowledge";
  status: "not_needed" | "no_match" | "failed" | "budget_excluded" | "provided";
  candidateCount: number; matchedCount: number; selectedCount: number;
  budgetExcludedCount: number; limitExcludedCount: number; candidateLimitReached: boolean;
  provided: Array<{ id: string; revision?: number; updatedAt?: string }>;
  usedIds: string[];
};

export type ModelTurnDetailResponse = {
  turnId: string;
  createdAt: string;
  detail: {
    version: 1;
    groupChat: boolean;
    channel?: "qq-private" | "web";
    collaboration?: TurnCollaboration;
    growthReads?: GrowthReadDiagnostic[];
    messages: TurnMessage[];
    context: {
      status: "not_enabled" | "not_applicable" | "success" | "failed";
      summary?: string;
      participation?: "invited" | "observing" | "uncertain";
      uncertainty?: string;
      evidence?: TurnMessage[];
    };
    memory: {
      status: "not_needed" | "not_enabled" | "no_sources" | "failed" | "success";
      query?: string;
      sources?: Array<{
        id: string;
        type: "memory" | "snapshot" | "event" | "message";
        scope: "character" | "private";
        title?: string;
        content: string;
        occurredAt?: string;
      }>;
    };
    response: {
      status: "success" | "failed";
      action?: "reply" | "silent";
      reply?: string;
      explanation?: string;
    };
  };
};

const logsPath = (characterId: string) => `/characters/${encodeURIComponent(characterId)}/usage/logs`;
const turnPath = (characterId: string, logId: string) =>
  `${logsPath(characterId)}/${encodeURIComponent(logId)}/turn`;

/**
 * 模型调用日志接口：日志分页与单轮协作详情。
 *
 * 分页筛选、取消与竞态序号留在页面/组件里，这里只拼路径和声明出入参。
 */
export function createModelLogsApi(request: ApiRequest) {
  function listLogs(payload: {
    characterId: string;
    days: 1 | 7 | 30;
    kind?: string;
    model?: string;
    page: number;
    pageSize: 20 | 50;
    signal?: AbortSignal;
  }): Promise<ModelCallLogsResponse> {
    return request<ModelCallLogsResponse>({
      url: logsPath(payload.characterId),
      method: "get",
      params: {
        days: payload.days,
        kind: payload.kind,
        model: payload.model,
        page: payload.page,
        pageSize: payload.pageSize,
      },
      signal: payload.signal,
    });
  }

  function getTurnDetail(payload: {
    characterId: string;
    logId: string;
    signal?: AbortSignal;
  }): Promise<ModelTurnDetailResponse> {
    return request<ModelTurnDetailResponse>({
      url: turnPath(payload.characterId, payload.logId),
      method: "get",
      signal: payload.signal,
    });
  }

  return { listLogs, getTurnDetail };
}

export type ModelLogsApi = ReturnType<typeof createModelLogsApi>;
