import { createHash } from 'node:crypto';
import type { Question, QuestionKind, StudyItem } from '../shared/types.ts';
export function referenceFor(item: StudyItem): string[] {
  return [item.title, ...item.body];
}
export function kindsFor(item: StudyItem): QuestionKind[] {
  if (item.needsSupplement) return ['explain'];
  const kinds: QuestionKind[] = ['explain', 'sentence'];
  if (item.members.length > 1) kinds.push('contrast');
  if (item.speaking.length && item.writing.length) kinds.push('register');
  if (item.warnings.length) kinds.push('pitfall');
  return kinds;
}
export function promptFor(item: StudyItem, kind: QuestionKind): string {
  switch (kind) {
    case 'contrast': return `Explain the differences between ${item.members.join(' / ')} in your own English. Give a suitable context for each and explain why they are not always interchangeable.`;
    case 'sentence': return `Write a natural English sentence using “${item.term}”. Briefly explain the situation and why this expression fits.`;
    case 'register': return `Using “${item.term}”, write one conversational version and one version suitable for formal writing. Explain the difference in tone or usage.`;
    case 'pitfall': return `Explain a common mistake or usage restriction for “${item.term}” in your own English, then show a correct example.`;
    default: return `Explain “${item.term}” in your own English. Describe the meaning and, where relevant, its tone or usage. Avoid copying the note word for word.`;
  }
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
