import { createHash } from 'node:crypto';
import type { Question, QuestionKind, StudyItem } from '../shared/types.ts';
export function referenceFor(item: StudyItem): string[] {
  return [item.title, ...item.body];
}
export function kindsFor(item: StudyItem): QuestionKind[] {
  // Application practice must make the learner use the expression. An
  // explanation prompt belongs to recall, not to the application queue.
  if (item.needsSupplement) return [];
  const kinds: QuestionKind[] = ['sentence'];
  if (item.members.length > 1) kinds.push('contrast');
  if (item.speaking.length && item.writing.length) kinds.push('register');
  if (item.warnings.length) kinds.push('pitfall');
  return kinds;
}
export function promptFor(item: StudyItem, kind: QuestionKind): string {
  switch (kind) {
    case 'contrast': return `Choose the best expression from ${item.members.join(' / ')} for a situation of your own, then write one natural sentence that makes the choice clear.`;
    case 'sentence': return `Write one natural English sentence using “${item.term}”.`;
    case 'register': return `Write one conversational sentence using “${item.term}”, then rewrite it in a suitable formal style.`;
    case 'pitfall': return `Write one correct English sentence using “${item.term}” while avoiding the usage mistake described in the note.`;
    default: return `Explain “${item.term}” in your own English. Describe the meaning and, where relevant, its tone or usage. Avoid copying the note word for word.`;
  }
}
export function stableShuffle<T>(items: T[], seed: string, key: (item: T) => string): T[] {
  const order = (item: T) => createHash('sha256').update(`${seed}:${key(item)}`).digest('hex');
  return [...items].sort((a, b) => order(a).localeCompare(order(b)) || key(a).localeCompare(key(b)));
}
export function makeQuestion(item: StudyItem, kind: QuestionKind, date: string): Question {
  const id = createHash('sha256').update(`${date}:${item.id}:${kind}`).digest('hex').slice(0, 24);
  return { id, itemId: item.id, itemVersion: item.version, kind, prompt: promptFor(item, kind), reference: referenceFor(item), item: structuredClone(item) };
}
export function dateKey(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function localTime(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}
