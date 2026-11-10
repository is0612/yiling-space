export function superviseMemoryWorker(options: {
  root: string;
  env?: NodeJS.ProcessEnv;
  log?: (entry: Record<string, unknown>) => void;
  command?: string;
  args?: string[];
  retryMs?: number;
  maxRetryMs?: number;
  stopMs?: number;
}): Promise<{ disabled: boolean; owned(): boolean; stop(): Promise<void> }>;
