import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import type { ParsedStudyItem } from '../shared/types.ts';

async function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-review-api-'));
  const store = new Store(dir, () => new Date('2026-10-02T02:00:00Z'));
  const term = 'test phrase';
  const parsed: ParsedStudyItem = { source: { noteId: 'test-note', noteTitle: 'Test', folderId: 'folder-test', folderName: '雅思词汇', blockId: 'block-1' },
    title: `${term} → a meaning（含义）`, term, gloss: 'a meaning', chinese: '含义', definition: 'a meaning', body: ['Definition: a meaning'], speaking: [], writing: [], warnings: [], members: [], tags: ['Both'], kind: 'phrase', needsSupplement: false, contentHash: createHash('sha256').update(term).digest('hex') };
  store.applySync([parsed], [], '2026-10-02T02:00:00Z');
  const { app } = await createApp({ store, allowedUser: 'test@example.com', sync: { run: async () => { throw new Error('ima offline'); }, getNotebooks: async () => [{ id: 'folder-test', name: '雅思词汇', count: 1 }] } });
  t.after(async () => { await app.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, store };
}
test('API validates settings and rejects cross-origin or unauthorized network access', async t => {
  const { app } = await fixture(t);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { newLimit: -1 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/settings', payload: { timezone: 'wrong/timezone' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync', headers: { origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/items', headers: { host: 'evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/items', headers: { host: 'mini.private.ts.net', 'tailscale-user-login': 'other@example.com' } })).statusCode, 403);
  assert.equal((await app.inject({ url: '/api/items', headers: { host: 'mini.private.ts.net', 'tailscale-user-login': 'test@example.com' } })).statusCode, 200);
});
test('API walks learning → review rating → practice → export with server snapshots', async t => {
  const { app } = await fixture(t);
  const plan = (await app.inject('/api/plan')).json(); const itemId = plan.learn[0].id;
  const learning = await app.inject({ method: 'POST', url: '/api/learning', payload: { itemId } });
  assert.equal(learning.statusCode, 200); assert.equal(learning.json().item.id, itemId);
  assert.equal((await app.inject('/api/answers')).json().length, 0);
  const updatedPlan = (await app.inject('/api/plan')).json(); assert.equal(updatedPlan.counts.learned, 1); assert.equal(updatedPlan.learn.length, 0);
  assert.equal(updatedPlan.review[0].id, itemId); assert.ok(updatedPlan.practice.length > 0); assert.ok(updatedPlan.practice.every((q: { kind: string }) => q.kind !== 'explain'));
  const recall = await app.inject({ method: 'PUT', url: '/api/answers/test-recall', payload: { id: 'test-recall', itemId, stage: 'review', originalAnswer: 'My independent recall.', expectedRevision: 0, submit: true } });
  assert.equal(recall.statusCode, 200);
  await app.inject({ method: 'POST', url: '/api/reviews', payload: { answerId: 'test-recall', rating: 'good' } });
  assert.ok((await app.inject('/api/plan')).json().practice.length > 0);
  const exportMD = await app.inject('/api/export?format=markdown'); assert.equal(exportMD.statusCode, 200); assert.match(exportMD.body, /含义/); assert.match(exportMD.headers['content-disposition'] as string, /attachment/);
  const copyPack = (await app.inject('/api/evaluation')).json(); assert.match(copyPack.text, /My independent recall/);
  const backup = (await app.inject('/api/export?format=json')).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/restore/validate', payload: backup })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/restore', payload: { backup, confirm: false } })).statusCode, 400);
});
test('sync error leaves persisted data available and backup downloads are private routes', async t => {
  const { app, store } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/sync' })).statusCode, 502);
  assert.equal(store.listItems()[0].status, 'active');
  const file = (await app.inject({ method: 'POST', url: '/api/backups' })).json(); assert.ok(file.name.endsWith('.sqlite'));
  assert.equal((await app.inject(`/api/backups/${file.name}`)).statusCode, 200);
  assert.equal((await app.inject('/api/backups/not-found.sqlite')).statusCode, 404);
  assert.equal((await app.inject('/api/export?format=nope')).statusCode, 400);
});
