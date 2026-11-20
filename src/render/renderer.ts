// HTML → PDF with headless Chrome (D7). Security A9: JavaScript is disabled and every
// network request is aborted, so the template can't run code or fetch anything.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import puppeteer, { type Browser } from 'puppeteer';

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

const hbs = Handlebars.create();

let fontFacesCss: string | null = null;
/**
 * Carlito (OFL, the font of Ahmed's own CV) embedded as data: URIs, so the page needs no
 * file or network access and the PDF embeds the font (templates/fonts/OFL.txt).
 */
function fontFaces(): string {
  if (fontFacesCss) return fontFacesCss;
  const faces: [string, string, string][] = [
    ['Regular', 'normal', '400'],
    ['Bold', 'normal', '700'],
    ['Italic', 'italic', '400'],
    ['BoldItalic', 'italic', '700'],
  ];
  fontFacesCss = faces
    .map(([file, style, weight]) => {
      const b64 = readFileSync(join(TEMPLATES_DIR, 'fonts', `Carlito-${file}.ttf`)).toString(
        'base64',
      );
      return `@font-face{font-family:Carlito;font-style:${style};font-weight:${weight};src:url(data:font/ttf;base64,${b64}) format('truetype');}`;
    })
    .join('');
  return fontFacesCss;
}
const cache = new Map<string, Handlebars.TemplateDelegate>();

/** Renders a template; `{{x}}` is HTML-escaped by Handlebars, so model text can't inject markup. */
export function renderTemplate(name: string, data: Record<string, unknown>): string {
  let t = cache.get(name);
  if (!t) {
    t = hbs.compile(readFileSync(join(TEMPLATES_DIR, `${name}.hbs`), 'utf8'), { strict: true });
    cache.set(name, t);
  }
  const css = readFileSync(join(TEMPLATES_DIR, 'styles.css'), 'utf8');
  return t({ fontPt: 10, ...data, css, fontFaces: fontFaces() });
}

export class Renderer {
  private constructor(private readonly browser: Browser) {}

  static async open(): Promise<Renderer> {
    return new Renderer(await puppeteer.launch({ headless: true }));
  }

  async pdf(html: string): Promise<Uint8Array> {
    const page = await this.browser.newPage();
    try {
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      // Only inline data: URIs (the embedded font) may load; everything else is aborted.
      page.on('request', (req) => {
        if (req.url().startsWith('data:')) void req.continue();
        else void req.abort();
      });
      await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
      return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
