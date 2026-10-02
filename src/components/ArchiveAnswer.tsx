import { useEffect, useRef, useState } from 'react';
import type { AnswerRecord } from '../../shared/types';
import { message, RequestError, write } from '../api';
import { answerStatus, dateTime, ratingLabel, sourceLabel, stageLabels } from '../lib';
import { ErrorNotice, Tag } from './Common';

interface Edits { revisedAnswer: string; feedback: string; revision: number }
function cachedEdits(record: AnswerRecord): Edits | null {
  try {
    const value = JSON.parse(localStorage.getItem(`wengu:revision:${record.id}`) ?? 'null') as Edits | null;
    return value && typeof value.revisedAnswer === 'string' && typeof value.feedback === 'string' && typeof value.revision === 'number' ? value : null;
  } catch { return null; }
}

export function ArchiveAnswer({ answer, onSaved }: { answer: AnswerRecord; onSaved: (record: AnswerRecord) => void }) {
  const cached = useRef(cachedEdits(answer)).current;
  const [record, setRecord] = useState(answer);
  const [revised, setRevised] = useState(cached?.revisedAnswer ?? answer.revisedAnswer);
  const [feedback, setFeedback] = useState(cached?.feedback ?? answer.feedback);
  const [conflict, setConflict] = useState<AnswerRecord | undefined>(cached && cached.revision !== answer.revision ? answer : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const dirty = revised !== record.revisedAnswer || feedback !== record.feedback;
  useEffect(() => {
    try {
      if (dirty) localStorage.setItem(`wengu:revision:${record.id}`, JSON.stringify({ revisedAnswer: revised, feedback, revision: record.revision } satisfies Edits));
      else localStorage.removeItem(`wengu:revision:${record.id}`);
    } catch { /* Keep edits in the current view when browser storage is unavailable. */ }
  }, [revised, feedback, record, dirty]);
  const save = async (base: AnswerRecord = record) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      const result = await write<AnswerRecord>(`/api/answers/${encodeURIComponent(record.id)}`, 'PATCH', {
        revisedAnswer: revised, feedback, expectedRevision: base.revision,
      });
      setRecord(result); setConflict(undefined); setSaved(true); onSaved(result);
    } catch (cause) {
      if (cause instanceof RequestError && cause.status === 409 && cause.current) setConflict(cause.current);
      setError(message(cause));
    } finally { lock.current = false; setBusy(false); }
  };
  const useRemote = () => {
    if (!conflict) return;
    setRecord(conflict); setRevised(conflict.revisedAnswer); setFeedback(conflict.feedback);
    onSaved(conflict); setConflict(undefined); setError(''); setSaved(false);
  };
  return <article className="archive-answer">
    <div className="section-heading"><div className="tags"><Tag>{stageLabels[record.stage]}</Tag><Tag>{record.rating ? ratingLabel(record.rating) : answerStatus(record.status)}</Tag></div><span className="muted">{record.date} · 保存版本 {record.revision}</span></div>
    <h2>{record.prompt}</h2><p className="source-line">来源：{sourceLabel(record.source)}</p>
    <section><h3>原始回答</h3><p className="answer-text original-answer">{record.originalAnswer || '空白草稿'}</p></section>
    {record.status !== 'draft' && <section className="reference-panel"><h3>当时的笔记参考</h3>{record.reference.length ? record.reference.map((line, index) => <p key={index}>{line}</p>) : <p className="muted">暂无参考内容。</p>}</section>}
    {conflict && <div className="conflict-panel" role="alert"><h3>修订出现版本冲突</h3><p>你的修订和反馈保留在下方，另一处已保存版本 {conflict.revision}。</p><details><summary>查看另一处的修订与反馈</summary><h4>修订回答</h4><p className="answer-text">{conflict.revisedAnswer || '尚未填写'}</p><h4>反馈</h4><p className="answer-text">{conflict.feedback || '尚未填写'}</p></details><div className="button-row"><button className="button button-secondary" disabled={busy} onClick={useRemote}>使用另一处保存的版本</button><button className="button" disabled={busy} onClick={() => { void save(conflict); }}>保留我的编辑并重新保存</button></div></div>}
    <div className="archive-edit-fields"><label htmlFor={`revised-${record.id}`}>修订回答<textarea id={`revised-${record.id}`} value={revised} disabled={busy} rows={6} placeholder="对照评阅建议，用英语改进这份回答…" onChange={event => { setRevised(event.target.value); setSaved(false); }} /></label><label htmlFor={`feedback-${record.id}`}>外部评阅反馈<textarea id={`feedback-${record.id}`} value={feedback} disabled={busy} rows={5} placeholder="粘贴老师或模型的反馈，保留修改依据…" onChange={event => { setFeedback(event.target.value); setSaved(false); }} /></label></div>
    <ErrorNotice error={conflict ? '' : error} retry={() => { void save(); }} />
    <div className="card-actions"><p className="muted" role="status">{saved ? '修订和反馈已保存。' : dirty ? '编辑尚未保存；输入已保留在本机。' : `最后保存：${dateTime(record.updatedAt)}`}</p><button className="button button-primary" disabled={busy || !dirty || !!conflict} onClick={() => { void save(); }}>{busy ? '保存中…' : '保存修订与反馈'}</button></div>
  </article>;
}
