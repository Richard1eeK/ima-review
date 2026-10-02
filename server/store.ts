import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createEmptyCard, fsrs, Rating, type CardInput } from 'ts-fsrs';
import { defaultSettings, emptySyncStatus } from '../shared/defaults.ts';
import type { AnswerInput, AnswerRecord, AnswerUpdate, AppStats, BackupData, BackupFile, DailyPlan, NoteSnapshot, ParsedStudyItem, RatingLabel, ReviewRecord, Settings, StoredDailyPlan, StudyItem, SyncCounts, SyncStatus } from '../shared/types.ts';
import { assert, AppError } from './errors.ts';
import { dateKey, kindsFor, makeQuestion, promptFor, referenceFor, stableShuffle } from './questions.ts';
import { ratings, text, validateBackup, validateSettings } from './validation.ts';
import { resolveConfig } from './config.ts';

const tables = ['items', 'answers', 'reviews', 'plans', 'snapshots'] as const;
type Table = typeof tables[number];
const encode = (value: unknown) => JSON.stringify(value);
const normalizeTerm = (term: string) => term.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const ratingMap = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy } as const;

export class Store {
  readonly db: DatabaseSync;
  private scheduler = fsrs({ request_retention: 0.9, enable_fuzz: false, enable_short_term: false });
  private backupPromise: Promise<BackupFile> | null = null;
  constructor(readonly dataDir: string, readonly clock: () => Date = () => new Date()) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    this.db = new DatabaseSync(path.join(dataDir, 'review.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL);');
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    fs.chmodSync(path.join(dataDir, 'review.sqlite'), 0o600);
    if (!this.getMeta('schemaVersion')) this.setMeta('schemaVersion', 1);
    assert(this.getMeta('schemaVersion') === 1, '数据库版本不受支持', 500);
    // A process that ended during a network request must not leave the UI permanently running.
    const sync = this.getSyncStatus();
    if (sync.running) this.setSyncStatus({ ...sync, running: false, error: '上次同步被服务重启中断，请重新同步。' });
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private all<T>(table: Table): T[] { return this.db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(row.value as string) as T); }
  private get<T>(table: Table, id: string): T | undefined { const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id); return row ? JSON.parse(row.value as string) as T : undefined; }
  private put(table: Table, id: string, value: unknown) { this.db.prepare(`INSERT INTO ${table} (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(id, encode(value)); }
  getMeta<T = unknown>(id: string): T | undefined { const row = this.db.prepare('SELECT value FROM meta WHERE id=?').get(id); return row ? JSON.parse(row.value as string) as T : undefined; }
  setMeta(id: string, value: unknown) { this.db.prepare('INSERT INTO meta (id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, encode(value)); }
  getSettings(): Settings { return { ...defaultSettings, ...this.getMeta<Partial<Settings>>('settings') }; }
  saveSettings(patch: Partial<Settings>): Settings { validateSettings(patch); const value = { ...this.getSettings(), ...patch }; this.setMeta('settings', value); return value; }
  getSyncStatus(): SyncStatus { return { ...emptySyncStatus, ...this.getMeta<SyncStatus>('syncStatus') }; }
  setSyncStatus(status: SyncStatus) { this.setMeta('syncStatus', status); }
  listItems(): StudyItem[] { return this.all<StudyItem>('items').sort((a, b) => a.term.localeCompare(b.term, 'en')); }
  getItem(id: string): StudyItem { const item = this.get<StudyItem>('items', id); assert(item, '词条不存在', 404, 'NOT_FOUND'); return item; }
  updateItem(id: string, patch: { status?: 'active' | 'archived'; useLatest?: boolean }): StudyItem {
    assert(patch.status === undefined || ['active', 'archived'].includes(patch.status), '词条状态无效');
    const item = this.getItem(id);
    if (patch.status) { item.status = patch.status; this.setMeta(`archiveReason:${id}`, patch.status === 'archived' ? 'manual' : null); }
    if (patch.useLatest) { item.needsRelearn = false; item.learnedAt = null; item.dueAt = null; }
    item.updatedAt = this.clock().toISOString(); this.put('items', id, item); return item;
  }
  completeLearning(itemId: string): StudyItem {
    // Learning is a confirmation action. It intentionally creates no answer
    // record; the English recall belongs to the review stage.
    const plan = this.getDailyPlan();
    return this.transaction(() => {
      const item = this.getItem(itemId);
      assert(item.status === 'active', '请先恢复或核对该词条');
      const stored = this.get<StoredDailyPlan>('plans', plan.date);
      assert(stored, '今日计划不存在，请重新加载');
      stored.learnedIds ??= [];
      if (!stored.learnIds.includes(item.id) && !stored.learnedIds.includes(item.id)) {
        throw new AppError('该词条不在今日新学计划内', 409, 'NOT_IN_PLAN');
      }
      if (!stored.learnedIds.includes(item.id)) stored.learnedIds.push(item.id);
      const now = this.clock();
      if (item.learnedAt === null) {
        item.card ||= JSON.parse(encode(createEmptyCard(now)));
        item.learnedAt = now.toISOString();
        item.dueAt = now.toISOString();
        item.updatedAt = now.toISOString();
        this.put('items', item.id, item);
      }
      this.put('plans', plan.date, stored);
      return item;
    });
  }
  applySync(parsed: ParsedStudyItem[], snapshots: NoteSnapshot[], now: string): SyncCounts {
    return this.transaction(() => {
      const previous = this.listItems();
      const used = new Set<string>(); const seenSources = new Set<string>();
      const counts: SyncCounts = { added: 0, modified: 0, archived: 0, pending: 0, unchanged: 0 };
      for (const input of parsed) {
        const anchor = `${input.source.noteId}:${input.source.blockId}`;
        assert(!seenSources.has(anchor), '笔记中出现重复来源块，已停止同步', 502); seenSources.add(anchor);
        const exact = previous.filter(x => x.source.noteId === input.source.noteId && x.source.blockId === input.source.blockId && !used.has(x.id));
        const sameTerm = previous.filter(x => x.source.noteId === input.source.noteId && normalizeTerm(x.term) === normalizeTerm(input.term) && !used.has(x.id));
        const candidates = exact.length ? exact : sameTerm;
        const ambiguous = candidates.length > 1;
        if (ambiguous) {
          for (const candidate of candidates) { used.add(candidate.id); candidate.status = 'pending'; this.put('items', candidate.id, candidate); }
        }
        const old = !ambiguous ? candidates[0] : undefined;
        if (old) {
          used.add(old.id);
          const changed = old.contentHash !== input.contentHash;
          const item: StudyItem = { ...old, ...input, version: old.version + (changed ? 1 : 0), updatedAt: changed ? now : old.updatedAt,
            needsRelearn: old.needsRelearn || (changed && old.learnedAt !== null) };
          // An explicitly archived word stays archived when its note remains present.
          if (old.status === 'archived' && this.getMeta<string>(`archiveReason:${old.id}`) === 'source-missing') {
            item.status = 'active'; this.setMeta(`archiveReason:${old.id}`, null);
          }
          this.put('items', item.id, item); changed ? counts.modified++ : counts.unchanged++;
        } else {
          const duplicateInImport = parsed.filter(x => x.source.noteId === input.source.noteId && normalizeTerm(x.term) === normalizeTerm(input.term)).length > 1;
          const pending = ambiguous || duplicateInImport;
          const item: StudyItem = { ...input, id: randomUUID(), version: 1, status: pending ? 'pending' : 'active',
            createdAt: now, updatedAt: now, learnedAt: null, needsRelearn: false, dueAt: null, lastRating: null, lapses: 0, card: null };
          this.put('items', item.id, item); pending ? counts.pending++ : counts.added++;
        }
      }
      for (const old of previous) if (!used.has(old.id) && old.status !== 'archived') {
        old.status = 'archived'; old.updatedAt = now; this.put('items', old.id, old);
        this.setMeta(`archiveReason:${old.id}`, 'source-missing'); counts.archived++;
      }
      for (const snapshot of snapshots) this.put('snapshots', snapshot.noteId, snapshot);
      return counts;
    });
  }
  listAnswers(filters: { itemId?: string; date?: string } = {}): AnswerRecord[] {
    return this.all<AnswerRecord>('answers').filter(a => (!filters.itemId || a.itemId === filters.itemId) && (!filters.date || a.date === filters.date)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  getAnswer(id: string): AnswerRecord { const a = this.get<AnswerRecord>('answers', id); assert(a, '回答不存在', 404, 'NOT_FOUND'); return a; }
  saveAnswer(input: AnswerInput): AnswerRecord {
    text(input.id, 'id', 200); text(input.itemId, 'itemId', 200); text(input.originalAnswer, 'originalAnswer');
    assert(input.id.length > 0 && ['learn', 'review', 'practice'].includes(input.stage), '回答参数无效');
    assert(input.submit === undefined || typeof input.submit === 'boolean', 'submit 无效');
    assert(input.expectedRevision !== undefined && Number.isInteger(input.expectedRevision) && input.expectedRevision >= 0, '请提供 expectedRevision');
    return this.transaction(() => {
      const now = this.clock(); const timestamp = now.toISOString();
      const existing = this.get<AnswerRecord>('answers', input.id);
      if (existing) {
        if (input.expectedRevision !== existing.revision) throw new AppError('另一个窗口或设备已更新此回答。你的输入已保留，请核对版本。', 409, 'REVISION_CONFLICT', existing);
        assert(existing.itemId === input.itemId && existing.stage === input.stage, '回答身份不能改变');
        assert(existing.status === 'draft', '原始回答已提交，请通过修订保存后续修改', 409, 'ANSWER_FINALIZED');
        if (input.submit) assert(input.originalAnswer.trim(), '请先输入英文回答');
        const answer = { ...existing, originalAnswer: input.originalAnswer, status: input.submit ? 'submitted' as const : 'draft' as const, updatedAt: timestamp, revision: existing.revision + 1 };
        this.put('answers', answer.id, answer); return answer;
      }
      if (input.expectedRevision !== 0) throw new AppError('回答版本不存在，请重新加载', 409, 'REVISION_CONFLICT');
      const item = this.getItem(input.itemId);
      assert(item.status === 'active', '请先恢复或核对该词条');
      const settings = this.getSettings(); const date = dateKey(now, settings.timezone);
      const plan = this.getDailyPlan();
      let questionId = input.questionId || `${date}:${input.stage}:${item.id}`;
      let kind = input.questionKind || 'explain'; let prompt = promptFor(item, kind); let reference = referenceFor(item); let version = item.version; let source = item.source;
      if (input.stage === 'learn') assert(plan.learn.some(x => x.id === item.id), '该词条不在今日新学计划内', 409, 'NOT_IN_PLAN');
      if (input.stage === 'review') assert(plan.review.some(x => x.id === item.id), '该词条不在今日到期复习计划内', 409, 'NOT_IN_PLAN');
      if (input.stage === 'practice') {
        const q = plan.practice.find(q => q.id === input.questionId && q.itemId === item.id);
        assert(q, '题目不在今日练习内或已经提交', 409, 'NOT_IN_PLAN');
        questionId = q.id; kind = q.kind; prompt = q.prompt; reference = q.reference; version = q.itemVersion; source = q.item.source;
      } else { kind = 'explain'; prompt = promptFor(item, kind); }
      // All clients editing the same task must use the same record, not create parallel answers.
      const other = this.listAnswers({ date }).find(a => a.itemId === item.id && a.stage === input.stage && a.questionId === questionId);
      if (other) throw new AppError('该任务已有另一份回答，请恢复已有记录。', 409, 'TASK_CONFLICT', other);
      if (input.submit) assert(input.originalAnswer.trim(), '请先输入英文回答');
      const answer: AnswerRecord = { id: input.id, itemId: item.id, itemVersion: version, source: structuredClone(source), stage: input.stage, questionId, questionKind: kind, prompt, reference,
        originalAnswer: input.originalAnswer, revisedAnswer: '', feedback: '', rating: null, status: input.submit ? 'submitted' : 'draft', date,
        createdAt: timestamp, updatedAt: timestamp, revision: 1 };
      this.put('answers', answer.id, answer); return answer;
    });
  }
  updateAnswer(id: string, input: AnswerUpdate): AnswerRecord {
    return this.transaction(() => {
      const a = this.getAnswer(id);
      if (input.expectedRevision !== a.revision) throw new AppError('回答已在另一个窗口更新，请先核对。', 409, 'REVISION_CONFLICT', a);
      if (input.revisedAnswer !== undefined) { text(input.revisedAnswer, 'revisedAnswer'); a.revisedAnswer = input.revisedAnswer; }
      if (input.feedback !== undefined) { text(input.feedback, 'feedback'); a.feedback = input.feedback; }
      a.revision++; a.updatedAt = this.clock().toISOString(); this.put('answers', id, a); return a;
    });
  }
  rateAnswer(answerId: string, rating: RatingLabel) {
    assert(ratings.includes(rating), '掌握程度无效');
    return this.transaction(() => {
      const a = this.getAnswer(answerId); const item = this.getItem(a.itemId);
      assert(a.status !== 'draft', '请先提交回答');
      const oldReview = this.all<ReviewRecord>('reviews').find(r => r.answerId === answerId);
      if (oldReview) { assert(oldReview.rating === rating, '该回答已经完成自评', 409); return { item, review: oldReview, answer: a }; }
      const now = this.clock();
      let log: Record<string, unknown> = { stage: 'practice', scheduling: false };
      let dueAt = item.dueAt || now.toISOString();
      if (a.stage === 'learn') {
        // First understand with the note visible; the hidden-answer review does the scheduling.
        item.card ||= JSON.parse(encode(createEmptyCard(now)));
        dueAt = now.toISOString(); item.dueAt = dueAt; item.learnedAt = now.toISOString();
        item.needsRelearn = item.version !== a.itemVersion;
        item.updatedAt = now.toISOString(); this.put('items', item.id, item);
        log = { stage: 'learn', scheduling: false, readyForRecall: true };
      } else if (a.stage === 'review') {
        const raw = item.card ? { ...item.card, due: new Date(String(item.card.due)), ...(item.card.last_review ? { last_review: new Date(String(item.card.last_review)) } : {}) } as unknown as CardInput : createEmptyCard(now);
        const result = this.scheduler.next(raw, now, ratingMap[rating]);
        item.card = JSON.parse(encode(result.card)); dueAt = result.card.due.toISOString();
        item.learnedAt ||= now.toISOString(); item.needsRelearn = item.version !== a.itemVersion;
        item.dueAt = dueAt; item.lastRating = rating; item.lapses = result.card.lapses;
        item.updatedAt = now.toISOString(); this.put('items', item.id, item);
        log = JSON.parse(encode(result.log));
      }
      const review: ReviewRecord = { id: randomUUID(), answerId, itemId: item.id, rating, reviewedAt: now.toISOString(), dueAt, log };
      a.rating = rating; a.status = 'rated'; a.revision++; a.updatedAt = now.toISOString();
      this.put('reviews', review.id, review); this.put('answers', a.id, a);
      return { item, review, answer: a };
    });
  }
  getDailyPlan(): DailyPlan {
    const settings = this.getSettings(); const now = this.clock(); const date = dateKey(now, settings.timezone);
    const items = this.listItems();
    // Unfinished work follows the learner into the next day; createdAt keeps its original time.
    for (const answer of this.listAnswers()) if (answer.date < date && answer.status !== 'rated' && (answer.stage !== 'practice' || answer.status === 'draft') && items.some(x => x.id === answer.itemId && x.status === 'active')) {
      answer.date = date; answer.revision++; answer.updatedAt = now.toISOString(); this.put('answers', answer.id, answer);
    }
    const answers = this.listAnswers({ date });
    const stored = this.get<StoredDailyPlan>('plans', date) || { date, learnIds: [], reviewIds: [], learnedIds: [], questions: [] };
    stored.learnedIds ??= [];
    const legacyLearned = answers.filter(a => a.stage === 'learn' && a.status === 'rated').map(a => a.itemId);
    const plannedLearnIds = new Set(stored.learnIds);
    const learned = new Set([...stored.learnedIds, ...legacyLearned].filter(id => plannedLearnIds.has(id)));
    const reviewed = new Set(answers.filter(a => a.stage === 'review' && a.status === 'rated').map(a => a.itemId));
    const practiced = new Set(answers.filter(a => a.stage === 'practice' && a.status !== 'draft').map(a => a.questionId));
    const available = items.filter(x => x.status === 'active');
    const newPool = stableShuffle(available.filter(x => x.learnedAt === null), `${date}:learn`, x => x.id);
    const due = available.filter(x => x.learnedAt !== null && !x.needsRelearn && x.dueAt && Date.parse(x.dueAt) <= now.getTime());
    // Keep today's newly learned entries prominent, while randomizing within
    // both groups so a long due queue does not follow note order.
    const duePool = [
      ...stableShuffle(due.filter(x => learned.has(x.id)), `${date}:review:new`, x => x.id),
      ...stableShuffle(due.filter(x => !learned.has(x.id)), `${date}:review:due`, x => x.id),
    ];
    const carriedQuestions = this.all<StoredDailyPlan>('plans').filter(p => p.date !== date).flatMap(p => p.questions).filter(q => answers.some(a => a.stage === 'practice' && a.status === 'draft' && a.questionId === q.id));
    for (const q of carriedQuestions) if (!stored.questions.some(x => x.id === q.id)) stored.questions.push(q);
    const map = new Map(items.map(x => [x.id, x]));
    const started = (id: string, stage: 'learn' | 'review') => answers.some(a => a.itemId === id && a.stage === stage);
    const retain = (ids: string[], pool: StudyItem[], stage: 'learn' | 'review', done: Set<string>, limit: number) => {
      const eligible = new Set(pool.map(x => x.id));
      const remaining = ids.filter(id => !done.has(id) && map.get(id)?.status === 'active' && (eligible.has(id) || started(id, stage)));
      const locked = remaining.filter(id => started(id, stage));
      const poolOrder = new Map(pool.map((item, index) => [item.id, index]));
      // Reorder unfinished entries through the date-stable pool order so a
      // plan created by the old import-order selector is migrated on reload.
      const optional = remaining.filter(id => !started(id, stage)).sort((a, b) => (poolOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (poolOrder.get(b) ?? Number.MAX_SAFE_INTEGER));
      const capacity = Math.max(0, limit - done.size - locked.length);
      const selected = [...locked, ...optional.slice(0, capacity)];
      for (const item of pool) if (!done.has(item.id) && !selected.includes(item.id) && selected.length < Math.max(locked.length, limit - done.size)) selected.push(item.id);
      return [...done, ...selected];
    };
    stored.learnIds = retain(stored.learnIds, newPool, 'learn', learned, settings.newLimit);
    stored.reviewIds = retain(stored.reviewIds, duePool, 'review', reviewed, settings.reviewLimit);
    stored.learnedIds = [...learned].filter(id => stored.learnIds.includes(id));
    const completed = new Set([...learned, ...reviewed]);
    const practiceItems = stableShuffle(available.filter(x => completed.has(x.id) && !x.needsRelearn), `${date}:practice`, x => x.id);
    const kept = stored.questions.filter(q => {
      const hasAnswer = answers.some(a => a.questionId === q.id);
      const eligible = practiced.has(q.id) || hasAnswer || ((q.manual || completed.has(q.itemId)) && map.get(q.itemId)?.status === 'active');
      // Unstarted legacy explanation questions are replaced by application
      // questions; submitted/draft records remain available for history.
      return q.kind !== 'explain' && eligible || q.kind === 'explain' && hasAnswer;
    });
    const generated: typeof kept = [];
    for (let round = 0; round < 5; round++) for (const item of practiceItems) {
      const kind = kindsFor(item)[round]; if (!kind) continue;
      const q = makeQuestion(item, kind, date); const existing = kept.find(x => x.id === q.id);
      generated.push(existing && (practiced.has(q.id) || answers.some(a => a.questionId === q.id)) ? existing : q);
    }
    const protectedQuestions = kept.filter(q => practiced.has(q.id) || answers.some(a => a.questionId === q.id));
    const selectedQuestions = [...protectedQuestions];
    for (const q of [...kept.filter(q => q.manual), ...generated]) if (!selectedQuestions.some(x => x.id === q.id) && selectedQuestions.length < settings.practiceLimit) selectedQuestions.push(q);
    stored.questions = selectedQuestions;
    this.put('plans', date, stored);
    return {
      date, timezone: settings.timezone, studyTime: settings.studyTime,
      learn: stored.learnIds.filter(id => !learned.has(id)).map(id => map.get(id)!).filter(Boolean),
      review: stored.reviewIds.filter(id => !reviewed.has(id)).map(id => map.get(id)!).filter(Boolean),
      practice: stored.questions.filter(q => !practiced.has(q.id)),
      counts: { learned: learned.size, reviewed: reviewed.size, practiced: practiced.size, dueTotal: duePool.length, remainingNew: newPool.length },
      limits: { newLimit: settings.newLimit, reviewLimit: settings.reviewLimit, practiceLimit: settings.practiceLimit },
    };
  }
  addPractice(itemId: string) {
    const item = this.getItem(itemId);
    assert(item.status === 'active' && item.learnedAt !== null && !item.needsRelearn, '请先学习并核对该词条的最新资料');
    const kind = kindsFor(item)[0];
    assert(kind, '该词条资料不足，暂时没有可生成的应用题', 409, 'PRACTICE_UNAVAILABLE');
    const daily = this.getDailyPlan();
    const stored = this.get<StoredDailyPlan>('plans', daily.date)!;
    const answers = this.listAnswers({ date: daily.date });
    const unfinished = stored.questions.find(q => q.itemId === item.id && q.manual && !answers.some(a => a.questionId === q.id && a.status !== 'draft'));
    if (unfinished) return unfinished;
    if (stored.questions.length >= daily.limits.practiceLimit) {
      const removable = stored.questions.map(q => !q.manual && !answers.some(a => a.questionId === q.id)).lastIndexOf(true);
      assert(removable >= 0 && daily.limits.practiceLimit > 0, '今日练习额度已用完，请在设置中增加数量', 409, 'DAILY_LIMIT');
      stored.questions.splice(removable, 1);
    }
    const question = { ...makeQuestion(item, kind, `${daily.date}:manual:${randomUUID()}`), manual: true };
    stored.questions.push(question); this.put('plans', daily.date, stored); return question;
  }
  stats(): AppStats {
    const items = this.listItems(); const active = items.filter(x => x.status === 'active');
    return { active: active.length, archived: items.filter(x => x.status === 'archived').length, pending: items.filter(x => x.status === 'pending').length,
      learned: active.filter(x => x.learnedAt !== null).length, weak: active.filter(x => x.lastRating === 'again' || x.lastRating === 'hard' || x.needsRelearn).length,
      answers: this.listAnswers().filter(a => a.status !== 'draft').length };
  }
  exportBackup(): BackupData {
    return { format: 'ima-review-backup', version: 1, exportedAt: this.clock().toISOString(), settings: this.getSettings(), items: this.listItems(),
      answers: this.listAnswers(), reviews: this.all<ReviewRecord>('reviews'), plans: this.all<StoredDailyPlan>('plans'), snapshots: this.all<NoteSnapshot>('snapshots'), syncStatus: this.getSyncStatus() };
  }
  listBackups(): BackupFile[] {
    const dir = path.join(this.dataDir, 'backups'); if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => /^review-[\w-]+\.sqlite$/.test(n)).map(name => { const s = fs.statSync(path.join(dir, name)); return { name, createdAt: s.mtime.toISOString(), bytes: s.size }; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  backup(): Promise<BackupFile> {
    if (this.backupPromise) return this.backupPromise;
    this.backupPromise = (async () => {
      const dir = path.join(this.dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = `review-${this.clock().toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}.sqlite`;
      const file = path.join(dir, name); await sqliteBackup(this.db, file); fs.chmodSync(file, 0o600);
      const verification = new DatabaseSync(file, { readOnly: true });
      try { assert(verification.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', '备份完整性验证失败', 500); } finally { verification.close(); }
      for (const old of this.listBackups().slice(30)) fs.unlinkSync(path.join(dir, old.name));
      const stat = fs.statSync(file); return { name, createdAt: stat.mtime.toISOString(), bytes: stat.size };
    })().finally(() => { this.backupPromise = null; });
    return this.backupPromise;
  }
  async restore(value: unknown) {
    validateBackup(value); assert(!this.getSyncStatus().running, '同步进行中，请稍后恢复', 409);
    await this.backup();
    // A sync may have started while the asynchronous backup was running.
    assert(!this.getSyncStatus().running, '同步进行中，请稍后恢复', 409);
    this.transaction(() => {
      for (const table of tables) this.db.exec(`DELETE FROM ${table}`);
      for (const item of value.items) this.put('items', item.id, item);
      for (const answer of value.answers) this.put('answers', answer.id, answer);
      for (const review of value.reviews) this.put('reviews', review.id, review);
      for (const plan of value.plans) this.put('plans', plan.date, plan);
      for (const snapshot of value.snapshots) this.put('snapshots', snapshot.noteId, snapshot);
      this.setMeta('settings', value.settings); this.setMeta('syncStatus', { ...value.syncStatus, running: false });
    });
  }
}
export function openStore(dataDir = resolveConfig().dataDir): Store { return new Store(dataDir); }
