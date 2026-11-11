/** Purpose defaults only: never provider model IDs, credentials or enabled switches. */
export const MODEL_PURPOSE_DEFAULTS = {
  chat: { temperature: 0.7, maxOutputTokens: 4096 },
  memory: { temperature: 0.1, maxInputTokens: 12288, maxOutputTokens: 2048 },
  context: { temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 2048 },
  knowledge: { temperature: 0.1, maxInputTokens: 12288, maxOutputTokens: 4096 },
  social: { temperature: 0.1, maxInputTokens: 16384, maxOutputTokens: 8192 },
  voice: { speed: 1 },
} as const;
