import type { QuestionKind, RatingLabel, StudyStage } from '../shared/types';

export const stageLabels: Record<StudyStage, string> = { learn: '新学', review: '复习', practice: '应用题' };
export const questionLabels: Record<QuestionKind, string> = {
  explain: '解释含义', contrast: '辨析用法', sentence: '造句应用', register: '语域选择', pitfall: '避开误区',
};
export const ratings: { value: RatingLabel; label: string; description: string }[] = [
  { value: 'again', label: '重来', description: '还想不起来' },
  { value: 'hard', label: '困难', description: '想起但不熟练' },
  { value: 'good', label: '掌握', description: '能独立说清楚' },
  { value: 'easy', label: '轻松', description: '已经很熟悉' },
];
export const ratingLabel = (value: RatingLabel | null) => ratings.find(rating => rating.value === value)?.label ?? '待自评';
export const answerStatus = (value: 'draft' | 'submitted' | 'rated') => ({ draft: '草稿', submitted: '已提交', rated: '已自评' })[value];
export function dateTime(value: string | null | undefined, timezone?: string): string {
  if (!value) return '尚无记录';
  try { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}) }).format(new Date(value)); }
  catch { return value; }
}
export const sourceLabel = (source: { folderName: string; noteTitle: string }) => `${source.folderName} / ${source.noteTitle}`;

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不能访问剪贴板，请在下方文本框手动复制。');
  await navigator.clipboard.writeText(text);
}
