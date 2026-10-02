import { useState } from 'react';
import type { AnswerRecord } from '../../shared/types';
import { message, query, request } from '../api';
import { ArchiveAnswer } from '../components/ArchiveAnswer';
import { EmptyState, ErrorNotice, Loading, PageHeading, Tag } from '../components/Common';
import { PrintReport } from '../components/PrintReport';
import { useResource } from '../hooks/useResource';
import { answerStatus, copyText, ratingLabel, stageLabels } from '../lib';

export function ArchivePage() {
  const [date, setDate] = useState('');
  const records = useResource(() => request<AnswerRecord[]>(`/api/answers${query({ date })}`), [date]);
  const [selectedId, setSelectedId] = useState('');
  const [evaluation, setEvaluation] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const selected = records.data?.find(answer => answer.id === selectedId) ?? records.data?.[0];
  const copyEvaluation = async () => {
    if (copyBusy) return;
    setCopyBusy(true); setCopyError(''); setCopySuccess(false);
    try {
      const result = await request<{ text: string }>(`/api/evaluation${query({ date })}`);
      setEvaluation(result.text);
      await copyText(result.text);
      setCopySuccess(true);
    } catch (cause) { setCopyError(message(cause)); }
    finally { setCopyBusy(false); }
  };
  const saved = (answer: AnswerRecord) => records.setData(current => (current ?? []).map(record => record.id === answer.id ? answer : record));
  return <>
    <PageHeading eyebrow="落笔有迹 · ARCHIVE" title="作答档案">保存原始回答、笔记参考、修订和反馈，看见表达的进步。</PageHeading>
    <div className="archive-tools panel"><div className="archive-tools-main"><label><span>作答日期</span><input type="date" value={date} onChange={event => { setDate(event.target.value); setEvaluation(''); setCopySuccess(false); setCopyError(''); setSelectedId(''); }} /></label>{date && <button className="text-button" onClick={() => setDate('')}>查看全部日期</button>}<button className="button button-primary" disabled={copyBusy || !records.data?.length} onClick={() => { void copyEvaluation(); }}>{copyBusy ? '正在准备…' : copySuccess ? '✓ 已复制评阅包' : '一键复制评阅包'}</button></div><div className="export-actions"><span className="muted">导出</span>{(['markdown', 'csv', 'json'] as const).map(format => <a className="button button-secondary" key={format} href={`/api/export${query({ format, date })}`} download>{format === 'markdown' ? 'Markdown' : format === 'csv' ? 'CSV' : 'JSON 备份'}</a>)}<button className="button button-secondary" disabled={!records.data?.length || records.loading} onClick={() => window.print()}>打印 / 保存 PDF</button></div><p className="muted">Markdown、CSV 和打印按所选日期输出已保存档案；JSON 导出完整备份。</p>
      <ErrorNotice error={copyError} retry={() => { void copyEvaluation(); }} />{evaluation && <details className="evaluation-preview"><summary>{copySuccess ? '查看已复制的评阅包' : '查看评阅包并手动复制'}</summary><textarea aria-label="评阅包" value={evaluation} readOnly rows={10} onFocus={event => event.target.select()} /><p className="muted">将评阅包粘贴到你选择的模型窗口，评阅后把反馈保存到对应作答。</p></details>}</div>
    <ErrorNotice error={records.error} retry={() => { void records.reload(); }} />{records.loading ? <Loading text="正在读取作答档案…" /> : records.data?.length ? <div className="archive-layout"><aside className="panel archive-list"><div className="section-heading"><h3>已保存作答</h3><Tag>{records.data.length} 份</Tag></div>{records.data.map(answer => <button key={answer.id} className={`archive-list-item ${selected?.id === answer.id ? 'is-active' : ''}`} onClick={() => setSelectedId(answer.id)}><span className="archive-list-meta">{answer.date} · {stageLabels[answer.stage]}</span><strong>{answer.prompt}</strong><span className="tags"><Tag>{answer.rating ? ratingLabel(answer.rating) : answerStatus(answer.status)}</Tag>{answer.revisedAnswer && <Tag>有修订</Tag>}{answer.feedback && <Tag>有反馈</Tag>}</span></button>)}</aside><section className="panel archive-detail">{selected && <ArchiveAnswer key={selected.id} answer={selected} onSaved={saved} />}</section></div> : !records.error && <EmptyState title="这里会留下你的每次练习"><p>{date ? '这一天还没有保存的作答，可以切换日期。' : '完成今日作答后，在这里保存修订与评阅反馈。'}</p></EmptyState>}
    <PrintReport records={records.data ?? []} date={date} />
  </>;
}
