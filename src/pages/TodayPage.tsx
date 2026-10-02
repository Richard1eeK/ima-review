import { useEffect, useState } from 'react';
import type { AnswerRecord, DailyPlan, DailyResetResult, Question, StudyItem, StudyStage } from '../../shared/types';
import { message, query, request, write } from '../api';
import { AnswerEditor, type AnswerTask } from '../components/AnswerEditor';
import { EmptyState, ErrorNotice, Loading, PageHeading, Tag } from '../components/Common';
import { ItemContent } from '../components/ItemContent';
import { useResource } from '../hooks/useResource';
import { answerStatus, questionLabels, ratingLabel, stageLabels } from '../lib';

const stages: StudyStage[] = ['learn', 'review', 'practice'];
const stageNumerals = ['一', '二', '三'];
function taskForItem(item: StudyItem, stage: 'learn' | 'review'): AnswerTask {
  return { item, stage, kind: 'explain', prompt: stage === 'review' ? `用英语解释「${item.term || item.title}」的含义和用法，尽量使用自己的表达。` : '' };
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

function LearnCard({ task, busy, error, onComplete }: { task: AnswerTask; busy: boolean; error: string; onComplete: () => Promise<void> }) {
  return <article className="study-card learn-card">
    <div className="study-card-top"><Tag>阅读与理解</Tag><span className="save-status">看完后确认进入复习</span></div>
    <h2 className="term-title">{task.item.term || task.item.title}</h2>
    <ItemContent item={task.item} />
    <section className="answer-prompt"><h3>这一项先学什么</h3><p>先阅读笔记中的释义、例句和使用提醒。复习阶段会再要求你用英语主动回忆，不在新学阶段重复作答。</p></section>
    <ErrorNotice error={error} />
    <div className="card-actions"><p className="muted">确认理解后，这个词条会进入今天的复习队列。</p><button className="button button-primary" disabled={busy} onClick={() => { void onComplete(); }}>{busy ? '正在记录…' : '完成新学，进入复习'}</button></div>
  </article>;
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
  const [learning, setLearning] = useState('');
  const [learningError, setLearningError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState('');
  const [resetResult, setResetResult] = useState<DailyResetResult | null>(null);
  useEffect(() => {
    if (!plan.data || plan.data.generation === 0) return;
    const prefix = `wengu:draft:${plan.data.date}:`;
    const current = `${prefix}g${plan.data.generation}:`;
    // Unmounting an answer session also saves its local draft. This effect
    // runs after that cleanup and removes caches from previous reset versions.
    try {
      Object.keys(localStorage).filter(key => key.startsWith(prefix) && !key.startsWith(current)).forEach(key => localStorage.removeItem(key));
    } catch { /* Reset generations also isolate caches when storage is blocked. */ }
  }, [plan.data?.date, plan.data?.generation]);
  useEffect(() => {
    if (!plan.data || !answers.data || answers.loading || answers.error) return;
    const prefix = `wengu:draft:${plan.data.date}:`;
    const savedIds = new Set(answers.data.map(answer => answer.id));
    try {
      for (const key of Object.keys(localStorage).filter(key => key.startsWith(prefix))) {
        const cache = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (cache && cache.revision > 0 && cache.dirty === false && !savedIds.has(cache.id)) localStorage.removeItem(key);
      }
    } catch { /* Never discard unsaved input when local storage is unavailable. */ }
  }, [plan.data?.date, answers.data, answers.loading, answers.error]);
  useEffect(() => {
    if (!practiceFocus) return;
    setActiveStage('practice'); setSelected(taskForQuestion(practiceFocus)); onFocusHandled();
  }, [practiceFocus?.id]);
  useEffect(() => {
    if (!plan.data || selected || resetting) return;
    const available = tasks(plan.data, activeStage)[0];
    if (available) setSelected(available);
  }, [plan.data, activeStage, selected, resetting]);

  const chooseStage = (stage: StudyStage) => {
    setActiveStage(stage);
    setSelected(plan.data ? tasks(plan.data, stage)[0] ?? null : null);
  };
  const recordChanged = (record: AnswerRecord) => {
    answers.setData(current => [record, ...(current ?? []).filter(existing => existing.id !== record.id)]);
  };
  const refreshProgress = () => { void plan.reload(); onProgress(); };
  const resetToday = async () => {
    if (!plan.data || resetting) return;
    setResetting(true); setResetError(''); setSelected(null);
    try {
      const result = await write<DailyResetResult>('/api/plan/reset', 'POST', { date: plan.data.date, generation: plan.data.generation, confirm: true });
      answers.setData([]); plan.setData(result.plan); setActiveStage('learn');
      setSelected(result.plan.learn[0] ? taskForItem(result.plan.learn[0], 'learn') : null);
      setResetResult(result); setConfirmReset(false); setLearningError(''); onProgress();
      await Promise.all([plan.reload(), answers.reload()]);
    } catch (cause) { setResetError(message(cause)); await plan.reload(); }
    finally { setResetting(false); }
  };
  const completeLearning = async (itemId: string) => {
    setLearning(itemId); setLearningError('');
    try {
      const result = await write<{ item: StudyItem; plan: DailyPlan }>('/api/learning', 'POST', { itemId, planGeneration: plan.data?.generation });
      onProgress();
      plan.setData(result.plan);
      const refreshed = result.plan;
      const nextTask = refreshed?.learn[0];
      setSelected(nextTask ? taskForItem(nextTask, 'learn') : null);
    } catch (cause) { setLearningError(message(cause)); }
    finally { setLearning(''); }
  };
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
    <PageHeading eyebrow="温故知新 · TODAY" title="今日学习" actions={<><button className="button button-secondary" onClick={openSettings}>调整每日目标</button><button className="button button-secondary" disabled={!daily || resetting || !!learning} onClick={() => { setConfirmReset(true); setResetError(''); }}>重置今日学习</button></>}>
      {daily ? `${daily.date} · ${daily.timezone} · 建议 ${daily.studyTime} 开始` : '从笔记出发，让表达成为自己的。'}
    </PageHeading>
    <ErrorNotice error={plan.error} retry={() => { void plan.reload(); }} />
    <ErrorNotice error={resetError} />
    {confirmReset && <section className="panel" role="region" aria-label="确认重置今日学习"><h2>重新开始今天的学习？</h2><p>清空今天新建的回答和完成进度，撤销今天的复习评分，并重新随机抽取词条。以前的历史和跨日草稿会保留。</p><p className="muted">操作前自动保存备份。需要恢复时，可下载备份并在学习设置中导入。</p><div className="button-row"><button className="button button-primary" disabled={resetting} onClick={() => { void resetToday(); }}>{resetting ? '正在备份并重置…' : '确认重置今天'}</button><button className="button button-secondary" disabled={resetting} onClick={() => setConfirmReset(false)}>取消</button></div></section>}
    {resetResult && <section className="notice" role="status"><div><strong>今日学习已重置</strong><p>已重新抽取词条；重置前的资料已备份。</p><div className="button-row"><a className="button button-secondary" href={`/api/resets/${resetResult.recoveryId}`}>下载重置前备份</a><button className="button button-secondary" onClick={openSettings}>到设置恢复备份</button></div></div></section>}
    {plan.loading && !daily && <Loading text="正在读取今日计划…" />}
    {daily && <><div className="daily-summary"><div><span>新学完成</span><strong>{daily.counts.learned}<small> / {daily.limits.newLimit}</small></strong></div><div><span>复习完成</span><strong>{daily.counts.reviewed}<small> / {daily.limits.reviewLimit}</small></strong></div><div><span>应用题完成</span><strong>{daily.counts.practiced}<small> / {daily.limits.practiceLimit}</small></strong></div><div className="daily-context"><span>待复习 {daily.counts.dueTotal} 项</span><span>待新学 {daily.counts.remainingNew} 项</span></div></div>
      <div className="stage-tabs" role="tablist" aria-label="今日学习阶段">{stages.map((stage, index) => <button key={stage} role="tab" aria-selected={activeStage === stage} className={activeStage === stage ? 'is-active' : ''} onClick={() => chooseStage(stage)}><span className="step-number">{stageNumerals[index]}</span><strong>{stageLabels[stage]}</strong><span className="stage-count">{tasks(daily, stage).length} 待完成</span></button>)}</div>
      <div className="study-layout"><aside className="study-queue"><div className="section-heading"><h3>{stageLabels[activeStage]}清单</h3>{plan.loading && <span className="muted">更新中…</span>}</div>{available.length > 0 ? <div className="queue-list">{available.map((task, index) => {
        const current = selected?.stage === task.stage && (task.questionId ? selected.questionId === task.questionId : selected.item.id === task.item.id);
        const answer = findAnswer(records, task);
        return <button className={`queue-item ${current ? 'is-active' : ''}`} key={task.questionId ?? task.item.id} onClick={() => setSelected(task)}><span className="queue-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{task.item.term || task.item.title}</strong><small>{answer ? answerStatus(answer.status) : task.stage === 'practice' ? questionLabels[task.kind] : task.item.source.folderName}</small></span></button>;
      })}</div> : <div className="queue-empty"><p>{activeStage === 'practice' ? '应用题来自今天实际学完或复习过的词条。' : '这一阶段暂无待完成项。'}</p>{activeStage === 'practice' && <button className="text-button" onClick={() => chooseStage('learn')}>去新学 →</button>}</div>}
      <div className="queue-note">{activeStage === 'learn' ? '先阅读笔记，确认理解；复习阶段再主动回忆。' : activeStage === 'review' ? '先独立回忆，再对照笔记，最后如实自评。' : '完成应用练习后保存回答，记录本次表现。'}</div></aside>
      <div className="study-main"><ErrorNotice error={answers.error} retry={() => { void answers.reload(); }} /><ErrorNotice error={openError} />{resetting ? <Loading text="正在备份并重置今日学习…" /> : answers.loading ? <Loading text="正在恢复今日草稿…" /> : selected && !answers.error ? (() => { const existing = findAnswer(records, selected); return selected.stage === 'learn' && !existing ? <LearnCard key={`${daily.date}:${daily.generation}:learn:${selected.item.id}`} task={selected} busy={learning === selected.item.id} error={learningError} onComplete={() => completeLearning(selected.item.id)} /> : <AnswerEditor key={`${daily.date}:${daily.generation}:${selected.stage}:${selected.questionId ?? selected.item.id}`} task={selected} date={daily.date} generation={daily.generation} initial={existing} onRecord={recordChanged} onCompleted={refreshProgress} onNext={next} />; })() : !answers.error && <EmptyState title={activeStage === 'practice' ? '先学会，再练表达' : '这一阶段暂时清空了'} action={<button className="button button-secondary" onClick={openSync}>查看笔记同步</button>}><p>{activeStage === 'practice' ? '完成今天的新学或复习后，应用题会从这些词条中生成。' : '可以切换到下一阶段，或同步新的笔记资料。'}</p></EmptyState>}</div></div>
      {completed.length > 0 && <section className="panel today-records"><div className="section-heading"><h3>今日已提交的回答</h3><Tag>{completed.length} 份</Tag></div><p className="muted">可重新查看参考和自评。每个词条的进度以页面上方已保存的完成记录为准。</p><div className="today-record-list">{completed.map(record => <button key={record.id} className="today-record" disabled={!!opening} onClick={() => { void openAnswer(record); }}><span><strong>{record.prompt}</strong><small>{stageLabels[record.stage]} · {record.source.noteTitle}</small></span><span className="tag">{opening === record.id ? '读取中…' : record.rating ? ratingLabel(record.rating) : '查看 / 自评'}</span></button>)}</div></section>}
    </>}
  </>;
}
