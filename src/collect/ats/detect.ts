// ats:detect <careers-url> (D5): recognises the ATS behind a careers URL, or behind the
// page it serves, and returns the companies.yaml entry.
import type { PoliteHttp } from '../../util/http.js';
import type { AtsKind } from './adapters.js';

export interface Detected {
  ats: AtsKind;
  board: string;
}

const PATTERNS: [AtsKind, RegExp][] = [
  [
    'greenhouse',
    /(?:job-)?boards(?:-api)?\.greenhouse\.io\/(?:embed\/job_board\?for=|v1\/boards\/)?([A-Za-z0-9_-]+)/i,
  ],
  ['lever', /jobs\.lever\.co\/([A-Za-z0-9._-]+)/i],
  ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9._-]+)/i],
  // `apply.` is Workable's own host, not an account subdomain.
  [
    'workable',
    /apply\.workable\.com\/([A-Za-z0-9_-]+)|https?:\/\/(?!apply\.)([A-Za-z0-9-]+)\.workable\.com/i,
  ],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i],
];

const NOT_BOARDS = new Set(['embed', 'api', 'v1', 'jobs', 'j', 'careers', 'www', 'apply']);

/** Finds an ATS board reference in a URL or in page HTML. */
export function detectIn(text: string): Detected | null {
  for (const [ats, re] of PATTERNS) {
    const m = re.exec(text);
    const board = m?.[1] ?? m?.[2];
    if (board && !NOT_BOARDS.has(board.toLowerCase())) return { ats, board };
  }
  return null;
}

/** URL first; if it's the company's own site, fetch it once (guarded) and look inside. */
export async function detectAts(
  http: PoliteHttp,
  url: string,
): Promise<Detected | { ats: 'html'; url: string }> {
  const direct = detectIn(url);
  if (direct) return direct;
  const html = await http.get(url, 'text/html');
  return detectIn(html) ?? { ats: 'html', url };
}
