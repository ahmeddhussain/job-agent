// One-page rendering and the ATS check on real PDFs (needs Chrome from puppeteer and
// poppler-utils). P3 gate: passes on the tailored CVs, fails on broken PDFs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseConfig } from '../../src/config.js';
import { loadProfile } from '../../src/profile/load.js';
import { atsCheck } from '../../src/render/ats.js';
import { buildCvModel, renderOnePageCv } from '../../src/render/cv.js';
import { pdfInfo } from '../../src/render/poppler.js';
import { Renderer, renderTemplate } from '../../src/render/renderer.js';
import type { TailorOutput } from '../../src/tailor/schema.js';
import { vocabularyFor } from '../../src/tailor/vocab.js';

const raw = parse(readFileSync('config/config.example.yaml', 'utf8')) as Record<
  string,
  Record<string, unknown>
>;
raw['digest'] = { ...raw['digest'], to: 'someone@example.com' };
const cfg = parseConfig(raw);
const profile = loadProfile('profile/master_profile.example.yaml');
const vocab = vocabularyFor(profile);
const recording = (id: string) =>
  JSON.parse(readFileSync(`test/fixtures/llm/${id}.tailor.1.json`, 'utf8')) as TailorOutput;

let renderer: Renderer;
let dir: string;

beforeAll(async () => {
  renderer = await Renderer.open();
  dir = mkdtempSync(join(tmpdir(), 'render-test-'));
}, 60_000);
afterAll(async () => {
  await renderer.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('one-page CV + ATS check', () => {
  it.each(['01-devops-email-en', '11-app-support-form', '12-network-backoffice'])(
    '%s renders to exactly one page and passes the ATS check',
    async (id) => {
      const path = join(dir, `${id}.pdf`);
      const r = await renderOnePageCv(renderer, profile, recording(id), cfg, path);
      expect(r.pages).toBe(1);
      expect(r.fill).toBeGreaterThan(0.8);
      const ats = await atsCheck(path, cfg, profile, vocab, []);
      expect(ats.failures).toEqual([]);
    },
    60_000,
  );

  it("follows Ahmed's CV: real hyperlinks, at least 4 projects, Carlito, his section order", async () => {
    const path = join(dir, 'layout.pdf');
    const r = await renderOnePageCv(renderer, profile, recording('01-devops-email-en'), cfg, path);
    expect(r.output.projects.length).toBeGreaterThanOrEqual(cfg.cv.min_projects);
    const bytes = readFileSync(path).toString('latin1');
    // Chrome normalizes a bare host to end in '/'; compare without the trailing slash.
    const uris = new Set(
      [...bytes.matchAll(/\/URI\s*\(([^)]*)\)/g)].map((m) => (m[1] ?? '').replace(/\/$/, '')),
    );
    for (const url of Object.values(profile.candidate.links))
      expect(uris).toContain(url.replace(/\/$/, ''));
    expect(uris).toContain(`mailto:${profile.candidate.email}`);
    for (const pick of r.output.projects) {
      const link = profile.projects.find((x) => x.id === pick.id)?.link;
      if (link) expect(uris).toContain(link);
    }
    const { stdout } = await import('node:child_process').then((cp) =>
      import('node:util').then((u) => u.promisify(cp.execFile)('pdffonts', [path])),
    );
    expect(stdout).toMatch(/Carlito-Regular/);
    const ats = await atsCheck(path, cfg, profile, vocab, []);
    expect(ats.headingsFound).toEqual(cfg.ats_check.required_headings);
  }, 60_000);

  it('fails a two-page CV', async () => {
    const o = recording('01-devops-email-en');
    // Every bullet of every project, untrimmed: far more than one page.
    o.projects = profile.projects.map((p) => ({
      id: p.id,
      bullets: p.bullets.map((b) => ({ id: b.id, text: b.text })),
    }));
    const path = join(dir, 'two-pages.pdf');
    writeFileSync(path, await renderer.pdf(renderTemplate('cv', buildCvModel(profile, o))));
    expect((await pdfInfo(path)).pages).toBeGreaterThan(1);
    expect((await atsCheck(path, cfg, profile, vocab, [])).failures.join()).toMatch(/pages/);
  }, 60_000);

  it('fails an image-only PDF', async () => {
    // A 1x1 PNG stretched over the page: no text layer at all.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const path = join(dir, 'image-only.pdf');
    writeFileSync(
      path,
      await renderer.pdf(
        `<html><body><img style="width:100%" src="data:image/png;base64,${png}"></body></html>`,
      ),
    );
    const ats = await atsCheck(path, cfg, profile, vocab, []);
    expect(ats.pass).toBe(false);
    expect(ats.failures.join()).toMatch(/images|extractable text/);
  }, 60_000);

  it('fails a CV with a missing heading', async () => {
    const html = renderTemplate(
      'cv',
      buildCvModel(profile, recording('01-devops-email-en')),
    ).replace('<h2>Certifications</h2>', '<h2>Credentials</h2>');
    const path = join(dir, 'missing-heading.pdf');
    writeFileSync(path, await renderer.pdf(html));
    expect((await atsCheck(path, cfg, profile, vocab, [])).failures.join()).toMatch(
      /headings missing: Certifications/,
    );
  }, 60_000);

  it('fails when backed keywords are missing from the CV', async () => {
    const path = join(dir, 'keywords.pdf');
    await renderOnePageCv(renderer, profile, recording('12-network-backoffice'), cfg, path);
    const ats = await atsCheck(path, cfg, profile, vocab, [
      'Azure DevOps pipelines',
      'GCP and Azure AKS',
    ]);
    expect(ats.keywordsMissing.length).toBeGreaterThan(0);
    expect(ats.failures.join()).toMatch(/keyword coverage/);
  }, 60_000);

  it('blocks network requests and scripts while rendering (security A9)', async () => {
    const path = join(dir, 'js.pdf');
    writeFileSync(
      path,
      await renderer.pdf(
        '<html><body><p id="x">static</p><script>document.getElementById("x").textContent="SCRIPT RAN"</script><img src="http://127.0.0.1:9/beacon.png"></body></html>',
      ),
    );
    const { pdfText } = await import('../../src/render/poppler.js');
    const text = await pdfText(path);
    expect(text).toContain('static');
    expect(text).not.toContain('SCRIPT RAN');
  }, 60_000);
});
