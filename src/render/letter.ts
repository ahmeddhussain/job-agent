// The cover letter as a PDF, for forms that want a file (D49). Same text as everywhere else.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Profile } from '../profile/load.js';
import { contactLine, fileName } from './cv.js';
import { Renderer, renderTemplate } from './renderer.js';

export async function letterPdf(
  p: Profile,
  text: string,
  dir: string,
  openRenderer: () => Promise<Renderer> = () => Renderer.open(),
): Promise<string> {
  const path = join(dir, fileName(p, 'Cover-Letter'));
  const source = `${path}.txt`;
  // Rendered again only when the letter was edited.
  if (existsSync(path) && existsSync(source) && statSync(path).size > 0)
    if (readFileSync(source, 'utf8') === text) return path;
  const html = renderTemplate('letter', {
    name: p.candidate.full_name,
    contact: contactLine(p),
    paragraphs: text
      .trim()
      .split(/\n\s*\n/)
      .map((x) => x.trim()),
    fontPt: 11,
  });
  const r = await openRenderer();
  try {
    writeFileSync(path, await r.pdf(html), { mode: 0o600 });
    writeFileSync(source, text, { mode: 0o600 });
  } finally {
    await r.close();
  }
  return path;
}
