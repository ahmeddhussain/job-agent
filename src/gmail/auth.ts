// Gmail OAuth (PLAN 12): desktop "installed app" flow with a loopback redirect on
// 127.0.0.1, PKCE and a random state. Scopes: gmail.readonly + gmail.compose only.
// The client secret and token live in secrets/ (0700, gitignored, secret-scanned).
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import { z } from 'zod';
import type { Config } from '../config.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

const ClientFile = z.object({
  installed: z.object({ client_id: z.string().min(10), client_secret: z.string().min(5) }),
});

export class GmailAuthError extends Error {
  override name = 'GmailAuthError';
}

function readClient(path: string): { clientId: string; clientSecret: string } {
  if (!existsSync(path)) {
    throw new GmailAuthError(
      `${path} not found. Follow docs/gmail-setup.md (Desktop app OAuth client).`,
    );
  }
  const parsed = ClientFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new GmailAuthError(
      `${path} is not a "Desktop app" OAuth client file (expected an "installed" section).`,
    );
  }
  return {
    clientId: parsed.data.installed.client_id,
    clientSecret: parsed.data.installed.client_secret,
  };
}

function saveToken(path: string, tokens: Credentials): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** An authorized client; refreshed tokens are written back to the token file. */
export function gmailAuthClient(cfg: Config): OAuth2Client {
  const { clientId, clientSecret } = readClient(cfg.gmail.client_file);
  if (!existsSync(cfg.gmail.token_file)) {
    throw new GmailAuthError(`not authorized yet: run  npm run agent -- gmail:auth`);
  }
  const { authorized_at: authorizedAt, ...stored } = JSON.parse(
    readFileSync(cfg.gmail.token_file, 'utf8'),
  ) as Credentials & { authorized_at?: string };
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(stored);
  client.on('tokens', (t) => {
    saveToken(cfg.gmail.token_file, {
      ...(authorizedAt ? { authorized_at: authorizedAt } : {}),
      ...stored,
      ...t,
      refresh_token: t.refresh_token ?? stored.refresh_token ?? null,
    });
  });
  return client;
}

/**
 * Interactive authorization (`gmail:auth`): prints the consent URL, waits for Google to
 * redirect to http://127.0.0.1:<port>/ with the code, exchanges it and saves the token.
 */
export async function authorize(
  cfg: Config,
  out: (line: string) => void,
  timeoutSeconds = 300,
): Promise<void> {
  const { clientId, clientSecret } = readClient(cfg.gmail.client_file);
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${String(port)}/`;
  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();

  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    scope: SCOPES,
    state,
    code_challenge: codeChallenge ?? '',
    code_challenge_method: CodeChallengeMethod.S256,
  });
  out('Open this link in a browser on this machine and allow access:');
  out(url);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new GmailAuthError(`no authorization within ${String(timeoutSeconds)} s`));
      }, timeoutSeconds * 1000);
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const err = u.searchParams.get('error');
        const got = u.searchParams.get('code');
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400).end('State mismatch: ignored.');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(err ? `Authorization failed: ${err}` : 'Authorized. You can close this tab.');
        clearTimeout(timer);
        if (err || !got) reject(new GmailAuthError(`authorization failed: ${err ?? 'no code'}`));
        else resolve(got);
      });
    });
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    const granted = (tokens.scope ?? '').split(' ');
    const missing = SCOPES.filter((s) => !granted.includes(s));
    if (missing.length > 0) {
      throw new GmailAuthError(
        `permissions not granted: ${missing.join(', ')} (tick both boxes on the consent screen)`,
      );
    }
    if (!tokens.refresh_token) {
      throw new GmailAuthError(
        'Google returned no refresh token; remove the app at myaccount.google.com/permissions and retry',
      );
    }
    saveToken(cfg.gmail.token_file, {
      ...tokens,
      authorized_at: new Date().toISOString(),
    } as Credentials);
    out(`Authorized. Token saved to ${cfg.gmail.token_file} (owner-only).`);
  } finally {
    server.close();
  }
}

/** Days since `gmail:auth` (Testing-mode apps get tokens that expire after 7 days). */
export function tokenAgeDays(cfg: Config, now = new Date()): number | null {
  if (!existsSync(cfg.gmail.token_file)) return null;
  const at = (JSON.parse(readFileSync(cfg.gmail.token_file, 'utf8')) as { authorized_at?: string })
    .authorized_at;
  return at ? (now.getTime() - Date.parse(at)) / 86_400_000 : null;
}

const REAUTH =
  'Gmail authorization expired or was revoked. Run:  npm run agent -- gmail:auth   (an app in Testing mode gets tokens that Google expires every 7 days)';

/** Turns Google's token errors into one clear instruction; other errors pass through. */
export function explainGmailError(err: unknown): never {
  const e = err as {
    message?: string;
    code?: number | string;
    response?: { data?: { error?: unknown } };
  };
  const text = `${e.message ?? ''} ${JSON.stringify(e.response?.data?.error ?? '')}`;
  // 403 SERVICE_DISABLED: the Gmail API isn't enabled in the OAuth client's project.
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project/i.test(text)) {
    const url =
      /https:\/\/console\.developers\.google\.com\/apis\/api\/gmail\.googleapis\.com\/overview\?project=\d+/.exec(
        text,
      )?.[0];
    throw new GmailAuthError(
      `The Gmail API is not enabled in the Google Cloud project of your OAuth client. Enable it here, wait a minute, then retry:\n  ${url ?? 'https://console.cloud.google.com/apis/library/gmail.googleapis.com'}`,
      { cause: err },
    );
  }
  if (/invalid_grant|invalid_token|unauthorized_client/i.test(text) || e.code === 401) {
    throw new GmailAuthError(REAUTH, { cause: err });
  }
  throw err;
}
