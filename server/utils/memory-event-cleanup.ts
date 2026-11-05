export function rawMessageCleanupDependencyCutoff(input: {
  periodEnd: Date;
  now: Date;
  retentionDays: number;
  contextRetentionDays: number;
}): Date {
  const contextDays = Math.min(input.contextRetentionDays, input.retentionDays);
  const contextCutoff = new Date(input.now.getTime() - contextDays * 24 * 60 * 60 * 1000);
  return contextCutoff > input.periodEnd ? contextCutoff : input.periodEnd;
}
