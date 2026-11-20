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
  log: Logger;
  /** Called with the QR payload when the number isn't linked yet (wa:login). */
  onQr?: (qr: string) => void;
}

/** The minimal read surface the collector depends on (lets tests use a fake). */
export interface WhatsAppReader {
  getChats(): Promise<WaChat[]>;
  fetchMessages(chatId: string, limit: number): Promise<WaMessage[]>;
  destroy(): Promise<void>;
}

export class ReadOnlyWhatsApp implements WhatsAppReader {
  private constructor(private readonly client: InstanceType<typeof Client>) {}

  static async start(o: ReadOnlyOptions): Promise<ReadOnlyWhatsApp> {
    const client = new Client({
      authStrategy: new LocalAuth({ dataPath: o.sessionPath }),
      webVersionCache: { type: 'local', path: o.webCachePath },
      puppeteer: { headless: true },
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `WhatsApp not ready after ${String(o.readyTimeoutSeconds)} s (not linked? run: agent wa:login)`,
          ),
        );
      }, o.readyTimeoutSeconds * 1000);
      client.on('qr', (qr: string) => {
        if (o.onQr) o.onQr(qr);
        else {
          clearTimeout(timer);
          reject(new Error('WhatsApp is not linked (QR requested). Run: agent wa:login'));
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
    client.on('disconnected', (reason: string) => {
      o.log.warn({ reason }, 'whatsapp disconnected');
    });
    const wa = new ReadOnlyWhatsApp(client);
    try {
      await client.initialize();
      await ready;
      // Let history sync finish before reading (PLAN 5.1 step 1).
      await new Promise((r) => setTimeout(r, o.settleSeconds * 1000));
      return wa;
    } catch (err) {
      await wa.destroy();
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

  /** Closes the browser. Never logs out: the linked session must survive (PLAN 5.1 step 6). */
  async destroy(): Promise<void> {
    try {
      await this.client.destroy();
    } catch {
      // already closed
    }
  }
}
