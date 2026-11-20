// collect:whatsapp-export (D3 fallback): parses a chat exported from the phone
// ("Export chat" → without media), so collection keeps working if whatsapp-web.js
// breaks after a WhatsApp Web update. Handles the Android and iOS line formats.
import { sha256 } from '../../util/hash.js';

export interface ExportedMessage {
  posted_at: string;
  author: string;
  text: string;
}

// Android: 20/11/2026, 07:12 - Name: text      (also "7:12 am", "7:12 PM")
// iOS:     [20/11/2026, 07:12:33] Name: text
const LINE =
  /^\u200e?\[?(\d{1,2})[/.](\d{1,2})[/.](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\]?\s*(?:-\s*)?([^:]{1,80}?):\s([\s\S]*)$/i;

/** Wall-clock time in `timeZone` → UTC, using the platform's tz database (handles DST). */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const offsetAt = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(
      Number(p['year']),
      Number(p['month']) - 1,
      Number(p['day']),
      Number(p['hour']),
      Number(p['minute']),
      Number(p['second']),
    );
    return asUtc - t;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

export function parseWhatsAppExport(
  content: string,
  opts: { dateOrder: 'dmy' | 'mdy'; timeZone: string },
): ExportedMessage[] {
  const out: ExportedMessage[] = [];
  let cur: ExportedMessage | null = null;
  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const m = LINE.exec(raw);
    if (m) {
      if (cur) out.push(cur);
      const a = Number(m[1]);
      const b = Number(m[2]);
      const [day, month] = opts.dateOrder === 'dmy' ? [a, b] : [b, a];
      let year = Number(m[3]);
      if (year < 100) year += 2000;
      let hour = Number(m[4]);
      const ampm = m[7]?.toLowerCase().replace(/\./g, '');
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      const at = zonedToUtc(year, month, day, hour, Number(m[5]), Number(m[6] ?? 0), opts.timeZone);
      cur = { posted_at: at.toISOString(), author: (m[8] ?? '').trim(), text: m[9] ?? '' };
    } else if (cur) {
      cur.text += `\n${raw}`; // continuation of a multi-line message
    }
    // Lines before the first message and system lines without "Name:" are ignored.
  }
  if (cur) out.push(cur);
  return out
    .map((x) => ({ ...x, text: x.text.trim() }))
    .filter((x) => x.text !== '' && !/^<(media omitted|attached:)/i.test(x.text));
}

/** Stable source_ref for an exported message (exports carry no message ids). */
export function exportRef(group: string, msg: ExportedMessage): string {
  return `export:${sha256(`${group}|${msg.posted_at}|${msg.author}|${msg.text.slice(0, 200)}`).slice(0, 32)}`;
}
