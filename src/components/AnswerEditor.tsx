import type { AnswerRecord, QuestionKind, StudyItem, StudyStage } from '../../shared/types';
import { questionLabels, ratingLabel, ratings, sourceLabel } from '../lib';
import { useAnswerSession } from '../hooks/useAnswerSession';
import { ErrorNotice, Tag } from './Common';
import { ItemContent, ItemFlags } from './ItemContent';

export interface AnswerTask {
  item: StudyItem; stage: StudyStage; questionId?: string; kind: QuestionKind; prompt: string;
}

export function AnswerEditor({ task, date, generation = 0, initial, onRecord, onCompleted, onNext }: {
  task: AnswerTask; date: string; generation?: number; initial?: AnswerRecord;
  onRecord: (record: AnswerRecord) => void; onCompleted: () => void; onNext: () => void;
}) {
  const sessionKey = `${date}:${generation ? `g${generation}:` : ''}${task.stage}:${task.questionId ?? task.item.id}`;
  const session = useAnswerSession({ sessionKey, initial,
    input: { itemId: task.item.id, stage: task.stage, questionId: task.questionId, questionKind: task.kind, planGeneration: generation },
    onRecord, onCompleted,
  });
  const submitted = !!session.record && session.record.status !== 'draft';
  const complete = task.stage === 'practice' ? submitted : !!session.record?.rating;
  const saveState = session.conflict ? 'is-unsaved' : session.saving ? 'is-saving' : session.error ? 'is-unsaved' : session.dirty ? 'is-unsaved' : session.record ? 'is-saved' : '';
  return <article className="study-card">
    <div className="study-card-top"><Tag>{questionLabels[task.kind]}</Tag><span className={`save-status ${saveState}`} role="status">{session.conflict ? '等待处理冲突' : session.saving ? '正在保存…' : session.error ? '尚未保存' : session.dirty ? '输入已保留在本机，待保存' : session.record ? '已保存' : '开始作答后自动保存'}</span></div>
    <h2 className="term-title">{task.item.term || task.item.title}</h2>
    <div className="source-line">来源：{sourceLabel(task.item.source)}</div>
    {task.stage === 'learn' ? <ItemContent item={task.item} /> : <ItemFlags item={task.item} />}
    <section className="answer-prompt"><h3>{submitted ? '作答题目' : task.stage === 'learn' ? '用自己的英语解释' : '先独立回答'}</h3><p>{session.record?.prompt ?? task.prompt}</p></section>
    {session.conflict && <div className="conflict-panel" role="alert"><h3>另一处已经保存了新版本</h3><p>你的输入仍保留在下方。请明确选择要继续使用的内容。</p><details><summary>查看另一处保存的回答</summary><p className="answer-text">{session.conflict.originalAnswer || '空白草稿'}</p><p className="muted">保存版本 {session.conflict.revision} · {session.conflict.status === 'draft' ? '草稿' : '已提交'}</p></details><div className="button-row"><button className="button button-secondary" onClick={session.acceptRemote}>使用另一处保存的版本</button>{session.conflict.status === 'draft' && <button className="button" onClick={() => { void session.retryLocal(); }}>保留我的回答并重新保存</button>}</div>{session.conflict.status !== 'draft' && <p className="muted">这份回答已提交；接受已保存版本后，可以去作答档案填写修订。当前输入可先手动复制。</p>}</div>}
    {(!submitted || session.conflict) ? <div className="answer-input-wrap"><label htmlFor={`answer-${sessionKey}`}>英文回答</label><textarea id={`answer-${sessionKey}`} lang="en" className="answer-input" value={session.text} onChange={event => session.setText(event.target.value)} disabled={session.submitting || (submitted && !session.conflict)} placeholder={task.stage === 'learn' ? 'Explain the meaning in your own words…' : 'Write your answer here…'} rows={7} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void session.submit(); } }} /><div className="input-hint"><span>回答会自动保存为草稿</span><span>⌘ / Ctrl + Enter 提交</span></div></div> : <section className="submitted-answer"><h4>我的原始回答</h4><p className="answer-text">{session.record?.originalAnswer}</p></section>}
    <ErrorNotice error={session.conflict ? '' : session.error} retry={!submitted ? () => { void session.retry(); } : undefined} />
    {!submitted && <div className="card-actions"><p className="muted">提交后查看参考，再如实评估掌握程度。</p><button className="button button-primary" disabled={!session.text.trim() || session.submitting || !!session.conflict} onClick={() => { void session.submit(); }}>{session.submitting ? '正在提交…' : '提交回答'}</button></div>}
    {submitted && !session.conflict && <><section className="reference-panel"><div className="section-label">笔记参考</div>{session.record!.reference.length > 0 ? session.record!.reference.map((line, index) => <p key={index}>{line}</p>) : <p>原笔记暂无更多参考，请补充来源资料后再练习。</p>}</section><section className="rating-section"><h3>{session.record?.rating ? `本次自评：${ratingLabel(session.record.rating)}` : '这次掌握得怎样？'}</h3><p className="muted">{task.stage === 'practice' ? '应用题自评记录本次表现；复习间隔由学习与复习决定。' : '按实际回忆情况选择，系统会安排下一次复习。'}</p><div className="rating-grid">{ratings.map(rating => <button key={rating.value} className={`rating-button rating-${rating.value} ${session.record?.rating === rating.value ? 'is-selected' : ''}`} disabled={session.rating || !!session.record?.rating} onClick={() => { void session.rate(rating.value); }}><strong>{rating.label}</strong><span>{rating.description}</span></button>)}</div>{session.rating && <p role="status" className="muted">正在保存自评…</p>}</section></>}
    {complete && <div className="completion-row"><span className="completion-mark">✓ 本次作答已完成</span><button className="button button-secondary" onClick={onNext}>继续下一项 →</button></div>}
  </article>;
}
