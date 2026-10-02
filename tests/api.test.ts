import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server/app.ts';
import { Store } from '../server/store.ts';
import type { BackupData, DailyPlan, DailyResetResult, ParsedStudyItem } from '../shared/types.ts';

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

test('reset API requires confirmation and rejects invalid or stale dates and generations without changing progress', async t => {
  const { app, store } = await fixture(t);
  const plan = (await app.inject('/api/plan')).json<DailyPlan>();
  store.completeLearning(plan.learn[0].id, plan.generation);
  const request = { method: 'POST' as const, url: '/api/plan/reset' };
  assert.equal((await app.inject({ ...request, payload: { date: plan.date, generation: plan.generation } })).statusCode, 400);
  assert.equal((await app.inject({ ...request, payload: { confirm: false, date: plan.date, generation: plan.generation } })).statusCode, 400);
  assert.equal((await app.inject({ ...request, payload: { confirm: true, date: 'not-a-date', generation: plan.generation } })).statusCode, 400);
  assert.equal((await app.inject({ ...request, payload: { confirm: true, date: '2026-10-01', generation: plan.generation } })).statusCode, 409);
  for (const generation of [undefined, -1, 0.5, '0']) {
    assert.equal((await app.inject({ ...request, payload: { confirm: true, date: plan.date, generation } })).statusCode, 400);
  }
  assert.equal((await app.inject({ ...request, payload: { confirm: true, date: plan.date, generation: plan.generation + 1 } })).statusCode, 409);
  const current = store.getDailyPlan();
  assert.equal(current.generation, plan.generation);
  assert.equal(current.counts.learned, 1);
  assert.equal(store.listBackups().length, 0);
});

test('reset API clears today, rejects stale writes, and downloads a private recovery JSON that can restore progress', async t => {
  const { app, store } = await fixture(t);
  const plan = (await app.inject('/api/plan')).json<DailyPlan>();
  const itemId = plan.learn[0].id;
  assert.equal((await app.inject({ method: 'POST', url: '/api/learning', payload: { itemId, planGeneration: plan.generation } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/answers/reset-recall', payload: { id: 'reset-recall', itemId, stage: 'review', originalAnswer: 'My explanation.\n原始回答需要恢复。', expectedRevision: 0, submit: true, planGeneration: plan.generation } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/reviews', payload: { answerId: 'reset-recall', rating: 'hard', planGeneration: plan.generation } })).statusCode, 200);
  const before = store.exportBackup();

  const response = await app.inject({ method: 'POST', url: '/api/plan/reset', payload: { confirm: true, date: plan.date, generation: plan.generation } });
  assert.equal(response.statusCode, 200);
  const reset = response.json<DailyResetResult>();
  assert.equal(reset.plan.generation, plan.generation + 1);
  assert.equal(reset.plan.counts.learned, 0);
  assert.equal(reset.plan.counts.reviewed, 0);
  assert.equal(reset.plan.counts.practiced, 0);
  assert.equal(store.listAnswers().length, 0);
  assert.equal((await app.inject(`/api/backups/${reset.backup.name}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/learning', payload: { itemId, planGeneration: plan.generation } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/answers/old-autosave', payload: { id: 'old-autosave', itemId, stage: 'learn', originalAnswer: 'Stale tab content.', expectedRevision: 0, planGeneration: plan.generation } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/reviews', payload: { answerId: 'reset-recall', rating: 'hard', planGeneration: plan.generation } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/plan/reset', payload: { confirm: true, date: plan.date, generation: plan.generation } })).statusCode, 409);

  const downloadUrl = `/api/resets/${reset.recoveryId}`;
  assert.equal((await app.inject({ url: downloadUrl, headers: { host: 'mini.private.ts.net', 'tailscale-user-login': 'other@example.com' } })).statusCode, 403);
  assert.equal((await app.inject('/api/resets/not-a-recovery-id')).statusCode, 404);
  const downloaded = await app.inject(downloadUrl);
  assert.equal(downloaded.statusCode, 200);
  assert.match(downloaded.headers['content-disposition'] as string, /attachment/);
  assert.match(downloaded.headers['content-type'] as string, /application\/json/);
  const recovery = downloaded.json<BackupData>();
  assert.deepEqual(recovery.items, before.items);
  assert.deepEqual(recovery.answers, before.answers);
  assert.deepEqual(recovery.reviews, before.reviews);
  assert.equal((await app.inject({ method: 'POST', url: '/api/restore/validate', payload: recovery })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/learning', payload: { itemId, planGeneration: reset.plan.generation } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/restore', payload: { confirm: true, backup: recovery } })).statusCode, 200);
  assert.deepEqual(store.exportBackup().items, before.items);
  assert.deepEqual(store.exportBackup().answers, before.answers);
  assert.deepEqual(store.exportBackup().reviews, before.reviews);
  assert.equal(store.getDailyPlan().generation, plan.generation);
});
