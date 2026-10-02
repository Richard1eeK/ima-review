import { createApp } from './app.ts';
import { resolveConfig } from './config.ts';
import { startScheduler } from './scheduler.ts';

const config = resolveConfig();
const { app, store, sync } = await createApp({ logger: true });
await app.listen({ port: config.port, host: config.host });
console.info(`ima 英语复习已启动：http://${config.host}:${config.port}`);
const scheduler = config.autoSync ? startScheduler(store, sync, message => console.warn(message)) : null;
let closing = false;
async function close() {
  if (closing) return; closing = true;
  await scheduler?.stop(); await app.close();
}
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
