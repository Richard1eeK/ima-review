import type { Settings, SyncStatus } from './types.ts';
export const defaultSettings: Settings = {
  newLimit: 10, reviewLimit: 30, practiceLimit: 10,
  timezone: 'Asia/Shanghai', syncTime: '07:00', studyTime: '20:30',
  folderIds: [], reducedMotion: false,
};
export const emptySyncStatus: SyncStatus = {
  running: false, lastAttemptAt: null, lastSuccessAt: null, error: null, counts: null,
};
