import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.ts';
import { AppError } from '../server/errors.ts';
import { validateBackup } from '../server/validation.ts';
import type { AnswerRecord, ParsedStudyItem, StudyItem } from '../shared/types.ts';

function entry(term: string): ParsedStudyItem {
  const body = [`Definition: a meaning of ${term}`, `Speaking: ${term}`, `Writing: a formal ${term}`];
  return {
    source: { noteId: 'reset-note', noteTitle: 'Synthetic reset notes', folderId: 'reset-folder', folderName: '测试词汇', blockId: term },
    title: `${term} → a meaning（测试）`, term, gloss: 'a meaning', chinese: '测试', definition: `a meaning of ${term}`,
    body, speaking: [term], writing: [`a formal ${term}`], warnings: [], members: [], tags: ['Both'],
    kind: 'phrase', needsSupplement: false, contentHash: createHash('sha256').update(body.join('\n')).digest('hex'),
  };
}

function fixture(t: TestContext, terms = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-review-reset-test-'));
  let now = new Date('2026-10-02T02:00:00Z');
  const store = new Store(dir, () => now);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.saveSettings({ newLimit: 3, reviewLimit: 10, practiceLimit: 3, timezone: 'Asia/Shanghai' });
  const parsed = terms.map(entry);
  store.applySync(parsed, [], now.toISOString());
  return { store, dir, parsed, setTime: (value: string) => { now = new Date(value); } };
}

function scheduling(item: StudyItem) {
  return { card: item.card, learnedAt: item.learnedAt, dueAt: item.dueAt, lastRating: item.lastRating, lapses: item.lapses, needsRelearn: item.needsRelearn };
}

function submitReview(store: Store, itemId: string, id: string, generation = store.getDailyPlan().generation): AnswerRecord {
  return store.saveAnswer({ id, itemId, stage: 'review', originalAnswer: 'My own English explanation.\n保留中文和换行。', expectedRevision: 0, submit: true, planGeneration: generation });
}

const stalePlan = (error: unknown) => error instanceof AppError && error.status === 409;

test('reset removes today activity, returns learning to its original state and keeps a restorable recovery backup', async t => {
  const { store, dir } = fixture(t);
  const first = store.getDailyPlan();
  assert.equal(first.generation, 0);
  const id = first.learn[0].id;
  const beforeLearning = scheduling(store.getItem(id));
  store.completeLearning(id, first.generation);
  store.rateAnswer(submitReview(store, id, 'today-recall').id, 'hard');
  const question = store.getDailyPlan().practice[0];
  store.saveAnswer({ id: 'today-practice', itemId: id, stage: 'practice', questionId: question.id, originalAnswer: 'I use this expression in a sentence.', expectedRevision: 0, submit: true, planGeneration: first.generation });
  const beforeReset = store.exportBackup();

  const reset = await store.resetToday(first.date, first.generation);
  assert.equal(reset.plan.generation, 1);
  assert.equal(reset.plan.counts.learned, 0);
  assert.equal(reset.plan.counts.reviewed, 0);
  assert.equal(reset.plan.counts.practiced, 0);
  assert.equal(reset.plan.learn.length, 3);
  assert.equal(reset.plan.review.length, 0);
  assert.equal(reset.plan.practice.length, 0);
  assert.equal(store.listAnswers().length, 0);
  assert.equal(store.exportBackup().reviews.length, 0);
  assert.deepEqual(scheduling(store.getItem(id)), beforeLearning);
  assert.ok(fs.statSync(path.join(dir, 'backups', reset.backup.name)).size > 0);
  assert.deepEqual(store.getDailyPlan().learn.map(item => item.id), reset.plan.learn.map(item => item.id));

  const recovery = store.getResetBackup(reset.recoveryId);
  validateBackup(recovery);
  assert.deepEqual(recovery.items, beforeReset.items);
  assert.deepEqual(recovery.answers, beforeReset.answers);
  assert.deepEqual(recovery.reviews, beforeReset.reviews);
  await store.restore(recovery);
  assert.deepEqual(store.exportBackup().items, beforeReset.items);
  assert.deepEqual(store.exportBackup().answers, beforeReset.answers);
  assert.deepEqual(store.exportBackup().reviews, beforeReset.reviews);
  assert.equal(store.getDailyPlan().generation, first.generation);
});

test('reset restores an older card schedule exactly and preserves earlier answers, ratings and daily plans', async t => {
  const { store, setTime } = fixture(t);
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  store.rateAnswer(submitReview(store, id, 'historical-recall').id, 'good');
  const historical = store.exportBackup();
  const previous = scheduling(store.getItem(id));
  setTime(new Date(Date.parse(store.getItem(id).dueAt!) + 1000).toISOString());
  const today = store.getDailyPlan();
  assert.notEqual(today.date, first.date);
  assert.ok(today.review.some(item => item.id === id));
  store.rateAnswer(submitReview(store, id, 'today-lapse').id, 'again');
  assert.notDeepEqual(scheduling(store.getItem(id)), previous);

  const reset = await store.resetToday(today.date, today.generation);
  assert.deepEqual(scheduling(store.getItem(id)), previous);
  assert.deepEqual(store.getAnswer('historical-recall'), historical.answers.find(answer => answer.id === 'historical-recall'));
  assert.deepEqual(store.exportBackup().reviews, historical.reviews);
  assert.deepEqual(store.exportBackup().plans.find(plan => plan.date === first.date), historical.plans.find(plan => plan.date === first.date));
  assert.equal(store.listAnswers().length, 1);
  assert.ok(reset.plan.review.some(item => item.id === id));
  assert.equal(reset.plan.counts.learned, 0);
  assert.equal(reset.plan.counts.reviewed, 0);
});

test('ratings with the same timestamp are undone in reverse action order', async t => {
  const { store, setTime } = fixture(t, ['one expression']);
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  store.rateAnswer(submitReview(store, id, 'prior-review').id, 'good');
  const previous = scheduling(store.getItem(id));
  setTime(new Date(Date.parse(store.getItem(id).dueAt!) + 1000).toISOString());
  const today = store.getDailyPlan();
  store.rateAnswer(submitReview(store, id, 'same-time-review').id, 'hard');
  const question = store.getDailyPlan().practice[0];
  const practice = store.saveAnswer({ id: 'same-time-practice', itemId: id, stage: 'practice', questionId: question.id, originalAnswer: 'This is my application sentence.', expectedRevision: 0, submit: true, planGeneration: today.generation });
  store.rateAnswer(practice.id, 'good');
  const sameTime = store.exportBackup().reviews.filter(review => review.answerId === practice.id || review.answerId === 'same-time-review');
  assert.equal(sameTime[0].reviewedAt, sameTime[1].reviewedAt);

  await store.resetToday(today.date, today.generation);
  assert.deepEqual(scheduling(store.getItem(id)), previous);
});

test('reset protects a carried draft while removing answers created after the local midnight boundary', async t => {
  const { store, setTime } = fixture(t);
  setTime('2026-10-02T15:50:00Z');
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  const draft = store.saveAnswer({ id: 'yesterday-draft', itemId: id, stage: 'review', originalAnswer: 'My unfinished English draft.\n不要删除。', expectedRevision: 0, planGeneration: first.generation });
  const previous = scheduling(store.getItem(id));
  const historicalPlan = store.exportBackup().plans.find(plan => plan.date === first.date);
  setTime('2026-10-02T16:01:00Z');
  const today = store.getDailyPlan();
  assert.equal(today.date, '2026-10-03');
  assert.equal(store.getAnswer(draft.id).date, today.date);
  assert.equal(store.getAnswer(draft.id).createdAt, draft.createdAt);
  const newId = today.learn[0].id;
  store.completeLearning(newId, today.generation);
  submitReview(store, newId, 'today-answer');

  await store.resetToday(today.date, today.generation);
  const carried = store.getAnswer(draft.id);
  assert.equal(carried.status, 'draft');
  assert.equal(carried.originalAnswer, draft.originalAnswer);
  assert.equal(carried.createdAt, draft.createdAt);
  assert.equal(store.listAnswers().length, 1);
  assert.deepEqual(scheduling(store.getItem(id)), previous);
  assert.deepEqual(store.exportBackup().plans.find(plan => plan.date === first.date), historicalPlan);
  assert.equal(store.getItem(newId).learnedAt, null);
});

test('rating a carried submitted answer today can be undone without deleting its earlier submission', async t => {
  const { store, setTime } = fixture(t);
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  const oldSubmission = submitReview(store, id, 'yesterday-submitted');
  const previous = scheduling(store.getItem(id));
  setTime('2026-10-03T02:00:00Z');
  const today = store.getDailyPlan();
  store.rateAnswer(oldSubmission.id, 'hard');
  assert.equal(store.getAnswer(oldSubmission.id).status, 'rated');

  const reset = await store.resetToday(today.date, today.generation);
  const answer = store.getAnswer(oldSubmission.id);
  assert.equal(answer.status, 'submitted');
  assert.equal(answer.rating, null);
  assert.equal(answer.originalAnswer, oldSubmission.originalAnswer);
  assert.equal(answer.createdAt, oldSubmission.createdAt);
  assert.ok(answer.revision > oldSubmission.revision);
  assert.deepEqual(scheduling(store.getItem(id)), previous);
  assert.equal(store.exportBackup().reviews.length, 0);
  assert.throws(() => store.rateAnswer(oldSubmission.id, 'hard', today.generation), stalePlan);
  assert.equal(store.getAnswer(oldSubmission.id).status, 'submitted');
  assert.deepEqual(scheduling(store.getItem(id)), previous);
  store.rateAnswer(oldSubmission.id, 'hard', reset.plan.generation);
  assert.equal(store.getAnswer(oldSubmission.id).status, 'rated');
});

test('reset keeps current note changes and archive decisions while undoing only learning scheduling', async t => {
  const { store, parsed, setTime } = fixture(t);
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  store.rateAnswer(submitReview(store, id, 'old-version-recall').id, 'good');
  const previous = scheduling(store.getItem(id));
  setTime(new Date(Date.parse(store.getItem(id).dueAt!) + 1000).toISOString());
  const today = store.getDailyPlan();
  store.rateAnswer(submitReview(store, id, 'today-old-version').id, 'hard');
  const changed = parsed.map(item => item.term === store.getItem(id).term ? { ...item, definition: 'The latest meaning', body: ['Definition: The latest meaning'], contentHash: 'a'.repeat(64) } : item);
  store.applySync(changed, [], '2026-10-10T02:00:00Z');
  store.updateItem(id, { status: 'archived' });
  const latest = store.getItem(id);
  assert.equal(latest.needsRelearn, true);

  await store.resetToday(today.date, today.generation);
  const current = store.getItem(id);
  assert.equal(current.version, latest.version);
  assert.equal(current.contentHash, latest.contentHash);
  assert.equal(current.definition, latest.definition);
  assert.deepEqual(current.body, latest.body);
  assert.deepEqual(current.source, latest.source);
  assert.equal(current.status, 'archived');
  assert.equal(current.needsRelearn, true);
  assert.deepEqual(current.card, previous.card);
  assert.equal(current.dueAt, previous.dueAt);
  assert.equal(current.lastRating, previous.lastRating);
});

test('old backup records without rollback snapshots still restore the historical due date after reset', async t => {
  const { store, setTime } = fixture(t);
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  store.rateAnswer(submitReview(store, id, 'legacy-history').id, 'good');
  const previous = scheduling(store.getItem(id));
  setTime(new Date(Date.parse(store.getItem(id).dueAt!) + 1000).toISOString());
  const today = store.getDailyPlan();
  store.rateAnswer(submitReview(store, id, 'legacy-today').id, 'again');
  const legacy = store.exportBackup();
  for (const review of legacy.reviews) delete review.before;
  for (const plan of legacy.plans) delete plan.learningBefore;
  validateBackup(legacy);
  await store.restore(legacy);

  await store.resetToday(today.date, today.generation);
  assert.deepEqual(scheduling(store.getItem(id)), previous);
  assert.equal(store.listAnswers().length, 1);
  assert.equal(store.getAnswer('legacy-history').status, 'rated');
});

test('resetting a relearn action preserves the older card even when its learning timestamp was cleared', async t => {
  const { store, setTime } = fixture(t);
  const first = store.getDailyPlan();
  const id = first.learn[0].id;
  store.completeLearning(id, first.generation);
  store.rateAnswer(submitReview(store, id, 'before-relearn').id, 'good');
  setTime('2026-10-03T02:00:00Z');
  store.updateItem(id, { useLatest: true });
  store.saveSettings({ newLimit: store.listItems().length });
  const beforeRelearning = scheduling(store.getItem(id));
  assert.ok(beforeRelearning.card);
  assert.equal(beforeRelearning.learnedAt, null);
  const today = store.getDailyPlan();
  assert.ok(today.learn.some(item => item.id === id));
  store.completeLearning(id, today.generation);
  store.rateAnswer(submitReview(store, id, 'relearn-today').id, 'hard');

  await store.resetToday(today.date, today.generation);
  assert.deepEqual(scheduling(store.getItem(id)), beforeRelearning);
  assert.equal(store.getAnswer('before-relearn').status, 'rated');
  assert.equal(store.exportBackup().reviews.length, 1);
});

test('stale windows cannot recreate cleared answers or learning after the plan generation changes', async t => {
  const { store } = fixture(t);
  const first = store.getDailyPlan();
  const reset = await store.resetToday(first.date, first.generation);
  const id = reset.plan.learn[0].id;
  assert.throws(() => store.completeLearning(id, first.generation), stalePlan);
  assert.throws(() => store.saveAnswer({ id: 'stale-autosave', itemId: id, stage: 'learn', originalAnswer: 'An old tab is saving.', expectedRevision: 0, planGeneration: first.generation }), stalePlan);
  assert.equal(store.listAnswers().length, 0);
  assert.equal(store.getItem(id).learnedAt, null);
  await assert.rejects(store.resetToday(first.date, first.generation), stalePlan);
  store.completeLearning(id, reset.plan.generation);
  submitReview(store, id, 'current-generation', reset.plan.generation);
  assert.equal(store.listAnswers().length, 1);
});

test('concurrent reset requests commit only one generation and the replacement queue is stable across reloads', async t => {
  const terms = Array.from({ length: 30 }, (_, index) => `synthetic-expression-${index}`);
  const { store } = fixture(t, terms);
  store.saveSettings({ newLimit: terms.length });
  const first = store.getDailyPlan();
  const results = await Promise.allSettled([store.resetToday(first.date, first.generation), store.resetToday(first.date, first.generation)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected');
  assert.ok(rejection?.status === 'rejected' && stalePlan(rejection.reason));
  const current = store.getDailyPlan();
  assert.equal(current.generation, first.generation + 1);
  assert.equal(current.learn.length, terms.length);
  assert.equal(new Set(current.learn.map(item => item.id)).size, terms.length);
  assert.notDeepEqual(current.learn.map(item => item.id), first.learn.map(item => item.id));
  assert.deepEqual(store.getDailyPlan().learn.map(item => item.id), current.learn.map(item => item.id));
});
