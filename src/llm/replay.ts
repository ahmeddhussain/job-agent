// Record/replay of model outputs (PLAN 15): `npm test` and CI replay recorded
// structured outputs, so they never call Claude. Only validated outputs are stored.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Llm, LlmRequest } from './types.js';

function fileFor(dir: string, key: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`invalid replay key: ${key}`);
  return join(dir, `${key}.json`);
}

export class ReplayLlm implements Llm {
  constructor(private readonly dir: string) {}

  call<T>(req: LlmRequest<T>): Promise<T> {
    if (!req.key) return Promise.reject(new Error('replay needs a request key'));
    const path = fileFor(this.dir, req.key);
    if (!existsSync(path)) {
      return Promise.reject(
        new Error(`no recording for ${req.key}; run: agent run --dry-run --fixtures --record`),
      );
    }
    return Promise.resolve(req.schema.parse(JSON.parse(readFileSync(path, 'utf8'))));
  }
}

export class RecordingLlm implements Llm {
  constructor(
    private readonly inner: Llm,
    private readonly dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  async call<T>(req: LlmRequest<T>): Promise<T> {
    const value = await this.inner.call(req);
    if (req.key) writeFileSync(fileFor(this.dir, req.key), `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }
}
