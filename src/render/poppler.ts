// Thin wrappers over poppler-utils: what an ATS parser sees in a PDF.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OPTS = { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 };

export async function pdfInfo(path: string): Promise<{ pages: number; heightPt: number }> {
  const { stdout } = await run('pdfinfo', [path], OPTS);
  const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1] ?? NaN);
  const heightPt = Number(/^Page size:\s+[\d.]+ x ([\d.]+) pts/m.exec(stdout)?.[1] ?? NaN);
  if (!Number.isFinite(pages) || !Number.isFinite(heightPt))
    throw new Error(`pdfinfo: unreadable output for ${path}`);
  return { pages, heightPt };
}

/** Plain text in reading order, as a parser would extract it. */
export async function pdfText(path: string): Promise<string> {
  const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', path, '-'], OPTS);
  return stdout;
}

/** Lowest text position on page 1 (points from the top), to measure how full the page is. */
export async function lastTextY(path: string): Promise<number> {
  const { stdout } = await run('pdftotext', ['-bbox', '-f', '1', '-l', '1', path, '-'], OPTS);
  let max = 0;
  for (const m of stdout.matchAll(/yMax="([\d.]+)"/g)) max = Math.max(max, Number(m[1]));
  return max;
}

export async function imageCount(path: string): Promise<number> {
  const { stdout } = await run('pdfimages', ['-list', path], OPTS);
  return stdout
    .split('\n')
    .slice(2)
    .filter((l) => l.trim() !== '').length;
}

/** Fonts that are not embedded (an ATS or a recruiter's machine may render them wrongly). */
export async function unembeddedFonts(path: string): Promise<string[]> {
  const { stdout } = await run('pdffonts', [path], OPTS);
  const lines = stdout
    .split('\n')
    .slice(2)
    .filter((l) => l.trim() !== '');
  // Columns: name type encoding emb sub uni object ID; "emb" is the 5th token from the right.
  return lines
    .filter((l) => l.trim().split(/\s+/).at(-5) !== 'yes')
    .map((l) => l.split(/\s+/)[0] ?? l);
}
