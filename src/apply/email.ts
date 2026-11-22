// Email applications (PLAN 9, D28): the cover letter is the email body, the CV the only
// attachment; then a Gmail draft
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

/** Name and contact lines under the letter's closing (one public phone, links in full). */
export function signature(p: Profile): string {
  const c = p.candidate;
  const label: Record<string, string> = {
    github: 'GitHub',
    linkedin: 'LinkedIn',
    portfolio: 'Portfolio',
  };
  return [
    `${c.first_name} ${c.last_name}`,
    [c.phone, c.phone_alt].filter(Boolean).join(' | '),
    ...Object.entries(c.links).map(([k, u]) => `${label[k] ?? k}: ${u}`),
  ].join('\n');
}

export interface Letter {
  greeting: string;
  paragraphs: string[];
  closing: string;
}

/** The application email body: the tailored cover letter, then the signature (D28). */
export function emailBody(p: Profile, letter: Letter): string {
  return `${[letter.greeting, ...letter.paragraphs, letter.closing].map((x) => x.trim()).join('\n\n')}\n${signature(p)}\n`;
}

/** Plain cover-letter text for form applications' paste boxes (no signature block). */
export function coverLetterText(p: Profile, letter: Letter): string {
  return `${[letter.greeting, ...letter.paragraphs, letter.closing, `${p.candidate.first_name} ${p.candidate.last_name}`].map((x) => x.trim()).join('\n\n')}\n`;
}

export interface EmailApplication {
  to: string;
  subject: string;
  /** Final body text (emailBody()). */
  body: string;
  cvPath: string;
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
    text: a.body,
    attachments: [
      {
        filename: basename(a.cvPath),
        contentType: 'application/pdf',
        content: readFileSync(a.cvPath),
      },
    ],
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
