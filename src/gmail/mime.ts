// RFC 5322 / MIME builder for application emails: a UTF-8 text body plus PDF attachments,
// returned as the base64url `raw` string the Gmail API takes (drafts.create, messages.send).

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailInput {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  text: string;
  attachments?: Attachment[];
}

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

/** RFC 2047 encoded-word for non-ASCII header text (e.g. the en dash in our subjects). */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

/** Header values must not carry line breaks (header injection). */
function oneLine(v: string, name: string): string {
  if (/[\r\n]/.test(v)) throw new Error(`${name} contains a line break`);
  return v;
}

export function buildMime(m: MailInput, boundary = `ja_${Date.now().toString(36)}`): string {
  if (!EMAIL_RE.test(m.to)) throw new Error(`invalid recipient: ${m.to}`);
  if (!EMAIL_RE.test(m.fromEmail)) throw new Error(`invalid sender: ${m.fromEmail}`);
  const headers = [
    `From: ${encodeHeader(oneLine(m.fromName, 'From name'))} <${m.fromEmail}>`,
    `To: ${oneLine(m.to, 'To')}`,
    `Subject: ${encodeHeader(oneLine(m.subject, 'Subject'))}`,
    'MIME-Version: 1.0',
  ];
  const body = wrap76(Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
  const atts = m.attachments ?? [];
  let msg: string;
  if (atts.length === 0) {
    msg = [
      ...headers,
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
  } else {
    const parts = [
      [
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        body,
      ].join('\r\n'),
      ...atts.map((a) => {
        const name = oneLine(a.filename, 'filename').replace(/"/g, '');
        return [
          `--${boundary}`,
          `Content-Type: ${a.contentType}; name="${name}"`,
          `Content-Disposition: attachment; filename="${name}"`,
          'Content-Transfer-Encoding: base64',
          '',
          wrap76(a.content.toString('base64')),
        ].join('\r\n');
      }),
    ];
    msg = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      ...parts,
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }
  return Buffer.from(msg, 'utf8').toString('base64url');
}
