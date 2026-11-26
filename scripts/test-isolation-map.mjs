// Ordered child files executed inside each parent's disposable database.
// Parents keep their own setup, fixtures, environment and cleanup. Shared children
// deliberately run in each parent's distinct context; only top-level duplicates are removed.
export const isolatedSuites = {
  "test-assistant-collaboration-isolated.ts": [
    "test-assistant-collaboration-db.ts", "test-growth-consumers-db.ts", "test-self-understanding-db.ts",
    "test-self-understanding-http-db.ts", "test-self-understanding-page.ts", "test-private-channel-history-db.ts",
    "test-channel-model-failure-db.ts",
  ],
  "test-backfill-social-experiences-isolated.ts": ["test-backfill-social-experiences-db.ts"],
  "test-character-isolated.ts": ["test-character-portable-db.ts", "test-character-sync-root-db.ts", "test-character-delete-db.ts"],
  "test-chat-isolated.ts": [
    "test-desktop-conversation-db.ts", "test-chat-conversation-delete-db.ts", "test-chat-request-idempotency-db.ts",
    "test-chat-private-memory-db.ts", "test-web-collaboration-db.ts", "test-memory-cleanup-summary-db.ts", "test-prompt-memory-candidates-db.ts", "test-prompt-event-candidates-db.ts",
  ],
  "test-days-pagination-isolated.ts": ["test-days-pagination-db.ts"],
  "test-growth-event-center-isolated.ts": [
    "test-growth-event-center-db.ts", "test-growth-event-center-concurrency-db.ts", "test-social-experience-events-db.ts",
    "test-growth-delivery-monitor-db.ts", "test-memory-knowledge-events-db.ts",
  ],
  "test-knowledge-governance-isolated.ts": ["test-knowledge-governance-db.ts"],
  "test-knowledge-lifecycle-isolated.ts": ["test-knowledge-lifecycle-db.ts"],
  "test-knowledge-revisions-isolated.ts": ["test-knowledge-revisions-db.ts"],
  "test-character-growth-isolated.ts": ["test-character-growth-transfer-db.ts", "test-character-growth-db.ts", "test-character-portable-db.ts"],
  "test-expression-habits-isolated.ts": ["test-expression-habits-db.ts"],
  "test-goals-isolated.ts": ["test-goals-db.ts"],
  "test-knowledge-topic-isolated.ts": ["test-knowledge-topic-db.ts"],
  "test-memory-reliability-isolated.ts": [
    "test-interaction-experiences-db.ts", "test-interaction-experience-settings-db.ts", "test-interaction-experience-automatic-db.ts",
    "test-memory-scheduler-db.ts", "test-memory-events-db.ts", "test-memory-events-pending-delete-db.ts", "test-private-chat-events-db.ts",
    "test-memory-event-move-db.ts", "test-owner-private-scope-db.ts", "test-chat-private-memory-db.ts", "test-character-portable-db.ts",
    "test-memory-event-pagination-db.ts", "test-memory-item-lifecycle-db.ts", "test-memory-cleanup-dependency-db.ts",
    "test-private-chat-pagination-db.ts", "test-event-extraction-quality-db.ts", "test-memory-events-manual-queue-db.ts",
    "test-snapshot-review-db.ts", "test-memory-job-fencing-db.ts", "test-memory-scheduler-atomic-db.ts", "test-snapshot-generate-db.ts",
    "test-memory-settings-db.ts", "test-memory-progress-db.ts",
  ],
  "test-preferences-isolated.ts": ["test-preferences-db.ts"],
  "test-reflection-isolated.ts": ["test-growth-loop-db.ts", "test-experience-reflection-db.ts", "test-reflection-db.ts", "test-growth-overview-db.ts"],
  "test-scoped-growth-boundaries-isolated.ts": ["test-scoped-growth-boundaries-db.ts"],
  "test-social-relationship-assessment-isolated.ts": [
    "test-social-relationship-assessment-db.ts", "test-social-relationship-assessment-ai-db.ts", "test-social-assessment-groups-db.ts",
  ],
  "test-social-relationship-review-isolated.ts": ["test-social-relationship-review-db.ts", "test-social-history-api-db.ts"],
  "test-social-relationship-queue-isolated.ts": ["test-social-relationship-queue-db.ts"],
};

export function isolatedTestFiles(parentUrl) {
  const parent = new URL(parentUrl).pathname.split("/").pop();
  const children = isolatedSuites[parent];
  if (!children) throw new Error(`未登记的隔离测试运行器：${parent}`);
  return [...children];
}
