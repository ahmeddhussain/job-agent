// ReadOnlyWhatsApp (hard rule 1, security A14): the ONLY module that may import
// whatsapp-web.js. It exposes exactly three operations: list chats, read messages,
// close. The client object never leaves this file, so nothing else can send, react,
// mark as seen, join, change status or log out. test/unit/whatsapp-readonly.test.ts
// fails the build if any of those calls appear anywhere in src/.
//
// Verified in whatsapp-web.js 1.34.8: Chat.fetchMessages only reads (it loads earlier
// messages, no sendSeen); presence is only sent by sendPresenceAvailable, never called.
import wweb from 'whatsapp-web.js';
import type { Logger } from 'pino';
import { noteDisconnect } from './crash-hint.js';
import { WhatsAppNotLinkedError } from './retry.js';
import { newestCachedVersion } from './web-version.js';

const { Client, LocalAuth } = wweb;

export interface WaChat {
  id: string;
  name: string;
  isGroup: boolean;
}

export interface WaMessage {
  id: string;
  /** Unix seconds. */
  timestamp: number;
  /** Text, or the caption of a media message. */
  body: string;
  /** Group participant id (phone-based); hashed before storage. */
  author: string | null;
  type: string;
  fromMe: boolean;
}

export interface ReadOnlyOptions {
  sessionPath: string;
  webCachePath: string;
  settleSeconds: number;
  readyTimeoutSeconds: number;
  authTimeoutSeconds: number;
  log: Logger;
  /** Called with the QR payload when the number isn't linked yet (wa:login). */
  onQr?: (qr: string) => void;
  /** Human-readable lifecycle steps (wa:login prints them). */
  onProgress?: (step: string) => void;
}

/** The minimal read surface the collector depends on (lets tests use a fake). */
export interface WaChannel {
  id: string;
  name: string;
}

export interface WhatsAppReader {
  getChats(): Promise<WaChat[]>;
  fetchMessages(chatId: string, limit: number): Promise<WaMessage[]>;
  /** Channels the account follows (D37). Reading only: no follow, unfollow, mute or react. */
  getChannels(): Promise<WaChannel[]>;
  fetchChannelMessages(channelId: string, limit: number): Promise<WaMessage[]>;
  destroy(): Promise<void>;
}

/**
 * Runs in the WhatsApp Web page: if the conflict screen is shown, click its "Use here"
 * button. A string, so it runs as-is in the browser (no DOM types needed here).
 */
const USE_HERE_SCRIPT = `(() => {
  const text = document.body ? document.body.innerText : '';
  if (!/open in another window/i.test(text)) return false;
  const btn = Array.from(document.querySelectorAll('button, div[role="button"]'))
    .find((e) => /^\\s*use here\\s*$/i.test(e.textContent || ''));
  if (!btn) return false;
  btn.click();
  return true;
})()`;

export class ReadOnlyWhatsApp implements WhatsAppReader {
  private constructor(private readonly client: InstanceType<typeof Client>) {}

  static async start(o: ReadOnlyOptions): Promise<ReadOnlyWhatsApp> {
    // Only linking needs the cached page (#35); a linked session loads the current one.
    const pinned = o.onQr ? newestCachedVersion(o.webCachePath) : null;
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: o.sessionPath }),
      webVersionCache: { type: 'local', path: o.webCachePath },
      ...(pinned ? { webVersion: pinned } : {}),
      authTimeoutMs: o.authTimeoutSeconds * 1000,
      puppeteer: { headless: true },
    });
    // The library hooks ~18 event listeners into every frame. WhatsApp opens and closes a
    // PDF-viewer frame at that moment; if it closes mid-hook the step throws inside the page
    // and `ready` never comes (troubleshooting #36). This facade only reads on demand and
    // uses none of those events, so they are not attached at all.
    (client as unknown as { attachEventListeners: () => Promise<void> }).attachEventListeners =
      () => Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `WhatsApp not ready after ${String(o.readyTimeoutSeconds)} s (not linked, or WhatsApp Web stuck loading; run: ./agent.sh whatsapp-login)`,
          ),
        );
      }, o.readyTimeoutSeconds * 1000);
      client.on('qr', (qr: string) => {
        if (o.onQr) o.onQr(qr);
        else {
          clearTimeout(timer);
          reject(
            new WhatsAppNotLinkedError(
              'WhatsApp is not linked (QR requested). Run: ./agent.sh whatsapp-login',
            ),
          );
        }
      });
      client.on('auth_failure', (msg: string) => {
        clearTimeout(timer);
        reject(new Error(`WhatsApp auth failure: ${msg}`));
      });
      client.on('ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    // Handled right away: a rejection during initialize() must not crash the process
    // with an unhandled rejection (troubleshooting #14).
    ready.catch(() => undefined);
    // Lifecycle visibility: scan → authenticated → loading_screen % → ready.
    client.on('authenticated', () => {
      o.onProgress?.('authenticated, loading WhatsApp Web');
      o.log.info('whatsapp authenticated');
    });
    client.on('loading_screen', (percent: string | number, message: string) => {
      o.onProgress?.(`loading ${String(percent)}% ${message}`);
      o.log.info({ percent, message }, 'whatsapp loading');
    });
    client.on('change_state', (state: string) => {
      o.log.info({ state }, 'whatsapp state');
    });
    client.on('disconnected', (reason: string) => {
      noteDisconnect(reason);
      o.log.warn({ reason }, 'whatsapp disconnected');
    });
    const wa = new ReadOnlyWhatsApp(client);
    // "WhatsApp is open in another window. Click 'Use here'": shown when an earlier run
    // didn't disconnect cleanly. The page then never opens its socket and the library
    // waits forever (troubleshooting #16). "Use here" only makes this window the active
    // one for the same linked device: it sends nothing and changes no chat.
    const takeover = setInterval(() => {
      void (async () => {
        const page = client.pupPage;
        if (!page) return;
        const clicked = await page
          .evaluate(USE_HERE_SCRIPT)
          .then((r) => r === true)
          .catch(() => false);
        if (clicked) {
          o.onProgress?.('session was open in a stale window; switched it here ("Use here")');
          o.log.warn('whatsapp conflict screen: clicked "Use here"');
        }
      })();
    }, 3000);
    try {
      await Promise.race([client.initialize().then(() => ready), ready]);
      clearInterval(takeover);
      o.onProgress?.('ready');
      // Let history sync finish before reading (PLAN 5.1 step 1).
      await new Promise((r) => setTimeout(r, o.settleSeconds * 1000));
      return wa;
    } catch (err) {
      clearInterval(takeover);
      clearTimeout(timer); // or a failed login keeps the process alive until the timeout
      const atLogin = client.pupPage?.url().includes('/login') === true;
      await wa.destroy();
      if (atLogin && !o.onQr)
        throw new WhatsAppNotLinkedError(
          'WhatsApp is not linked (it opened its login page). Run: ./agent.sh whatsapp-login',
          { cause: err },
        );
      if (atLogin)
        throw new Error(
          'WhatsApp Web opened its new login page, which the WhatsApp library cannot read yet (docs/dev/troubleshooting.md #35)',
          { cause: err },
        );
      throw err;
    }
  }

  async getChats(): Promise<WaChat[]> {
    const chats = await this.client.getChats();
    return chats.map((c) => ({ id: c.id._serialized, name: c.name, isGroup: c.isGroup }));
  }

  async fetchMessages(chatId: string, limit: number): Promise<WaMessage[]> {
    const chat = await this.client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit });
    return msgs.map((m) => ({
      id: m.id._serialized,
      timestamp: m.timestamp,
      body: m.body,
      author: m.author ?? null,
      type: m.type,
      fromMe: m.fromMe,
    }));
  }

  async getChannels(): Promise<WaChannel[]> {
    const channels = await this.client.getChannels();
    return channels.map((c) => ({ id: c.id._serialized, name: c.name }));
  }

  /** Channel.fetchMessages loads earlier messages only (verified in 1.34.8: no sendSeen). */
  async fetchChannelMessages(channelId: string, limit: number): Promise<WaMessage[]> {
    const channel = (await this.client.getChatById(channelId)) as unknown as {
      fetchMessages(o: { limit: number }): Promise<wweb.Message[]>;
    };
    const msgs = await channel.fetchMessages({ limit });
    return msgs.map((m) => ({
      id: m.id._serialized,
      timestamp: m.timestamp,
      body: m.body,
      author: null, // channel posts are the channel's own
      type: m.type,
      fromMe: m.fromMe,
    }));
  }

  /** Closes the browser. Never logs out: the linked session must survive (PLAN 5.1 step 6). */
  async destroy(): Promise<void> {
    try {
      await this.client.destroy();
    } catch {
      // already closed
    }
  }
}
