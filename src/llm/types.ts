import type { z } from 'zod';

export type LlmPurpose =
  'preflight' | 'extract' | 'score' | 'tailor' | 'form' | 'interview' | 'init';

export interface LlmRequest<T> {
  purpose: LlmPurpose;
  model: string;
  /** Instructions + cached context (e.g. the profile). Never contains job-post text. */
  system: string;
  /** The task, with untrusted text inside delimited blocks. */
  prompt: string;
  schema: z.ZodType<T>;
  /** Stable name for record/replay (e.g. "04-multi-job.extract"). */
  key?: string;
  jobId?: number | null;
  /** Overrides the client's default timeout (tailoring takes longer). */
  timeoutMs?: number;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
}

export interface LlmCallRecord {
  purpose: LlmPurpose;
  model: string;
  usage: LlmUsage | null;
  ok: boolean;
  jobId: number | null;
  durationMs: number;
}

export interface Llm {
  call<T>(req: LlmRequest<T>): Promise<T>;
}

/** The subscription's usage limit was reached: stop calling the model this run (R18). */
export class UsageLimitError extends Error {
  override name = 'UsageLimitError';
}

/** Authentication is not the subscription, or the guard found an API key (D17). */
export class AuthGuardError extends Error {
  override name = 'AuthGuardError';
}

export class LlmError extends Error {
  override name = 'LlmError';
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
