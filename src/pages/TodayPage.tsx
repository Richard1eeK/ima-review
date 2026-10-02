import { useEffect, useState } from 'react';
import type { AnswerRecord, DailyPlan, Question, StudyItem, StudyStage } from '../../shared/types';
import { message, query, request } from '../api';
import { AnswerEditor, type AnswerTask } from '../components/AnswerEditor';
import { EmptyState, ErrorNotice, Loading, PageHeading, Tag } from '../components/Common';
import { useResource } from '../hooks/useResource';
import { answerStatus, questionLabels, ratingLabel, stageLabels } from '../lib';

const stages: StudyStage[] = ['learn', 'review', 'practice'];
const stageNumerals = ['一', '二', '三'];
function taskForItem(item: StudyItem, stage: 'learn' | 'review'): AnswerTask {
  return { item, stage, kind: 'explain', prompt: `用英语解释「${item.term || item.title}」的含义和用法，尽量使用自己的表达。` };
}
function taskForQuestion(question: Question): AnswerTask {
  return { item: question.item, stage: 'practice', kind: question.kind, questionId: question.id, prompt: question.prompt };
}
function tasks(plan: DailyPlan, stage: StudyStage): AnswerTask[] {
  return stage === 'practice' ? plan.practice.map(taskForQuestion) : plan[stage].map(item => taskForItem(item, stage));
}
function findAnswer(records: AnswerRecord[], task: AnswerTask): AnswerRecord | undefined {
  return records.filter(record => record.stage === task.stage && record.itemId === task.item.id && (task.stage !== 'practice' || record.questionId === task.questionId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function TodayPage({ onProgress, openSettings, openSync, practiceFocus, onFocusHandled }: {
  onProgress: () => void; openSettings: () => void; openSync: () => void;
  practiceFocus?: Question | null; onFocusHandled: () => void;
}) {
  const plan = useResource(() => request<DailyPlan>('/api/plan'));
  const answers = useResource(() => plan.data ? request<AnswerRecord[]>(`/api/answers${query({ date: plan.data.date })}`) : Promise.resolve([]), [plan.data?.date]);
  const [activeStage, setActiveStage] = useState<StudyStage>('learn');
  const [selected, setSelected] = useState<AnswerTask | null>(null);
  const [opening, setOpening] = useState('');
  const [openError, setOpenError] = useState('');
  useEffect(() => {
    if (!practiceFocus) return;
    setActiveStage('practice'); setSelected(taskForQuestion(practiceFocus)); onFocusHandled();
  }, [practiceFocus?.id]);
  useEffect(() => {
    if (!plan.data || selected) return;
    const available = tasks(plan.data, activeStage)[0];
    if (available) setSelected(available);
  }, [plan.data, activeStage, selected]);

  const chooseStage = (stage: StudyStage) => {
    setActiveStage(stage);
    setSelected(plan.data ? tasks(plan.data, stage)[0] ?? null : null);
  };
  const recordChanged = (record: AnswerRecord) => {
    answers.setData(current => [record, ...(current ?? []).filter(existing => existing.id !== record.id)]);
  };
  const refreshProgress = () => { void plan.reload(); onProgress(); };
  const next = () => {
    if (!plan.data) return;
    const remaining = tasks(plan.data, activeStage).filter(task => task.questionId ? task.questionId !== selected?.questionId : task.item.id !== selected?.item.id);
    if (remaining[0]) { setSelected(remaining[0]); return; }
    const stageIndex = stages.indexOf(activeStage);
    const nextStage = stages.slice(stageIndex + 1).find(stage => tasks(plan.data!, stage).length > 0);
    if (nextStage) chooseStage(nextStage);
    else setSelected(null);
  };
  const openAnswer = async (answer: AnswerRecord) => {
    setOpening(answer.id);
    setOpenError('');
    try {
      const item = await request<StudyItem>(`/api/items/${encodeURIComponent(answer.itemId)}`);
      setActiveStage(answer.stage);
      setSelected({ item, stage: answer.stage, kind: answer.questionKind, prompt: answer.prompt,
        ...(answer.stage === 'practice' ? { questionId: answer.questionId } : {}) });
    } catch (cause) { setOpenError(message(cause)); }
    finally { setOpening(''); }
  };
  const daily = plan.data;
  const available = daily ? tasks(daily, activeStage) : [];
  const records = answers.data ?? [];
  const completed = records.filter(record => record.status !== 'draft');
  return <>
    <PageHeading eyebrow="温故知新 · TODAY" title="今日学习" actions={<button className="button button-secondary" onClick={openSettings}>调整每日目标</button>}>
      {daily ? `${daily.date} · ${daily.timezone} · 建议 ${daily.studyTime} 开始` : '从笔记出发，让表达成为自己的。'}
    </PageHeading>
    <ErrorNotice error={plan.error} retry={() => { void plan.reload(); }} />
    {plan.loading && !daily && <Loading text="正在读取今日计划…" />}
    {daily && <><div className="daily-summary"><div><span>新学完成</span><strong>{daily.counts.learned}<small> / {daily.limits.newLimit}</small></strong></div><div><span>复习完成</span><strong>{daily.counts.reviewed}<small> / {daily.limits.reviewLimit}</small></strong></div><div><span>应用题完成</span><strong>{daily.counts.practiced}<small> / {daily.limits.practiceLimit}</small></strong></div><div className="daily-context"><span>待复习 {daily.counts.dueTotal} 项</span><span>待新学 {daily.counts.remainingNew} 项</span></div></div>
      <div className="stage-tabs" role="tablist" aria-label="今日学习阶段">{stages.map((stage, index) => <button key={stage} role="tab" aria-selected={activeStage === stage} className={activeStage === stage ? 'is-active' : ''} onClick={() => chooseStage(stage)}><span className="step-number">{stageNumerals[index]}</span><strong>{stageLabels[stage]}</strong><span className="stage-count">{tasks(daily, stage).length} 待完成</span></button>)}</div>
      <div className="study-layout"><aside className="study-queue"><div className="section-heading"><h3>{stageLabels[activeStage]}清单</h3>{plan.loading && <span className="muted">更新中…</span>}</div>{available.length > 0 ? <div className="queue-list">{available.map((task, index) => {
        const current = selected?.stage === task.stage && (task.questionId ? selected.questionId === task.questionId : selected.item.id === task.item.id);
        const answer = findAnswer(records, task);
        return <button className={`queue-item ${current ? 'is-active' : ''}`} key={task.questionId ?? task.item.id} onClick={() => setSelected(task)}><span className="queue-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{task.item.term || task.item.title}</strong><small>{answer ? answerStatus(answer.status) : task.stage === 'practice' ? questionLabels[task.kind] : task.item.source.folderName}</small></span></button>;
      })}</div> : <div className="queue-empty"><p>{activeStage === 'practice' ? '应用题来自今天实际学完或复习过的词条。' : '这一阶段暂无待完成项。'}</p>{activeStage === 'practice' && <button className="text-button" onClick={() => chooseStage('learn')}>去新学 →</button>}</div>}
      <div className="queue-note">先独立回答，再对照笔记，最后如实自评。</div></aside>
      <div className="study-main"><ErrorNotice error={answers.error} retry={() => { void answers.reload(); }} /><ErrorNotice error={openError} />{answers.loading ? <Loading text="正在恢复今日草稿…" /> : selected && !answers.error ? <AnswerEditor key={`${daily.date}:${selected.stage}:${selected.questionId ?? selected.item.id}`} task={selected} date={daily.date} initial={findAnswer(records, selected)} onRecord={recordChanged} onCompleted={refreshProgress} onNext={next} /> : !answers.error && <EmptyState title={activeStage === 'practice' ? '先学会，再练表达' : '这一阶段暂时清空了'} action={<button className="button button-secondary" onClick={openSync}>查看笔记同步</button>}><p>{activeStage === 'practice' ? '完成今天的新学或复习后，应用题会从这些词条中生成。' : '可以切换到下一阶段，或同步新的笔记资料。'}</p></EmptyState>}</div></div>
      {completed.length > 0 && <section className="panel today-records"><div className="section-heading"><h3>今日已提交的回答</h3><Tag>{completed.length} 份</Tag></div><p className="muted">可重新查看参考和自评。每个词条的进度以页面上方已保存的完成记录为准。</p><div className="today-record-list">{completed.map(record => <button key={record.id} className="today-record" disabled={!!opening} onClick={() => { void openAnswer(record); }}><span><strong>{record.prompt}</strong><small>{stageLabels[record.stage]} · {record.source.noteTitle}</small></span><span className="tag">{opening === record.id ? '读取中…' : record.rating ? ratingLabel(record.rating) : '查看 / 自评'}</span></button>)}</div></section>}
    </>}
  </>;
}
