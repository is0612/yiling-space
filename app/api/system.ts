import type { ApiRequest } from "../utils/request";

export type AdminUser = {
  id: string;
  username: string;
  email: string | null;
  displayName: string | null;
  role: "ADMIN" | "USER";
  status: "ACTIVE" | "DISABLED";
  createdAt: string;
  characterCount: number;
  lastActiveAt: string | null;
};

export type AdminUserPage = {
  items: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  /** 全表统计，与当前页无关。 */
  stats: { total: number; adminCount: number; disabledCount: number };
};

export type AuditItem = {
  id: string;
  action: string;
  createdAt: string;
  actor: string | null;
  details: unknown;
};

export type AuditPage = {
  items: AuditItem[];
  total: number;
  page: number;
  totalPages: number;
};

export type MemoryTask = {
  id: string;
  type:
    | "GENERATE_SNAPSHOT"
    | "REGENERATE_SNAPSHOT"
    | "UPDATE_LONG_TERM_MEMORY"
    | "CLEAN_EXPIRED_MESSAGES"
    | "EXTRACT_EVENTS"
    | "GENERATE_JOURNAL";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "RETRY_WAIT" | "CANCELLED";
  attemptCount: number;
  maxAttempts: number;
  runAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  lastError: string | null;
  startedAt: string | null;
  /** 领取时间（租约起点）；运行中才有值。 */
  lockedAt: string | null;
  /** 服务端按 5 分钟租约算好的结论：运行中 + 已过期 = 没人在回收它。 */
  leaseExpired: boolean;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  characterId: string;
  characterName: string;
  cleanupResult: { deletedMessageCount: number | null; cutoff: string | null; recordedAt: string } | null;
};

export type TaskListResponse = {
  items: MemoryTask[];
  total: number;
  allTotal: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stuckCount: number;
  oldestStuckAt: string | null;
  statusCounts: Record<MemoryTask["status"], number>;
};

export type WorkerResult = {
  processed: boolean;
  jobId?: string;
  status?: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED" | "CANCELLED";
  snapshotId?: string;
  message: string;
};

export type SchedulerReport = {
  settingsChecked: number;
  settingsAdvanced: number;
  jobsQueued: number;
  periodsConsidered: number;
  missingGlobalScope: number;
  settingsStillDue: number;
  note: string;
};

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

export type AuthSessionRow = {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  device: { label: string; kind: DeviceKind };
};

export type AuthSessionsPayload = {
  mode: "session" | "local-dev";
  sessions: AuthSessionRow[];
};

export type PasswordChangeResult = { changed: boolean; revokedSessions: number };
export type RevokeSessionResult = { revoked: boolean; currentRevoked: boolean };
export type RevokeOthersResult = { revoked: number };

const userPath = (userId: string) => `/admin/users/${encodeURIComponent(userId)}`;
const taskPath = (taskId: string) => `/tasks/${encodeURIComponent(taskId)}`;
const sessionPath = (sessionId: string) => `/auth/sessions/${encodeURIComponent(sessionId)}`;

/**
 * 系统管理接口：用户与审计、后台任务、账户安全。
 *
 * 只拼路径、声明出入参；分页、页码回退、并发序号与提示文案留在页面里。
 */
export function createSystemApi(request: ApiRequest) {
  function listAdminUsers(payload: { page: number; pageSize: number }): Promise<AdminUserPage> {
    return request<AdminUserPage>({
      url: "/admin/users",
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize },
    });
  }

  function listAuditLogs(payload: { page: number; pageSize: number }): Promise<AuditPage> {
    return request<AuditPage>({
      url: "/admin/audit",
      method: "get",
      params: { page: payload.page, pageSize: payload.pageSize },
    });
  }

  function updateAdminUser(payload: {
    userId: string;
    status?: "ACTIVE" | "DISABLED";
    password?: string;
  }): Promise<unknown> {
    return request<unknown>({
      url: userPath(payload.userId),
      method: "patch",
      data: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.password ? { password: payload.password } : {}),
      },
    });
  }

  function listTasks(payload: {
    page: number;
    pageSize: number;
    status?: string;
    keyword?: string;
  }): Promise<TaskListResponse> {
    return request<TaskListResponse>({
      url: "/tasks",
      method: "get",
      params: {
        page: payload.page,
        pageSize: payload.pageSize,
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.keyword ? { q: payload.keyword } : {}),
      },
    });
  }

  function runTaskScheduler(): Promise<SchedulerReport> {
    return request<SchedulerReport>({ url: "/tasks/scheduler/run", method: "post" });
  }

  function runTaskWorker(): Promise<WorkerResult> {
    return request<WorkerResult>({ url: "/tasks/worker/run", method: "post" });
  }

  function retryTask(taskId: string): Promise<unknown> {
    return request<unknown>({ url: `${taskPath(taskId)}/retry`, method: "post" });
  }

  function cancelTask(taskId: string): Promise<unknown> {
    return request<unknown>({ url: `${taskPath(taskId)}/cancel`, method: "post" });
  }

  function listAuthSessions(): Promise<AuthSessionsPayload> {
    return request<AuthSessionsPayload>({ url: "/auth/sessions", method: "get" });
  }

  function changePassword(payload: {
    currentPassword: string;
    newPassword: string;
  }): Promise<PasswordChangeResult> {
    return request<PasswordChangeResult>({
      url: "/auth/password",
      method: "post",
      data: { currentPassword: payload.currentPassword, newPassword: payload.newPassword },
    });
  }

  function revokeSession(sessionId: string): Promise<RevokeSessionResult> {
    return request<RevokeSessionResult>({ url: sessionPath(sessionId), method: "delete" });
  }

  function revokeOtherSessions(): Promise<RevokeOthersResult> {
    return request<RevokeOthersResult>({ url: "/auth/sessions/revoke-others", method: "post" });
  }

  return {
    listAdminUsers,
    listAuditLogs,
    updateAdminUser,
    listTasks,
    runTaskScheduler,
    runTaskWorker,
    retryTask,
    cancelTask,
    listAuthSessions,
    changePassword,
    revokeSession,
    revokeOtherSessions,
  };
}

export type SystemApi = ReturnType<typeof createSystemApi>;
