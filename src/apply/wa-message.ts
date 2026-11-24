// The WhatsApp application (D51): the number, and the message that goes with the CV. The agent
// never sends it: the user's own browser shows it and the user presses Send.

/** WhatsApp's limit for the text under a document. */
export const CAPTION_MAX = 1000;

/** The number as digits, Egyptian local numbers made international; null if unusable. */
export function waNumber(phone: string | null): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (/^01\d{9}$/.test(digits)) return `20${digits.slice(1)}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

/** The letter's own paragraphs, in order, as many as fit: greeting, opening and sign-off first. */
export function waMessage(letter: string, max = CAPTION_MAX): string {
  const p = letter
    .trim()
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const join = (keep: Set<number>) => p.filter((_, i) => keep.has(i)).join('\n\n');
  const first = /^(dear|hello|hi)\b/i.test(p[0] ?? '') ? [0, 1] : [0];
  const regards = p.findIndex((x) =>
    /^(best|kind|warm)? ?regards|^sincerely|^thank you,?$/i.test(x),
  );
  const keep = new Set<number>();
  const add = (i: number) => {
    if (i < 0 || i >= p.length || keep.has(i)) return;
    if (join(new Set([...keep, i])).length <= max) keep.add(i);
  };
  for (const i of first) add(i);
  if (regards >= 0) for (let i = regards; i < p.length; i++) add(i);
  // Then the closing paragraph (it mentions the CV), then the rest from the top.
  add((regards >= 0 ? regards : p.length) - 1);
  for (let i = 0; i < p.length; i++) add(i);
  return join(keep);
}
