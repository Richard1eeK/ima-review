export type RatingLabel = 'again' | 'hard' | 'good' | 'easy';
export type StudyStage = 'learn' | 'review' | 'practice';
export type QuestionKind = 'explain' | 'contrast' | 'sentence' | 'register' | 'pitfall';
export interface SourceRef {
  noteId: string; noteTitle: string; folderId: string; folderName: string; blockId: string;
}
export interface ParsedStudyItem {
  source: SourceRef; title: string; term: string; gloss: string; chinese: string;
  definition: string; body: string[]; speaking: string[]; writing: string[];
  warnings: string[]; members: string[]; tags: string[];
  kind: 'word' | 'phrase' | 'pattern' | 'contrast';
  needsSupplement: boolean; contentHash: string;
}
export interface StudyItem extends ParsedStudyItem {
  id: string; version: number; status: 'active' | 'archived' | 'pending';
  createdAt: string; updatedAt: string; learnedAt: string | null;
  needsRelearn: boolean; dueAt: string | null; lastRating: RatingLabel | null;
  lapses: number; card: Record<string, unknown> | null;
}
export interface NoteSnapshot {
  noteId: string; title: string; folderId: string; folderName: string;
  modifiedAt: string; content: string; hash: string; fetchedAt: string;
}
export interface Notebook { id: string; name: string; count: number }
export interface Settings {
  newLimit: number; reviewLimit: number; practiceLimit: number;
  timezone: string; syncTime: string; studyTime: string; folderIds: string[];
  reducedMotion: boolean;
}
export interface SyncCounts { added: number; modified: number; archived: number; pending: number; unchanged: number }
export interface SyncStatus {
  running: boolean; lastAttemptAt: string | null; lastSuccessAt: string | null;
  error: string | null; counts: SyncCounts | null;
}
export interface SyncPersistence {
  getSettings(): Settings;
  saveSettings(patch: Partial<Settings>): Settings;
  getSyncStatus(): SyncStatus;
  setSyncStatus(status: SyncStatus): void;
  applySync(items: ParsedStudyItem[], snapshots: NoteSnapshot[], now: string): SyncCounts;
}
export interface Question {
  id: string; itemId: string; itemVersion: number; kind: QuestionKind;
  prompt: string; reference: string[]; item: StudyItem; manual?: boolean;
}
export interface DailyPlan {
  date: string; timezone: string; studyTime: string;
  learn: StudyItem[]; review: StudyItem[]; practice: Question[];
  counts: { learned: number; reviewed: number; practiced: number; dueTotal: number; remainingNew: number };
  limits: { newLimit: number; reviewLimit: number; practiceLimit: number };
}
export interface AnswerRecord {
  id: string; itemId: string; itemVersion: number; source: SourceRef;
  stage: StudyStage; questionId: string; questionKind: QuestionKind;
  prompt: string; originalAnswer: string; revisedAnswer: string;
  feedback: string; reference: string[]; rating: RatingLabel | null;
  status: 'draft' | 'submitted' | 'rated'; date: string;
  createdAt: string; updatedAt: string; revision: number;
}
export interface ReviewRecord {
  id: string; answerId: string; itemId: string; rating: RatingLabel;
  reviewedAt: string; dueAt: string; log: Record<string, unknown>;
}
export interface AnswerInput {
  id: string; itemId: string; stage: StudyStage; questionId?: string;
  questionKind?: QuestionKind; originalAnswer: string; submit?: boolean;
  expectedRevision?: number;
}
export interface AnswerUpdate {
  revisedAnswer?: string; feedback?: string; expectedRevision: number;
}
export interface ReviewInput { answerId: string; rating: RatingLabel }
export interface BackupData {
  format: 'ima-review-backup'; version: 1; exportedAt: string;
  settings: Settings; items: StudyItem[]; answers: AnswerRecord[];
  reviews: ReviewRecord[]; plans: StoredDailyPlan[]; snapshots: NoteSnapshot[];
  syncStatus: SyncStatus;
}
export interface StoredDailyPlan {
  date: string; learnIds: string[]; reviewIds: string[]; learnedIds?: string[]; questions: Question[];
}
export interface AppStats { active: number; archived: number; pending: number; learned: number; weak: number; answers: number }
export interface BackupFile { name: string; createdAt: string; bytes: number }
export interface ApiError { error: string; code?: string; current?: AnswerRecord }
