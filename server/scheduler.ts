import type { SyncService } from './sync.ts';
import type { Store } from './store.ts';
import { dateKey, localTime } from './questions.ts';

/** Checks the clock, never polls ima. API requests occur only at startup/daily/manual. */
export function startScheduler(store: Store, sync: Pick<SyncService, 'run'>, onError: (message: string) => void = () => {}, intervalMs = 15000) {
  let stopped = false; let busy = false;
  const tick = async (startup = false) => {
    if (stopped || busy) return; busy = true;
    try {
      const now = store.clock(); const settings = store.getSettings(); const date = dateKey(now, settings.timezone);
      if (store.getMeta('lastBackupDay') !== date) {
        try { await store.backup(); store.setMeta('lastBackupDay', date); }
        catch (e) { onError(`每日备份失败：${e instanceof Error ? e.message : '未知错误'}`); }
      }
      if (startup) {
        try { await sync.run('startup'); }
        catch (e) { onError(`启动同步失败：${e instanceof Error ? e.message : '未知错误'}`); }
      }
      if (localTime(now, settings.timezone) >= settings.syncTime && store.getMeta('lastDailyAttemptDay') !== date) {
        // One automatic attempt/day; a failure is visible and can be manually retried.
        store.setMeta('lastDailyAttemptDay', date);
        try { await sync.run('daily'); store.setMeta('lastDailySuccessDay', date); }
        catch (e) { onError(`每日同步失败：${e instanceof Error ? e.message : '未知错误'}`); }
      }
    } finally { busy = false; }
  };
  const startup = tick(true);
  const timer = setInterval(() => { void tick(); }, intervalMs); timer.unref();
  return { startup, tick: () => tick(), stop: async () => { stopped = true; clearInterval(timer); await startup; while (busy) await new Promise(r => setTimeout(r, 20)); } };
}
