// Email applications (PLAN 9): MIME with the CV and cover letter, then a Gmail draft
// (default) or, in send mode, a send. Recipients come only from the validated job
// (apply_email copied literally from the post); the model never chooses them.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { GmailWriter } from '../gmail/client.js';
import { buildMime } from '../gmail/mime.js';
import type { Profile } from '../profile/load.js';

export function emailSubject(p: Profile, title: string, hint: string | null): string {
  return hint ?? `Application – ${title} – ${p.candidate.first_name} ${p.candidate.last_name}`;
}

export function signature(p: Profile): string {
  const c = p.candidate;
  const label: Record<string, string> = {
    github: 'GitHub',
    linkedin: 'LinkedIn',
    portfolio: 'Portfolio',
  };
  return [
    'Best regards,',
    `${c.first_name} ${c.last_name}`,
    [c.phone, c.phone_alt].filter(Boolean).join(' | '),
    ...Object.entries(c.links).map(([k, u]) => `${label[k] ?? k}: ${u}`),
  ].join('\n');
}

export interface EmailApplication {
  to: string;
  subject: string;
  body: string;
  cvPath: string;
  coverPath: string;
}

export class WrongAccountError extends Error {
  override name = 'WrongAccountError';
}

function mime(p: Profile, a: EmailApplication): string {
  return buildMime({
    fromName: `${p.candidate.first_name} ${p.candidate.last_name}`,
    fromEmail: p.candidate.email,
    to: a.to,
    subject: a.subject,
    text: `${a.body.trim()}\n\n${signature(p)}\n`,
    attachments: [a.cvPath, a.coverPath].map((path) => ({
      filename: basename(path),
      contentType: 'application/pdf',
      content: readFileSync(path),
    })),
  });
}

/** Creates the draft; refuses if Gmail is authorized as a different account than the profile's. */
export async function draftApplication(gmail: GmailWriter, p: Profile, a: EmailApplication) {
  const me = await gmail.myAddress();
  if (me !== p.candidate.email.toLowerCase()) {
    throw new WrongAccountError(
      `Gmail is authorized as ${me}, but the profile email is ${p.candidate.email}`,
    );
  }
  return gmail.createDraft(mime(p, a));
}
