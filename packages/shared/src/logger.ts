import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pino, { type StreamEntry } from 'pino';
import { env } from './env.js';

const streams: StreamEntry[] = [{ stream: process.stdout }];

if (env.LOG_FILE) {
  // Ensure the parent directory exists; pino.destination doesn't create it.
  mkdirSync(dirname(env.LOG_FILE), { recursive: true });
  streams.push({
    stream: pino.destination({
      dest: env.LOG_FILE,
      sync: false,
      mkdir: true,
    }),
  });
}

export const logger = pino(
  {
    level: env.LOG_LEVEL,
    base: { component: 'axon' },
  },
  pino.multistream(streams),
);
