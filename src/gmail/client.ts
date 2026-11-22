// GmailFacade: the ONLY module that may import @googleapis/gmail (security A10).
// It exposes reading, draft creation and draft inspection; sending exists for two
// guarded uses only (send mode, and the digest to Ahmed himself). There is no delete,
// trash, label change, filter or settings call anywhere; a test enforces it.
import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';

export interface MailSummary {
  id: string;
  threadId: string;
  internalDate: string;
  from: string;
  to: string;
  subject: string;
  labelIds: string[];
  html: string | null;
  text: string | null;
}

export interface GmailReader {
  myAddress(): Promise<string>;
  search(query: string, max: number): Promise<string[]>;
  getMessage(id: string): Promise<MailSummary>;
}

export interface GmailWriter extends GmailReader {
  createDraft(raw: string): Promise<{ draftId: string; messageId: string; threadId: string }>;
  draftExists(draftId: string): Promise<boolean>;
  threadMessages(
    threadId: string,
  ): Promise<{ id: string; labelIds: string[]; from: string; internalDate: string }[]>;
  /** Only callers: apply in send mode (all guards passed) and the digest to Ahmed. */
  sendRaw(raw: string): Promise<{ messageId: string; threadId: string }>;
  sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }>;
}

const header = (h: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string) =>
  h?.find((x) => x.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

function decode(data: string | null | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

/** First text/html and text/plain bodies found, depth-first. */
function bodies(
  p: gmail_v1.Schema$MessagePart | undefined,
  acc: { html: string | null; text: string | null },
) {
  if (!p) return acc;
  if (p.mimeType === 'text/html' && acc.html === null && p.body?.data)
    acc.html = decode(p.body.data);
  if (p.mimeType === 'text/plain' && acc.text === null && p.body?.data)
    acc.text = decode(p.body.data);
  for (const c of p.parts ?? []) bodies(c, acc);
  return acc;
}

export class GmailFacade implements GmailWriter {
  private readonly api: gmail_v1.Gmail;
  private address: string | null = null;

  constructor(auth: OAuth2Client) {
    this.api = gmail({ version: 'v1', auth });
  }

  async myAddress(): Promise<string> {
    if (this.address) return this.address;
    const r = await this.api.users.getProfile({ userId: 'me' });
    this.address = (r.data.emailAddress ?? '').toLowerCase();
    return this.address;
  }

  async search(query: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.api.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: Math.min(100, max),
        ...(pageToken ? { pageToken } : {}),
      });
      for (const m of r.data.messages ?? []) if (m.id) ids.push(m.id);
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < max);
    return ids.slice(0, max);
  }

  async getMessage(id: string): Promise<MailSummary> {
    const r = await this.api.users.messages.get({ userId: 'me', id, format: 'full' });
    const m = r.data;
    const h = m.payload?.headers;
    const b = bodies(m.payload, { html: null, text: null });
    return {
      id: m.id ?? id,
      threadId: m.threadId ?? '',
      internalDate: new Date(Number(m.internalDate ?? 0)).toISOString(),
      from: header(h, 'From'),
      to: header(h, 'To'),
      subject: header(h, 'Subject'),
      labelIds: m.labelIds ?? [],
      html: b.html,
      text: b.text,
    };
  }

  async createDraft(raw: string) {
    const r = await this.api.users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });
    return {
      draftId: r.data.id ?? '',
      messageId: r.data.message?.id ?? '',
      threadId: r.data.message?.threadId ?? '',
    };
  }

  async draftExists(draftId: string): Promise<boolean> {
    try {
      await this.api.users.drafts.get({ userId: 'me', id: draftId, format: 'minimal' });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 404) return false;
      throw err;
    }
  }

  async threadMessages(threadId: string) {
    const r = await this.api.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['From'],
    });
    return (r.data.messages ?? []).map((m) => ({
      id: m.id ?? '',
      labelIds: m.labelIds ?? [],
      from: header(m.payload?.headers, 'From'),
      internalDate: new Date(Number(m.internalDate ?? 0)).toISOString(),
    }));
  }

  async sendRaw(raw: string) {
    const r = await this.api.users.messages.send({ userId: 'me', requestBody: { raw } });
    return { messageId: r.data.id ?? '', threadId: r.data.threadId ?? '' };
  }

  async sendDraft(draftId: string) {
    const r = await this.api.users.drafts.send({ userId: 'me', requestBody: { id: draftId } });
    return { messageId: r.data.id ?? '', threadId: r.data.threadId ?? '' };
  }
}

/** Link that opens a draft in Gmail's web UI (dashboard and digest). */
export function draftUrl(messageId: string): string {
  return `https://mail.google.com/mail/u/0/#drafts?compose=${encodeURIComponent(messageId)}`;
}
