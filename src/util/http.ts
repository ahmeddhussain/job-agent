// Polite, guarded HTTP for public job feeds and careers pages (security A8, PLAN 5.1):
// https only, the host must resolve to public addresses (no SSRF into the VM, the LAN or
// a cloud metadata endpoint), one request per host per interval, Retry-After honoured,
// a timeout and a size cap, an honest User-Agent, no cookies.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and metadata ranges. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

export interface HttpOptions {
  userAgent: string;
  minIntervalMs: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** For tests: replaces DNS resolution. */
  resolve?: (host: string) => Promise<string[]>;
  /** For tests: replaces fetch. */
  fetchImpl?: typeof fetch;
  /** Base delay between retries (tests set it low). */
  retryDelayMs?: number;
}

export class PoliteHttp {
  private readonly lastByHost = new Map<string, number>();

  constructor(private readonly o: HttpOptions) {}

  private async assertPublic(url: URL): Promise<void> {
    if (url.protocol !== 'https:') throw new HttpError(`refused non-https URL: ${url.href}`, null);
    if (url.username || url.password) throw new HttpError('refused URL with credentials', null);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host)
      ? [host]
      : this.o.resolve
        ? await this.o.resolve(host)
        : (await lookup(host, { all: true })).map((a) => a.address);
    if (addrs.length === 0 || addrs.some(isPrivateAddress)) {
      throw new HttpError(`refused ${host}: resolves to a private or reserved address`, null);
    }
  }

  private async pace(host: string): Promise<void> {
    const wait = (this.lastByHost.get(host) ?? 0) + this.o.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastByHost.set(host, Date.now());
  }

  async get(raw: string, accept = 'application/json'): Promise<string> {
    let url = new URL(raw);
    for (let hop = 0; hop < 5; hop++) {
      await this.assertPublic(url); // every redirect target is checked again
      await this.pace(url.hostname);
      const res = await (this.o.fetchImpl ?? fetch)(url, {
        redirect: 'manual',
        headers: { 'User-Agent': this.o.userAgent, Accept: accept },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 30_000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new HttpError(`redirect without Location from ${url.href}`, res.status);
        url = new URL(loc, url);
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const after = Math.min(Number(res.headers.get('retry-after') ?? 30) || 30, 120);
        if (hop === 0) {
          await new Promise((r) => setTimeout(r, after * 1000));
          continue;
        }
      }
      if (!res.ok) throw new HttpError(`HTTP ${String(res.status)} from ${url.href}`, res.status);
      const body = await res.text();
      if (body.length > (this.o.maxBytes ?? 10 * 1024 * 1024)) {
        throw new HttpError(`response too large from ${url.href}`, res.status);
      }
      return body;
    }
    throw new HttpError(`too many redirects from ${raw}`, null);
  }

  /**
   * JSON with retries: this network drops and truncates responses (troubleshooting #19),
   * so a network error or a body that isn't complete JSON is retried before failing.
   */
  async json(url: string, attempts = 3): Promise<unknown> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return JSON.parse(await this.get(url)) as unknown;
      } catch (err) {
        // Refusals (SSRF guard) and HTTP 4xx are final; network/parse failures are retried.
        if (
          err instanceof HttpError &&
          (err.status === null || (err.status >= 400 && err.status < 500))
        ) {
          throw err;
        }
        last = err;
        await new Promise((r) => setTimeout(r, (this.o.retryDelayMs ?? 3000) * (i + 1)));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}
