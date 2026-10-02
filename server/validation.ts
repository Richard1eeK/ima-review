import { assert } from './errors.ts';
import type { BackupData, Settings } from '../shared/types.ts';
export const ratings = ['again', 'hard', 'good', 'easy'] as const;
export function object(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), '必须提供 JSON 对象');
}
export function text(value: unknown, name: string, max = 100000): asserts value is string {
  assert(typeof value === 'string' && value.length <= max, `${name} 必须是长度不超过 ${max} 的文本`);
}
export function isoDate(value: unknown, name: string, nullable = false) {
  if (nullable && value === null) return;
  text(value, name, 64);
  assert(Number.isFinite(Date.parse(value)), `${name} 时间无效`);
}
export function strings(value: unknown, name: string, max = 10000): asserts value is string[] {
  assert(Array.isArray(value) && value.length <= max, `${name} 必须是文本数组`);
  for (const v of value) text(v, name);
}
export function validateSettings(value: unknown, partial = true): asserts value is Partial<Settings> {
  object(value);
  const known = ['newLimit', 'reviewLimit', 'practiceLimit', 'timezone', 'syncTime', 'studyTime', 'folderIds', 'reducedMotion'];
  assert(Object.keys(value).every(k => known.includes(k)), '设置包含未知字段');
  if (!partial) assert(known.every(k => k in value), '备份设置字段不完整');
  for (const k of ['newLimit', 'reviewLimit', 'practiceLimit']) if (k in value) assert(typeof value[k] === 'number' && Number.isInteger(value[k]) && Number(value[k]) >= 0 && Number(value[k]) <= 500, `${k} 必须是 0–500 的整数`);
  for (const k of ['syncTime', 'studyTime']) if (k in value) assert(typeof value[k] === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value[k])), `${k} 时间格式应为 HH:mm`);
  if ('timezone' in value) {
    text(value.timezone, 'timezone', 100);
    try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); } catch { assert(false, '时区无效'); }
  }
  if ('folderIds' in value) { strings(value.folderIds, 'folderIds', 100); assert(value.folderIds.every(x => x.length > 0 && x.length < 200), '笔记本 ID 无效'); }
  if ('reducedMotion' in value) assert(typeof value.reducedMotion === 'boolean', 'reducedMotion 必须是布尔值');
}
function source(value: unknown) {
  object(value);
  for (const field of ['noteId', 'noteTitle', 'folderId', 'folderName', 'blockId']) text(value[field], `source.${field}`, 10000);
  assert(value.noteId && value.blockId, '来源 ID 为空');
}
function integer(value: unknown, name: string, minimum = 0) {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum, `${name} 数值无效`);
}
function checkItem(value: unknown) {
  object(value); source(value.source);
  for (const field of ['id', 'title', 'term', 'gloss', 'chinese', 'definition', 'contentHash']) text(value[field], `item.${field}`);
  assert(value.id && value.term && /^[a-f\d]{64}$/i.test(String(value.contentHash)), '词条标识或哈希无效');
  for (const field of ['body', 'speaking', 'writing', 'warnings', 'members', 'tags']) strings(value[field], `item.${field}`);
  assert(['active', 'archived', 'pending'].includes(String(value.status)), '词条状态无效');
  assert(['word', 'phrase', 'pattern', 'contrast'].includes(String(value.kind)), '词条类型无效');
  for (const field of ['needsSupplement', 'needsRelearn']) assert(typeof value[field] === 'boolean', `item.${field} 无效`);
  for (const field of ['createdAt', 'updatedAt']) isoDate(value[field], `item.${field}`);
  for (const field of ['learnedAt', 'dueAt']) isoDate(value[field], `item.${field}`, true);
  integer(value.version, 'item.version', 1); integer(value.lapses, 'item.lapses');
  assert(value.lastRating === null || ratings.includes(value.lastRating as typeof ratings[number]), '词条评级无效');
  if (value.card !== null) {
    object(value.card);
    const c = value.card;
    isoDate(c.due, 'card.due');
    if (c.last_review !== undefined && c.last_review !== null) isoDate(c.last_review, 'card.last_review');
    for (const k of ['stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reps', 'lapses', 'state']) assert(typeof c[k] === 'number' && Number.isFinite(c[k]) && Number(c[k]) >= 0, `card.${k} 无效`);
    assert(Number(c.state) <= 3 && Number(c.difficulty) <= 10, 'FSRS 卡片状态无效');
  }
}
export function validateBackup(value: unknown): asserts value is BackupData {
  object(value);
  assert(value.format === 'ima-review-backup' && value.version === 1, '不是受支持的 ima-review 备份');
  isoDate(value.exportedAt, 'exportedAt'); validateSettings(value.settings, false);
  for (const field of ['items', 'answers', 'reviews', 'plans', 'snapshots']) assert(Array.isArray(value[field]) && value[field].length <= 100000, `${field} 无效或过大`);
  const items = value.items as Record<string, unknown>[];
  items.forEach(checkItem);
  const itemIds = new Set(items.map(x => x.id)); assert(itemIds.size === items.length, '备份包含重复词条 ID');
  const answers = value.answers as Record<string, unknown>[];
  for (const a of answers) {
    object(a); source(a.source);
    for (const k of ['id', 'itemId', 'questionId', 'prompt', 'originalAnswer', 'revisedAnswer', 'feedback', 'date']) text(a[k], `answer.${k}`);
    strings(a.reference, 'answer.reference'); integer(a.itemVersion, 'answer.itemVersion', 1); integer(a.revision, 'answer.revision', 1);
    assert(itemIds.has(a.itemId), '回答引用不存在的词条');
    assert(['learn', 'review', 'practice'].includes(String(a.stage)) && ['draft', 'submitted', 'rated'].includes(String(a.status)), '回答状态无效');
    assert(['explain', 'contrast', 'sentence', 'register', 'pitfall'].includes(String(a.questionKind)), '题型无效');
    assert(a.rating === null || ratings.includes(a.rating as typeof ratings[number]), '回答评级无效');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(String(a.date)), '回答日期无效');
    isoDate(a.createdAt, 'answer.createdAt'); isoDate(a.updatedAt, 'answer.updatedAt');
  }
  const answerIds = new Set(answers.map(x => x.id)); assert(answerIds.size === answers.length, '重复回答 ID');
  const reviews = value.reviews as Record<string, unknown>[];
  const ratedIds = new Set<unknown>();
  for (const r of reviews) {
    object(r); text(r.id, 'review.id', 200); text(r.answerId, 'review.answerId', 200);
    assert(itemIds.has(r.itemId) && answerIds.has(r.answerId), '复习记录引用无效');
    assert(!ratedIds.has(r.answerId), '重复复习评级'); ratedIds.add(r.answerId);
    assert(ratings.includes(r.rating as typeof ratings[number]), '复习评级无效');
    isoDate(r.reviewedAt, 'review.reviewedAt'); isoDate(r.dueAt, 'review.dueAt'); object(r.log);
  }
  assert(new Set(reviews.map(r => r.id)).size === reviews.length, '重复复习 ID');
  for (const p of value.plans as Record<string, unknown>[]) {
    object(p); text(p.date, 'plan.date', 10); assert(/^\d{4}-\d{2}-\d{2}$/.test(p.date), '计划日期无效');
    strings(p.learnIds, 'plan.learnIds'); strings(p.reviewIds, 'plan.reviewIds');
    assert([...(p.learnIds as string[]), ...(p.reviewIds as string[])].every(id => itemIds.has(id)), '计划引用不存在的词条');
    assert(Array.isArray(p.questions), '计划题目无效');
    for (const q of p.questions) { object(q); text(q.id, 'question.id', 200); assert(itemIds.has(q.itemId), '题目引用不存在的词条'); text(q.prompt, 'question.prompt'); strings(q.reference, 'question.reference'); checkItem(q.item); }
  }
  assert(new Set((value.plans as Record<string, unknown>[]).map(p => p.date)).size === (value.plans as unknown[]).length, '重复计划日期');
  for (const s of value.snapshots as Record<string, unknown>[]) {
    object(s); for (const k of ['noteId', 'title', 'folderId', 'folderName', 'content', 'hash']) text(s[k], `snapshot.${k}`, 5000000);
    isoDate(s.modifiedAt, 'snapshot.modifiedAt'); isoDate(s.fetchedAt, 'snapshot.fetchedAt');
  }
  assert(new Set((value.snapshots as Record<string, unknown>[]).map(s => s.noteId)).size === (value.snapshots as unknown[]).length, '重复笔记快照');
  object(value.syncStatus);
  assert(typeof value.syncStatus.running === 'boolean', '同步状态无效');
  isoDate(value.syncStatus.lastAttemptAt, 'sync.lastAttemptAt', true); isoDate(value.syncStatus.lastSuccessAt, 'sync.lastSuccessAt', true);
  assert(value.syncStatus.error === null || typeof value.syncStatus.error === 'string', '同步错误字段无效');
}
