import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnswerInput, AnswerRecord, RatingLabel, ReviewRecord, StudyItem } from '../../shared/types';
import { message, RequestError, write } from '../api';

interface DraftCache { id: string; text: string; revision: number; dirty: boolean }
interface SessionOptions {
  sessionKey: string;
  initial?: AnswerRecord;
  input: Omit<AnswerInput, 'id' | 'originalAnswer' | 'submit' | 'expectedRevision'>;
  onRecord: (record: AnswerRecord) => void;
  onCompleted: () => void;
}

function readCache(key: string): DraftCache | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as DraftCache | null;
    return value && typeof value.id === 'string' && typeof value.text === 'string' && typeof value.revision === 'number' ? value : null;
  } catch { return null; }
}
function saveCache(key: string, value: DraftCache) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* The server remains the authoritative save target. */ }
}

export function useAnswerSession(options: SessionOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const cacheKey = `wengu:draft:${options.sessionKey}`;
  const seedRef = useRef<{ id: string; text: string; conflict?: AnswerRecord } | null>(null);
  if (!seedRef.current) {
    const cache = readCache(cacheKey);
    const initial = options.initial;
    const hasLocalEdit = cache?.dirty === true;
    seedRef.current = {
      id: initial?.id ?? cache?.id ?? crypto.randomUUID(),
      text: hasLocalEdit ? cache!.text : initial?.originalAnswer ?? cache?.text ?? '',
      ...(hasLocalEdit && initial && (cache!.id !== initial.id || cache!.revision !== initial.revision || initial.status !== 'draft') ? { conflict: initial } : {}),
    };
  }
  const seed = seedRef.current;
  const idRef = useRef(seed.id);
  const [text, setTextState] = useState(seed.text);
  const [record, setRecord] = useState(options.initial);
  const [conflict, setConflict] = useState<AnswerRecord | undefined>(seed.conflict);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rating, setRating] = useState(false);
  const [dirty, setDirty] = useState(seed.text !== (options.initial?.originalAnswer ?? ''));
  const textRef = useRef(seed.text);
  const recordRef = useRef(options.initial);
  const revisionRef = useRef(options.initial?.revision ?? 0);
  const conflictRef = useRef(seed.conflict);
  const chainRef = useRef<Promise<boolean>>(Promise.resolve(true));
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);
  const queuedRef = useRef(0);
  const ratingLockRef = useRef(false);
  const submitLockRef = useRef(false);

  const persist = useCallback(() => {
    const unsaved = textRef.current !== (recordRef.current?.originalAnswer ?? '');
    saveCache(cacheKey, { id: idRef.current, text: textRef.current, revision: revisionRef.current, dirty: unsaved });
    if (mountedRef.current) setDirty(unsaved);
  }, [cacheKey]);

  const publish = useCallback((next: AnswerRecord) => {
    idRef.current = next.id;
    recordRef.current = next;
    revisionRef.current = next.revision;
    if (mountedRef.current) setRecord(next);
    optionsRef.current.onRecord(next);
    persist();
  }, [persist]);

  const enqueue = useCallback((submit = false): Promise<boolean> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const answer = textRef.current;
    queuedRef.current += 1;
    if (mountedRef.current) setSaving(true);
    const task = chainRef.current.catch(() => false).then(async () => {
      if (conflictRef.current) return false;
      const current = recordRef.current;
      if (current && current.status !== 'draft') return false;
      if (!submit && current?.originalAnswer === answer) return true;
      if (mountedRef.current) setError('');
      try {
        const next = await write<AnswerRecord>(`/api/answers/${encodeURIComponent(idRef.current)}`, 'PUT', {
          ...optionsRef.current.input, id: idRef.current, originalAnswer: answer,
          submit, expectedRevision: revisionRef.current,
        } satisfies AnswerInput);
        publish(next);
        if (submit) optionsRef.current.onCompleted();
        return true;
      } catch (cause) {
        if (cause instanceof RequestError && cause.status === 409 && cause.current) {
          conflictRef.current = cause.current;
          if (mountedRef.current) setConflict(cause.current);
        }
        if (mountedRef.current) setError(message(cause));
        persist();
        return false;
      }
    }).finally(() => {
      queuedRef.current -= 1;
      if (mountedRef.current && queuedRef.current === 0) setSaving(false);
    });
    chainRef.current = task;
    return task;
  }, [persist, publish]);

  const setText = useCallback((value: string) => {
    if (recordRef.current?.status !== undefined && recordRef.current.status !== 'draft') return;
    textRef.current = value;
    setTextState(value);
    persist();
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!conflictRef.current) timerRef.current = setTimeout(() => { void enqueue(); }, 650);
  }, [enqueue, persist]);

  const submit = useCallback(async () => {
    if (submitLockRef.current || ratingLockRef.current || !textRef.current.trim()) return;
    submitLockRef.current = true;
    setSubmitting(true);
    try { await enqueue(true); }
    finally { submitLockRef.current = false; if (mountedRef.current) setSubmitting(false); }
  }, [enqueue]);

  const acceptRemote = useCallback(() => {
    const remote = conflictRef.current;
    if (!remote) return;
    conflictRef.current = undefined;
    setConflict(undefined);
    textRef.current = remote.originalAnswer;
    setTextState(remote.originalAnswer);
    setError('');
    publish(remote);
  }, [publish]);

  const retryLocal = useCallback(async () => {
    const remote = conflictRef.current;
    if (!remote || remote.status !== 'draft') return;
    idRef.current = remote.id;
    recordRef.current = remote;
    revisionRef.current = remote.revision;
    conflictRef.current = undefined;
    setRecord(remote);
    setConflict(undefined);
    setError('');
    persist();
    await enqueue();
  }, [enqueue, persist]);

  const rate = useCallback(async (value: RatingLabel) => {
    if (ratingLockRef.current || submitLockRef.current || conflictRef.current) return;
    const current = recordRef.current;
    if (!current || current.status === 'draft' || current.rating) return;
    ratingLockRef.current = true;
    setRating(true);
    setError('');
    try {
      const result = await write<{ item: StudyItem; review: ReviewRecord; answer: AnswerRecord }>('/api/reviews', 'POST', { answerId: current.id, rating: value });
      publish(result.answer);
      optionsRef.current.onCompleted();
    } catch (cause) { if (mountedRef.current) setError(message(cause)); }
    finally { ratingLockRef.current = false; if (mountedRef.current) setRating(false); }
  }, [publish]);

  useEffect(() => {
    mountedRef.current = true;
    if (dirty && !conflictRef.current && (!recordRef.current || recordRef.current.status === 'draft')) {
      timerRef.current = setTimeout(() => { void enqueue(); }, 650);
    }
    const beforeUnload = () => persist();
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      persist();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  return { text, setText, record, conflict, error, saving, submitting, rating, dirty, submit,
    retry: () => enqueue(), acceptRemote, retryLocal, rate };
}
