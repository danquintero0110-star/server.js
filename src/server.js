import path from 'node:path';
import { config } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { createQueue } from './lib/pipeline.js';

const db = openDb(path.join(config.dataDir, 'selah.db'), { bibleFile: config.bibleFile });
let queue;
const app = buildApp({ db, queue: { enqueue: (id) => queue.enqueue(id) }, logger: { level: process.env.LOG_LEVEL || 'info' } });
queue = createQueue(db, { log: app.log });

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
queue.resume();
