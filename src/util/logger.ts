// Structured JSON logs (pino) on stderr, so stdout stays clean for command output.
// Pretty output for humans: `npm run agent -- <cmd> 2>&1 | npx pino-pretty`.
import { pino, type Logger } from 'pino';

export function createLogger(level = process.env['LOG_LEVEL'] ?? 'info'): Logger {
  return pino(
    {
      level,
      base: { app: 'job-agent' },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Defence in depth: never log secrets even if an object carrying them is logged.
      redact: {
        paths: [
          '*.apiKey',
          '*.api_key',
          '*.token',
          '*.refresh_token',
          '*.password',
          'authorization',
        ],
        censor: '[redacted]',
      },
    },
    pino.destination(2),
  );
}

export const logger = createLogger();
