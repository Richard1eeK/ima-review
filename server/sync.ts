import type { Notebook, SyncPersistence, SyncStatus } from '../shared/types.ts';
import { ImaClient } from './ima.ts';
import { parseNote } from './parser.ts';

type SyncClient = Pick<ImaClient, 'getNotebooks' | 'getSnapshots'>;

function vocabularyNotebooks(notebooks: Notebook[]): string[] {
  return notebooks.filter(notebook => !notebook.id.startsWith('user_list_') && notebook.id !== '0'
    && ((/雅思/.test(notebook.name) && /词汇|词库|词条|单词|表达|vocab/i.test(notebook.name))
      || (/\bIELTS\b/i.test(notebook.name) && /\bvocab(?:ulary)?\b|\bword(?:s)?\b|\blexicon\b|\bphrases?\b/i.test(notebook.name))))
    .map(notebook => notebook.id);
}

export class SyncService {
  private active: Promise<SyncStatus> | null = null;

  constructor(private readonly repository: SyncPersistence, private readonly client: SyncClient = new ImaClient()) {}

  getNotebooks(): Promise<Notebook[]> { return this.client.getNotebooks(); }

  run(reason = 'manual'): Promise<SyncStatus> {
    if (this.active) return this.active;
    const run = this.performSync(reason);
    this.active = run;
    void run.then(() => { if (this.active === run) this.active = null; },
      () => { if (this.active === run) this.active = null; });
    return run;
  }

  private async performSync(_reason: string): Promise<SyncStatus> {
    const previous = this.repository.getSyncStatus();
    const attemptAt = new Date().toISOString();
    this.repository.setSyncStatus({ ...previous, running: true, lastAttemptAt: attemptAt, error: null });
    try {
      const settings = this.repository.getSettings();
      let folderIds = settings.folderIds;
      if (!folderIds.length) {
        folderIds = vocabularyNotebooks(await this.client.getNotebooks());
        if (!folderIds.length) throw new Error('没有找到雅思词汇笔记本，请在设置中选择同步范围。');
        this.repository.saveSettings({ folderIds });
      }
      const snapshots = await this.client.getSnapshots(folderIds);
      if (new Set(snapshots.map(snapshot => snapshot.noteId)).size !== snapshots.length) {
        throw new Error('ima 返回重复笔记，无法确认同步资料完整。');
      }
      const items = snapshots.flatMap(parseNote);
      const now = new Date().toISOString();
      const counts = this.repository.applySync(items, snapshots, now);
      const status: SyncStatus = {
        running: false, lastAttemptAt: attemptAt, lastSuccessAt: now, error: null, counts,
      };
      this.repository.setSyncStatus(status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ima 同步失败，请稍后重试。';
      this.repository.setSyncStatus({ ...previous, running: false, lastAttemptAt: attemptAt, error: message });
      throw new Error(message);
    }
  }
}
