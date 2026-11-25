// Application emails (D53): which emails are read, and what one says. LinkedIn's and
// Indeed's own notices are parsed by code; the rest goes to the model, whose answer counts
// only if its quote, company and title are really in the email.
import { alertToText } from '../collect/alerts.js';
import type { MailSummary } from '../gmail/client.js';
import { ApplicationMailSchema, type MAIL_KINDS } from '../llm/schemas.js';
import type { Llm } from '../llm/types.js';
import { loadPrompt } from '../pipeline/extract.js';
import { hashKey, tokens } from '../util/text.js';

export type MailKind = (typeof MAIL_KINDS)[number];

export interface MailFacts {
  kind: MailKind;
  company: string | null;
  title: string | null;
  quote: string | null;
  /** LinkedIn job link from the notice: the surest match with a stored job. */
  applyUrl: string | null;
}

export const NONE: MailFacts = {
  kind: 'none',
  company: null,
  title: null,
  quote: null,
  applyUrl: null,
};

const FREEMAIL =
  /@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|aol|proton(mail)?|gmx|mail)\.[a-z.]+$/i;

export function addressOf(header: string): string {
  return (
    /<([^<>\s]+@[^<>\s]+)>/.exec(header)?.[1] ??
    /[^\s<>"',;]+@[^\s<>"',;]+/.exec(header)?.[0] ??
    ''
  )
    .trim()
    .toLowerCase();
}

export const isFreemail = (address: string): boolean => FREEMAIL.test(address);

// ------------------------------------------------------------------ what is searched

const TERMS = [
  '"your application"',
  '"the application"',
  '"application received"',
  '"application status"',
  '"thank you for applying"',
  '"thanks for applying"',
  '"for applying"',
  '"you applied"',
  '"your interest in"',
  '"your candidacy"',
  '"hiring process"',
  '"recruitment process"',
  'interview',
  'assessment',
  '"طلبك"',
  '"مقابلة"',
];

/** Gmail queries: answers, CVs sent by hand, and everything from people applied to. */
export function mailQueries(since: Date, knownSenders: string[]): string[] {
  const after = `after:${String(Math.floor(since.getTime() / 1000))}`;
  const own = '-in:sent -in:drafts -in:chats -in:trash';
  const out = [
    `${after} ${own} -category:promotions {${TERMS.join(' ')}}`,
    `${after} in:sent has:attachment {filename:pdf filename:docx}`,
  ];
  for (let i = 0; i < knownSenders.length; i += 30)
    out.push(
      `${after} ${own} {${knownSenders
        .slice(i, i + 30)
        .map((s) => `from:${s.replace(/[^\w@.+-]/g, '')}`)
        .join(' ')}}`,
    );
  return out;
}

/** The people and companies applied to: whole domains, but single addresses at Gmail and the like. */
export function knownSenders(addresses: string[]): string[] {
  return [
    ...new Set(
      addresses
        .map((a) => addressOf(a))
        .filter((a) => a.includes('@'))
        .map((a) => (isFreemail(a) ? a : (a.split('@')[1] ?? a))),
    ),
  ];
}

// ------------------------------------------------------------------ what is worth reading

const SUBJECT_RE =
  /applica|apply|applied|interview|assess|candida|recruit|hiring|position|vacanc|\bjob\b|\boffer\b|next step|technical (test|task|exercise)|practical test|online test|your cv|resume|طلب|مقابل|وظيف|تقديم|توظيف/i;
const BODY_RE =
  /\byour ([^\n.]{0,40} )?application\b|\bthe (job )?application\b|thank(s| you) for (applying|your (interest|application))|you(’|'| ha)?ve? (recently )?applied|invit(e|ing|ation)[^.]{0,60}(interview|assessment|call|test)|(schedule|book)[^.]{0,40}interview|your candidacy|move forward with|regret to inform|not (been )?(selected|shortlisted|successful)|other candidates|طلب (التوظيف|التقديم)|مقابلة/i;

/**
 * Whether the model reads an email at all. Mail from a private (free-mail) address is read
 * only if the user applied to that address: friends' mail stays unread.
 */
export function worthReading(
  m: MailSummary,
  me: string,
  known: ReadonlySet<string>,
  skipFrom: string[],
): boolean {
  const from = addressOf(m.from);
  const sent = m.labelIds.includes('SENT');
  if (m.labelIds.includes('DRAFT') || m.labelIds.includes('TRASH')) return false;
  if (sent) return addressOf(m.to) !== me && addressOf(m.to) !== '';
  if (from === me || skipFrom.some((s) => from.includes(s.toLowerCase()))) return false;
  if (known.has(from) || known.has(from.split('@')[1] ?? '')) return true;
  if (isFreemail(from)) return false;
  return SUBJECT_RE.test(m.subject) || BODY_RE.test(mailText(m, 4000));
}

/** Subject and body without links: what the model reads and quotes are checked against. */
export function mailText(m: MailSummary, maxChars: number): string {
  return alertToText(m, 200_000)
    .replace(/^Subject:.*\nFrom:.*\n/, '')
    .replace(/\(?https?:\/\/[^\s)]+\)?/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, maxChars);
}

// ------------------------------------------------------------------ notices parsed by code

const REJECTION_RE =
  /not be moving forward|won(’|')t be moving forward|unfortunately|not selected|no longer (accepting|under consideration)|decided not to/i;

/** LinkedIn and Indeed notices have fixed formats; anything unexpected is left to the model. */
export function parseNotice(m: MailSummary): MailFacts | null {
  const from = addressOf(m.from);
  const text = alertToText(m, 200_000);
  if (from === 'jobs-noreply@linkedin.com') {
    const sent = /your application was sent to (.+)$/i.exec(m.subject);
    const viewed = /^your application was viewed by (.+)$/i.exec(m.subject);
    const update = /^your application to (.+) at (.+)$/i.exec(m.subject);
    const company = (sent?.[1] ?? viewed?.[1] ?? update?.[2])?.trim();
    if (!company) return null;
    // "Title (https://linkedin.com/jobs/view/123)", then "Company · Location": the first one
    // is the job itself; the rest are recommendations, so the company must match.
    const job = /^(\S.*?) \((https:\/\/linkedin\.com\/jobs\/view\/\d+)\)\s*\n\s*(\S.*?) · /m.exec(
      text,
    );
    const mine = job && hashKey(job[3] ?? '') === hashKey(company) ? job : null;
    let kind: MailKind = sent ? 'applied' : 'viewed';
    let quote = m.subject;
    if (update) {
      // Only the part about this job, before the recommendations.
      const end = text.search(/TOP JOBS|SIMILAR JOBS/i);
      const line = (end < 0 ? text : text.slice(0, end))
        .split('\n')
        .find((l) => REJECTION_RE.test(l));
      if (!line) return null;
      kind = 'rejected';
      quote =
        line
          .split(/(?<=[.!])\s+/)
          .find((s) => REJECTION_RE.test(s))
          ?.trim() ?? line.trim();
    }
    return {
      kind,
      company,
      title: (update?.[1] ?? mine?.[1])?.trim() ?? null,
      quote: quote.slice(0, 300),
      applyUrl: mine?.[2] ?? null,
    };
  }
  if (from === 'indeedapply@indeed.com') {
    const title = /^indeed application: (.+)$/i.exec(m.subject)?.[1]?.trim();
    if (!title) return null;
    const company =
      /^(\S.*?) \(https:\/\/[a-z.]*indeed\.com\/cmp\/[^)]*\)\s*-/m.exec(text)?.[1] ??
      /The following items were sent to (.+?)\. Good luck/.exec(text)?.[1] ??
      null;
    return {
      kind: 'applied',
      company: company?.trim() ?? null,
      title,
      quote: m.subject,
      applyUrl: null,
    };
  }
  return null;
}

// ------------------------------------------------------------------ the model, and its check

/** Removes tags that could close or fake the email block. */
const fenceMail = (t: string) => t.replace(/<\/?\s*email\b[^>]*>/gi, '[tag removed]');

/** Drops what the email doesn't contain: a quote is the evidence for everything else. */
export function checkFacts(
  f: { kind: MailKind; company: string | null; title: string | null; quote: string },
  m: MailSummary,
  bodyChars: number,
): MailFacts {
  if (f.kind === 'none') return NONE;
  const text = `${m.subject}\n${mailText(m, bodyChars)}`;
  const flat = hashKey(text);
  const quote = f.quote.trim();
  const quoted = tokens(quote).length >= 2 && flat.includes(hashKey(quote));
  const sent = m.labelIds.includes('SENT');
  // A sent CV often has no text to quote: the attachment and the recipient are the evidence.
  if (!quoted && !(sent && f.kind === 'applied')) return NONE;
  const where = `${flat} ${hashKey(`${m.from} ${sent ? m.to : ''}`)}`;
  const packed = where.replace(/[^\p{L}\p{N}]+/gu, '');
  const inMail = (v: string | null) => {
    const k = hashKey(v ?? '');
    return k.length > 1 && (where.includes(k) || packed.includes(k.replace(/[^\p{L}\p{N}]+/gu, '')))
      ? (v ?? '').trim()
      : null;
  };
  // Placeholders some systems leave in ("Thanks for applying to Company").
  const company = /^(the |our )?(company|client|employer|confidential|hiring team)$/i.test(
    f.company?.trim() ?? '',
  )
    ? null
    : inMail(f.company);
  const words = new Set(tokens(where));
  const title = f.title?.trim() ?? null;
  const titleWords = tokens(title ?? '');
  const titleOk =
    titleWords.length > 0 &&
    titleWords.filter((w) => words.has(w)).length / titleWords.length >= 0.8;
  return {
    kind: sent ? (f.kind === 'applied' ? 'applied' : 'none') : f.kind,
    company,
    title: titleOk ? title : null,
    quote: quoted ? quote : m.subject,
    applyUrl: null,
  };
}

export async function readMails(
  llm: Llm,
  model: string,
  mails: MailSummary[],
  bodyChars: number,
  timeoutMs: number,
): Promise<MailFacts[]> {
  const res = await llm.call({
    purpose: 'mail',
    model,
    system: loadPrompt('application-mail'),
    prompt: mails
      .map((m, i) =>
        [
          `<email id="${String(i + 1)}">`,
          m.labelIds.includes('SENT') ? 'direction: sent\nattachment: yes' : 'direction: received',
          fenceMail(
            `from: ${m.from}\nto: ${m.to}\ndate: ${m.internalDate.slice(0, 10)}\nsubject: ${m.subject}\n\n${mailText(m, bodyChars)}`,
          ),
          '</email>',
        ].join('\n'),
      )
      .join('\n\n'),
    schema: ApplicationMailSchema,
    timeoutMs,
  });
  return mails.map((m, i) => {
    const f = res.mails.find((x) => x.id === i + 1);
    return f ? checkFacts(f, m, bodyChars) : NONE;
  });
}
