// HTML → PDF with headless Chrome (D7). Security A9: JavaScript is disabled and every
// network request is aborted, so the template can't run code or fetch anything.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import puppeteer, { type Browser } from 'puppeteer';

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates');

const hbs = Handlebars.create();
const cache = new Map<string, Handlebars.TemplateDelegate>();

/** Renders a template; `{{x}}` is HTML-escaped by Handlebars, so model text can't inject markup. */
export function renderTemplate(name: string, data: Record<string, unknown>): string {
  let t = cache.get(name);
  if (!t) {
    t = hbs.compile(readFileSync(join(TEMPLATES_DIR, `${name}.hbs`), 'utf8'), { strict: true });
    cache.set(name, t);
  }
  const css = readFileSync(join(TEMPLATES_DIR, 'styles.css'), 'utf8');
  return t({ ...data, css });
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
      page.on('request', (req) => {
        void req.abort();
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
