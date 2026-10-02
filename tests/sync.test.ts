import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ImaClient, type ImaClientOptions } from '../server/ima.ts';
import { SyncService } from '../server/sync.ts';
import { defaultSettings } from '../shared/defaults.ts';
import type { Notebook, NoteSnapshot, ParsedStudyItem, Settings, SyncCounts, SyncPersistence, SyncStatus } from '../shared/types.ts';

const credentials = { clientId: 'synthetic-client', apiKey: 'synthetic-api-key' };
const counts: SyncCounts = { added: 1, modified: 0, archived: 0, pending: 0, unchanged: 0 };
const oldCounts: SyncCounts = { added: 3, modified: 1, archived: 0, pending: 0, unchanged: 2 };
const notebook: Notebook = { id: 'vocab', name: 'Synthetic IELTS Vocabulary', count: 1 };
function noteSnapshot(noteId = 'synthetic-note'): NoteSnapshot {
  return { noteId, title: 'Synthetic note', folderId: 'vocab', folderName: notebook.name,
    modifiedAt: '2026-10-01T00:00:00.000Z', fetchedAt: '2026-10-02T00:00:00.000Z', hash: 'synthetic',
    content: JSON.stringify([{ type: 'h3', id: `synthetic-${noteId}`, children: [{ text: 'concise → using few words（简明的）' }] },
      { type: 'p', children: [{ text: 'Definition: A short synthetic reference.' }] }]) };
}
const noteInfo = (id: string) => ({ note_id: id, title: 'Synthetic note', modify_time: '1790812800000',
  note_ext_info: { folder_id: 'vocab', folder_name: notebook.name } });
const envelope = (data: Record<string, unknown>) => ({ code: 0, msg: 'ok', data });
interface RequestCall { url: string; init: RequestInit; body: Record<string, unknown> }
function scriptedClient(payloads: unknown[], options: Partial<ImaClientOptions> = {}) {
  const calls: RequestCall[] = [];
  const remaining = [...payloads];
  const fetcher: typeof fetch = async (input, init) => {
    assert.ok(init);
    calls.push({ url: String(input), init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    assert.ok(remaining.length, 'unexpected ima request');
    const payload = remaining.shift();
    return payload instanceof Response ? payload : new Response(JSON.stringify(payload), { status: 200,
      headers: { 'Content-Type': 'application/json' } });
  };
  return { client: new ImaClient({ credentials, fetcher, minIntervalMs: 0, ...options }), calls, remaining };
}

class Repository implements SyncPersistence {
  settings: Settings = { ...structuredClone(defaultSettings), folderIds: ['vocab'] };
  status: SyncStatus = { running: false, lastAttemptAt: '2026-10-01T00:00:00.000Z',
    lastSuccessAt: '2026-10-01T00:00:00.000Z', error: null, counts: structuredClone(oldCounts) };
  statusWrites: SyncStatus[] = [];
  commits: Array<{ items: ParsedStudyItem[]; snapshots: NoteSnapshot[]; now: string }> = [];
  stored = 'old data';
  applyError: Error | null = null;
  getSettings(): Settings { return this.settings; }
  saveSettings(patch: Partial<Settings>): Settings { this.settings = { ...this.settings, ...patch }; return this.settings; }
  getSyncStatus(): SyncStatus { return this.status; }
  setSyncStatus(status: SyncStatus): void { this.status = status; this.statusWrites.push(structuredClone(status)); }
  applySync(items: ParsedStudyItem[], snapshots: NoteSnapshot[], now: string): SyncCounts {
    if (this.applyError) throw this.applyError;
    this.commits.push({ items, snapshots, now }); this.stored = 'new data'; return counts;
  }
}
function fakeClient(overrides: Partial<Pick<ImaClient, 'getNotebooks' | 'getSnapshots'>> = {}) {
  return { getNotebooks: async () => [notebook], getSnapshots: async () => [noteSnapshot()], ...overrides };
}

test('ima client follows notebook and note cursors, then fetches JSON2 bodies from official read endpoints', async () => {
  const { client, calls, remaining } = scriptedClient([
    envelope({ note_folder_infos: [{ folder_id: 'vocab', name: notebook.name, note_number: '2' }], is_end: false, next_cursor: 'books-2' }),
    envelope({ note_folder_infos: [], is_end: true }),
    envelope({ note_book_list: [noteInfo('one')], is_end: false, next_cursor: 'notes-2' }),
    envelope({ note_book_list: [noteInfo('two')], is_end: true }),
    envelope({ content: noteSnapshot('one').content }), envelope({ content: noteSnapshot('two').content }),
  ]);
  assert.deepEqual(await client.getNotebooks(), [{ ...notebook, count: 2 }]);
  const snapshots = await client.getSnapshots(['vocab']);
  assert.equal(snapshots.length, 2);
  assert.equal(remaining.length, 0);
  assert.equal(snapshots[0].modifiedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(snapshots[0].hash.length, 64);
  assert.deepEqual(calls.map(call => call.body.cursor), ['0', 'books-2', '', 'notes-2', undefined, undefined]);
  assert.equal(calls[4].body.target_content_format, 2);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://ima.qq.com');
    assert.match(new URL(call.url).pathname, /^\/openapi\/note\/v1\/(?:list_notebook|list_note|get_doc_content)$/);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.redirect, 'error');
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('ima-openapi-clientid'), credentials.clientId);
    assert.equal(headers.get('ima-openapi-apikey'), credentials.apiKey);
    assert.equal(headers.get('Content-Type'), 'application/json');
  }
});

test('notebook pagination fails when is_end is absent or a next cursor is absent/repeated', async () => {
  for (const data of [
    { note_folder_infos: [], is_end: false },
    { note_folder_infos: [], is_end: false, next_cursor: '0' },
    { note_folder_infos: [], next_cursor: 'later' },
  ]) {
    const { client } = scriptedClient([envelope(data)]);
    await assert.rejects(client.getNotebooks(), /is_end|next_cursor/);
  }
  const { client } = scriptedClient([
    envelope({ note_folder_infos: [], is_end: false, next_cursor: 'a' }),
    envelope({ note_folder_infos: [], is_end: false, next_cursor: 'b' }),
    envelope({ note_folder_infos: [], is_end: false, next_cursor: 'a' }),
  ]);
  await assert.rejects(client.getNotebooks(), /next_cursor/);
});

test('unfinished note pagination never fetches a body or applies a partial archive', async () => {
  const { client, calls } = scriptedClient([envelope({ note_book_list: [noteInfo('one')], is_end: false })]);
  const repository = new Repository();
  const sync = new SyncService(repository, client);
  await assert.rejects(sync.run(), /next_cursor/);
  assert.equal(calls.length, 1);
  assert.equal(repository.commits.length, 0);
  assert.equal(repository.stored, 'old data');
  assert.equal(repository.status.lastSuccessAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(repository.status.counts, oldCounts);
});

test('empty folder scope is rejected before any network request', async () => {
  const { client, calls } = scriptedClient([]);
  await assert.rejects(client.getSnapshots([]), /空范围/);
  await assert.rejects(client.getSnapshots(['']), /空范围/);
  await assert.rejects(client.getSnapshots(['0']), /空范围/);
  assert.equal(calls.length, 0);
});

test('business errors show official msg with injected credentials redacted', async () => {
  const { client } = scriptedClient([{ code: 20004,
    msg: `authentication failed for ${credentials.clientId} ${credentials.apiKey}`, data: {} }]);
  await assert.rejects(client.getNotebooks(), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /authentication failed/);
    assert.ok(!error.message.includes(credentials.clientId));
    assert.ok(!error.message.includes(credentials.apiKey));
    return true;
  });
});

test('redirects, HTTP errors, missing business status and malformed JSON fail closed', async () => {
  for (const payload of [
    new Response(null, { status: 302, headers: { Location: 'https://example.org/' } }),
    new Response('unavailable', { status: 503 }),
    { data: { note_folder_infos: [], is_end: true } },
    new Response('not JSON', { status: 200 }),
  ]) {
    const { client, calls } = scriptedClient([payload]);
    await assert.rejects(client.getNotebooks());
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'error');
  }
});

test('timeout aborts the request and reports a safe message', async () => {
  let aborted = false;
  const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('unsafe internal details')); });
  });
  const client = new ImaClient({ credentials, fetcher, minIntervalMs: 0, timeoutMs: 15 });
  await assert.rejects(client.getNotebooks(), /请求超时/);
  assert.equal(aborted, true);
});

test('client requests are serialized even when callers request two lists concurrently', async () => {
  let inflight = 0; let maximum = 0; let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++; inflight++; maximum = Math.max(maximum, inflight);
    await new Promise<void>(resolve => setTimeout(resolve, 3));
    inflight--;
    return new Response(JSON.stringify(envelope({ note_folder_infos: [], is_end: true })));
  };
  const client = new ImaClient({ credentials, fetcher, minIntervalMs: 0 });
  await Promise.all([client.getNotebooks(), client.getNotebooks()]);
  assert.equal(requests, 2);
  assert.equal(maximum, 1);
});

test('all folder lists must complete before any note body is requested', async () => {
  const { client, calls } = scriptedClient([
    envelope({ note_book_list: [noteInfo('one')], is_end: true }),
    { code: 210035, msg: 'Folder no longer exists', data: {} },
  ]);
  await assert.rejects(client.getSnapshots(['vocab', 'other-selected']), /Folder no longer exists/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.endsWith('/list_note')));
});

test('one body failure keeps old sync state and does not apply already fetched bodies', async () => {
  const { client } = scriptedClient([
    envelope({ note_book_list: [noteInfo('one'), noteInfo('two')], is_end: true }),
    envelope({ content: noteSnapshot('one').content }),
    { code: 210006, msg: 'Note deleted during fetch', data: {} },
  ]);
  const repository = new Repository();
  await assert.rejects(new SyncService(repository, client).run(), /Note deleted during fetch/);
  assert.equal(repository.commits.length, 0);
  assert.equal(repository.stored, 'old data');
  assert.deepEqual(repository.status.counts, oldCounts);
});

test('duplicate stable note metadata is fetched once; changing duplicate metadata fails', async () => {
  const { client, calls } = scriptedClient([
    envelope({ note_book_list: [noteInfo('one')], is_end: false, next_cursor: '2' }),
    envelope({ note_book_list: [noteInfo('one')], is_end: true }),
    envelope({ content: noteSnapshot().content }),
  ]);
  assert.equal((await client.getSnapshots(['vocab', 'vocab'])).length, 1);
  assert.equal(calls.length, 3);
  const changing = scriptedClient([
    envelope({ note_book_list: [noteInfo('one')], is_end: false, next_cursor: '2' }),
    envelope({ note_book_list: [{ ...noteInfo('one'), modify_time: '1790812801000' }], is_end: true }),
  ]);
  await assert.rejects(changing.client.getSnapshots(['vocab']), /分页期间发生变化/);
  assert.equal(changing.calls.length, 2);
});

test('sync commits all parsed items exactly once and records successful status', async () => {
  const repository = new Repository();
  const snapshots = [noteSnapshot('one'), noteSnapshot('two')];
  const status = await new SyncService(repository, fakeClient({ getSnapshots: async ids => {
    assert.deepEqual(ids, ['vocab']); return snapshots;
  } })).run('test');
  assert.equal(repository.statusWrites[0].running, true);
  assert.equal(repository.commits.length, 1);
  assert.equal(repository.commits[0].items.length, 2);
  assert.deepEqual(repository.commits[0].snapshots, snapshots);
  assert.equal(status.lastSuccessAt, repository.commits[0].now);
  assert.equal(status.running, false);
  assert.equal(status.error, null);
  assert.deepEqual(status.counts, counts);
});

test('a later unparseable snapshot prevents any apply and preserves lastSuccess/counts', async () => {
  const repository = new Repository();
  const invalid = { ...noteSnapshot('invalid'), content: JSON.stringify([{ type: 'p', children: [{ text: 'Synthetic ordinary prose.' }] }]) };
  const service = new SyncService(repository, fakeClient({ getSnapshots: async () => [noteSnapshot(), invalid] }));
  await assert.rejects(service.run(), /缺少可识别的词条结构/);
  assert.equal(repository.commits.length, 0);
  assert.equal(repository.stored, 'old data');
  assert.equal(repository.status.running, false);
  assert.equal(repository.status.lastSuccessAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(repository.status.counts, oldCounts);
  assert.ok(repository.status.error);
});

test('overlapping sync runs share one promise; a later run can execute after completion', async () => {
  const repository = new Repository();
  let resolveSnapshots!: (snapshots: NoteSnapshot[]) => void;
  let fetches = 0;
  const waiting = new Promise<NoteSnapshot[]>(resolve => { resolveSnapshots = resolve; });
  const service = new SyncService(repository, fakeClient({ getSnapshots: async () => { fetches++; return waiting; } }));
  const first = service.run('manual');
  const second = service.run('daily');
  assert.equal(first, second);
  assert.equal(fetches, 1);
  assert.equal(repository.status.running, true);
  resolveSnapshots([noteSnapshot()]);
  await Promise.all([first, second]);
  assert.equal(repository.commits.length, 1);
  await service.run();
  assert.equal(fetches, 2);
  assert.equal(repository.commits.length, 2);
});

test('failed sync releases the mutex so retry can complete', async () => {
  const repository = new Repository();
  let calls = 0;
  const service = new SyncService(repository, fakeClient({ getSnapshots: async () => {
    if (++calls === 1) throw new Error('Synthetic connection failure'); return [noteSnapshot()];
  } }));
  await assert.rejects(service.run(), /Synthetic connection failure/);
  await service.run();
  assert.equal(calls, 2);
  assert.equal(repository.commits.length, 1);
  assert.equal(repository.status.error, null);
});

test('default scope chooses and saves only IELTS vocabulary notebooks, never all/private notebooks', async () => {
  const repository = new Repository(); repository.settings.folderIds = [];
  const books: Notebook[] = [
    { id: 'cn', name: '雅思词汇', count: 2 }, notebook,
    { id: 'user_list_test', name: 'IELTS Vocabulary', count: 8 },
    { id: 'private', name: 'Private journal', count: 3 },
    { id: 'writing', name: 'IELTS Writing', count: 2 },
  ];
  const service = new SyncService(repository, fakeClient({ getNotebooks: async () => books,
    getSnapshots: async ids => { assert.deepEqual(ids, ['cn', 'vocab']); return [noteSnapshot()]; } }));
  await service.run();
  assert.deepEqual(repository.settings.folderIds, ['cn', 'vocab']);
});

test('missing default vocabulary notebook fails before fetching any note', async () => {
  const repository = new Repository(); repository.settings.folderIds = [];
  let fetched = false;
  const service = new SyncService(repository, fakeClient({ getNotebooks: async () => [{ id: 'private', name: 'Private journal', count: 1 }],
    getSnapshots: async () => { fetched = true; return []; } }));
  await assert.rejects(service.run(), /设置中选择同步范围/);
  assert.equal(fetched, false);
  assert.equal(repository.commits.length, 0);
  assert.deepEqual(repository.settings.folderIds, []);
});

test('explicitly selected folder is used without rediscovering notebooks', async () => {
  const repository = new Repository();
  const service = new SyncService(repository, fakeClient({ getNotebooks: async () => { throw new Error('should not discover'); } }));
  await service.run();
  assert.equal(repository.commits.length, 1);
});

test('valid complete empty folder is passed to the repository for intentional source deletion', async () => {
  const { client } = scriptedClient([envelope({ note_book_list: [], is_end: true })]);
  const repository = new Repository();
  await new SyncService(repository, client).run();
  assert.deepEqual(repository.commits[0].items, []);
  assert.deepEqual(repository.commits[0].snapshots, []);
});

test('apply failure preserves old success status, and notebook listing delegates to the client', async () => {
  const repository = new Repository(); repository.applyError = new Error('Synthetic transaction rejected');
  const service = new SyncService(repository, fakeClient());
  assert.deepEqual(await service.getNotebooks(), [notebook]);
  await assert.rejects(service.run(), /Synthetic transaction rejected/);
  assert.equal(repository.stored, 'old data');
  assert.equal(repository.status.lastSuccessAt, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(repository.status.counts, oldCounts);
});

test('IMA_REVIEW_CREDENTIAL_DIR loads synthetic file credentials without reading the real credential directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ima-review-credentials-test-'));
  try {
    await writeFile(join(directory, 'client_id'), 'synthetic-file-client\n', { mode: 0o600 });
    await writeFile(join(directory, 'api_key'), 'synthetic-file-key\n', { mode: 0o600 });
    const source = `
      import { ImaClient } from './server/ima.ts';
      const client = new ImaClient({ minIntervalMs: 0, fetcher: async (_input, init) => {
        const headers = new Headers(init.headers);
        if (headers.get('ima-openapi-clientid') !== 'synthetic-file-client'
          || headers.get('ima-openapi-apikey') !== 'synthetic-file-key') throw new Error('Synthetic credential resolution mismatch');
        return new Response(JSON.stringify({code: 0, data: {note_folder_infos: [], is_end: true}}));
      }});
      await client.getNotebooks();
      process.stdout.write('credential-dir-ok');
    `;
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source], {
        cwd: process.cwd(), env: { PATH: process.env.PATH,
          IMA_OPENAPI_CLIENTID: '', IMA_OPENAPI_APIKEY: '', IMA_REVIEW_CREDENTIAL_DIR: directory },
      });
    assert.equal(stdout, 'credential-dir-ok');
    assert.equal(stderr, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
