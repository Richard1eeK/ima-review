import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.ts';
import { csvExport, evaluationPack, markdownExport } from '../server/export.ts';
import { validateBackup } from '../server/validation.ts';
import { startScheduler } from '../server/scheduler.ts';
import type { ParsedStudyItem } from '../shared/types.ts';

function entry(term: string, blockId = term, noteId = 'note-1'): ParsedStudyItem {
  const body = [`Definition: a meaning of ${term}`, `📣 Speaking: ${term}`, `📝 Writing: a formal ${term}`];
  return { source: { noteId, noteTitle: 'Test notes', folderId: 'folder-1', folderName: '雅思词汇', blockId }, title: `${term} → a meaning（测试）`, term, gloss: 'a meaning', chinese: '测试', definition: body[0].slice(12), body, speaking: [term], writing: [`a formal ${term}`], warnings: [], members: [], tags: ['Both'], kind: 'phrase', needsSupplement: false, contentHash: createHash('sha256').update(body.join('\n')).digest('hex') };
}
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-review-test-'));
  let now = new Date('2026-10-02T02:00:00Z');
  const store = new Store(dir, () => now);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, dir, setTime: (date: string) => { now = new Date(date); } };
}
function submit(store: Store, itemId: string, id = 'answer-1', stage: 'learn' | 'review' = 'learn') {
  return store.saveAnswer({ id, itemId, stage, originalAnswer: 'My own explanation.\n中文备注, "quoted"', expectedRevision: 0, submit: true });
}
test('snapshot diff preserves identity across reordered/regenerated block IDs and preserves answers on modification', t => {
  const { store } = fixture(t); const at = '2026-10-02T02:00:00Z';
  assert.equal(store.applySync([entry('wing it'), entry('a tad')], [], at).added, 2);
  const item = store.listItems().find(x => x.term === 'wing it')!;
  const answer = submit(store, item.id); store.rateAnswer(answer.id, 'good');
  const recall = submit(store, item.id, 'recall-1', 'review'); store.rateAnswer(recall.id, 'good');
  store.applySync([entry('a tad', 'new-block-a'), entry('wing it', 'new-block-b')], [], at);
  assert.equal(store.listItems().find(x => x.term === 'wing it')!.id, item.id);
  const changed = { ...entry('wing it', 'new-block-b'), body: ['Changed definition'], contentHash: 'f'.repeat(64) };
  const counts = store.applySync([changed], [], '2026-10-03T02:00:00Z');
  assert.equal(counts.modified, 1); assert.equal(counts.archived, 1);
  const current = store.getItem(item.id);
  assert.equal(current.version, 2); assert.equal(current.needsRelearn, true); assert.ok(current.card);
  assert.equal(store.getAnswer(answer.id).itemVersion, 1); assert.match(store.getAnswer(answer.id).reference.join('\n'), /a meaning of wing it/);
});
test('missing source archives reversibly and manual archive stays archived', t => {
  const { store } = fixture(t); const parsed = entry('a tad');
  store.applySync([parsed], [], '2026-10-02T02:00:00Z'); const id = store.listItems()[0].id;
  store.applySync([], [], '2026-10-02T02:01:00Z'); assert.equal(store.getItem(id).status, 'archived');
  store.applySync([parsed], [], '2026-10-02T02:02:00Z'); assert.equal(store.getItem(id).status, 'active');
  store.updateItem(id, { status: 'archived' }); store.applySync([parsed], [], '2026-10-02T02:03:00Z');
  assert.equal(store.getItem(id).status, 'archived');
});
test('daily limits, stable drafts, conflict handling, idempotent ratings and practice do not double-schedule', t => {
  const { store } = fixture(t);
  store.saveSettings({ newLimit: 1, practiceLimit: 2 });
  store.applySync([entry('a tad'), entry('wing it')], [], '2026-10-02T02:00:00Z');
  const plan = store.getDailyPlan(); assert.equal(plan.learn.length, 1); assert.equal(plan.practice.length, 0);
  const id = plan.learn[0].id;
  const draft = store.saveAnswer({ id: 'draft', itemId: id, stage: 'learn', originalAnswer: 'This means...', expectedRevision: 0 });
  assert.throws(() => store.saveAnswer({ id: 'draft', itemId: id, stage: 'learn', originalAnswer: 'stale', expectedRevision: 0 }), /另一个窗口/);
  assert.throws(() => store.saveAnswer({ id: 'duplicate', itemId: id, stage: 'learn', originalAnswer: 'another window', expectedRevision: 0 }), /另一份回答/);
  const submitted = store.saveAnswer({ id: 'draft', itemId: id, stage: 'learn', originalAnswer: 'This means a small amount.', expectedRevision: draft.revision, submit: true });
  assert.throws(() => store.saveAnswer({ id: 'draft', itemId: id, stage: 'learn', originalAnswer: 'overwrite', expectedRevision: submitted.revision }), /原始回答已提交/);
  const rated = store.rateAnswer('draft', 'good'); assert.equal(store.rateAnswer('draft', 'good').review.id, rated.review.id);
  assert.equal(store.getDailyPlan().counts.learned, 1); assert.equal(store.getDailyPlan().learn.length, 0);
  assert.equal(store.getDailyPlan().review[0].id, id); assert.equal(store.getDailyPlan().practice.length, 0);
  const recall = submit(store, id, 'recall-1', 'review'); store.rateAnswer(recall.id, 'good');
  const q = store.getDailyPlan().practice[0]; const before = JSON.stringify(store.getItem(id).card);
  store.saveAnswer({ id: 'practice-1', itemId: id, stage: 'practice', questionId: q.id, originalAnswer: 'I would use it here.', expectedRevision: 0, submit: true });
  store.rateAnswer('practice-1', 'hard'); assert.equal(JSON.stringify(store.getItem(id).card), before);
  assert.equal(store.getDailyPlan().counts.practiced, 1);
});
test('unfinished drafts and submitted ungraded responses survive midnight and resume the same record', t => {
  const { store, setTime } = fixture(t); store.applySync([entry('wing it')], [], '2026-10-02T02:00:00Z');
  const item = store.getDailyPlan().learn[0];
  const draft = store.saveAnswer({ id: 'carry', itemId: item.id, stage: 'learn', originalAnswer: 'unfinished explanation', expectedRevision: 0 });
  setTime('2026-10-02T16:01:00Z'); const next = store.getDailyPlan();
  assert.equal(next.date, '2026-10-03'); assert.equal(next.learn[0].id, item.id);
  const carried = store.getAnswer(draft.id); assert.equal(carried.date, next.date); assert.equal(carried.originalAnswer, draft.originalAnswer); assert.equal(carried.createdAt, draft.createdAt);
});
test('markdown, CSV and model pack include immutable answers, versions and safe Unicode', t => {
  const { store } = fixture(t); store.applySync([entry('wing it')], [], '2026-10-02T02:00:00Z');
  const answer = submit(store, store.getDailyPlan().learn[0].id);
  const md = markdownExport([answer]); assert.match(md, /中文备注/); assert.match(md, /内容版本：1/); assert.match(md, /My own explanation/);
  assert.match(csvExport([answer]), /""quoted""/); assert.match(evaluationPack([answer]), /按意思评估/);
  assert.match(csvExport([{ ...answer, originalAnswer: '=1+2' }]), /'=1\+2/);
});
test('full backup validates, restores atomically and SQLite backup passes integrity check', async t => {
  const { store, dir } = fixture(t); store.applySync([entry('wing it')], [], '2026-10-02T02:00:00Z');
  const a = submit(store, store.getDailyPlan().learn[0].id); store.rateAnswer(a.id, 'good'); store.getDailyPlan();
  const recall = submit(store, a.itemId, 'recall-1', 'review'); store.rateAnswer(recall.id, 'good'); store.getDailyPlan();
  const backup = store.exportBackup(); validateBackup(backup);
  const binary = await store.backup(); assert.ok(fs.statSync(path.join(dir, 'backups', binary.name)).size > 0);
  store.applySync([entry('new thing')], [], '2026-10-03T02:00:00Z');
  await store.restore(backup); assert.equal(store.listItems().length, 1); assert.equal(store.listItems()[0].term, 'wing it'); assert.equal(store.getAnswer(a.id).status, 'rated');
  const malformed = structuredClone(backup); malformed.items[0].card!.due = 'not-a-date';
  assert.throws(() => validateBackup(malformed), /card.due/); assert.equal(store.listItems()[0].term, 'wing it');
});
test('automatic scheduler calls ima only at startup, daily and the next day; errors do not poll', async t => {
  const { store, setTime } = fixture(t); const calls: string[] = [];
  const scheduler = startScheduler(store, { run: async reason => { calls.push(reason || ''); throw new Error('offline'); } }, () => {}, 1000000);
  t.after(() => scheduler.stop()); await scheduler.startup;
  assert.deepEqual(calls, ['startup', 'daily']); await scheduler.tick(); await scheduler.tick(); assert.equal(calls.length, 2);
  setTime('2026-10-03T02:00:00Z'); await scheduler.tick(); assert.equal(calls.length, 3); assert.equal(calls.at(-1), 'daily');
});
test('first learning leads to hidden-answer recall before any application questions or FSRS advancement', t => {
  const { store } = fixture(t); store.applySync([entry('wing it')], [], '2026-10-02T02:00:00Z');
  const id = store.getDailyPlan().learn[0].id;
  store.rateAnswer(submit(store, id).id, 'good');
  assert.equal(store.getItem(id).card!.reps, 0);
  assert.equal(store.getDailyPlan().practice.length, 0);
  assert.equal(store.getDailyPlan().review[0].id, id);
  store.rateAnswer(submit(store, id, 'recall', 'review').id, 'good');
  assert.equal(store.getItem(id).card!.reps, 1);
  assert.ok(store.getDailyPlan().practice.length > 0);
});
test('manual weak-item practice survives reload and keeps the daily practice cap', t => {
  const { store } = fixture(t); store.saveSettings({ practiceLimit: 1 });
  store.applySync([entry('wing it')], [], '2026-10-02T02:00:00Z');
  const id = store.getDailyPlan().learn[0].id;
  assert.throws(() => store.addPractice(id), /请先学习/);
  store.rateAnswer(submit(store, id).id, 'good'); store.rateAnswer(submit(store, id, 'recall', 'review').id, 'hard');
  const q = store.addPractice(id); assert.equal(q.manual, true); assert.equal(store.getDailyPlan().practice[0].id, q.id);
  assert.equal(store.addPractice(id).id, q.id); assert.equal(store.getDailyPlan().practice.length, 1);
  store.saveAnswer({ id: 'manual-practice', itemId: id, stage: 'practice', questionId: q.id, originalAnswer: 'new attempt', submit: true, expectedRevision: 0 });
  assert.throws(() => store.addPractice(id), /额度已用完/);
});
test('invalid batch is atomic and duplicate term imports are held for review', t => {
  const { store } = fixture(t); const input = entry('wing it'); store.applySync([input], [], '2026-10-02T02:00:00Z');
  assert.throws(() => store.applySync([entry('new'), entry('different', 'new')], [], '2026-10-03T02:00:00Z'), /重复来源/);
  assert.equal(store.listItems().length, 1); assert.equal(store.listItems()[0].status, 'active');
  store.applySync([entry('a tad', 'one'), entry('a tad', 'two')], [], '2026-10-03T02:00:00Z');
  assert.equal(store.stats().pending, 2); assert.equal(store.getDailyPlan().learn.length, 0);
});
