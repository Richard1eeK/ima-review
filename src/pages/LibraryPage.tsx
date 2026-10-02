import { useEffect, useRef, useState } from 'react';
import type { AnswerRecord, Question, StudyItem } from '../../shared/types';
import { message, query, request, write } from '../api';
import { EmptyState, ErrorNotice, Loading, PageHeading, Tag } from '../components/Common';
import { ItemContent, ItemFlags } from '../components/ItemContent';
import { useResource } from '../hooks/useResource';
import { answerStatus, dateTime, ratingLabel, stageLabels } from '../lib';

export function LibraryPage({ onProgress, onPractice }: { onProgress: () => void; onPractice: (question: Question) => void }) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState('active');
  const [weak, setWeak] = useState(false);
  const [selected, setSelected] = useState<StudyItem | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmLatest, setConfirmLatest] = useState(false);
  const [notice, setNotice] = useState('');
  const actionLock = useRef(false);
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search), 300); return () => clearTimeout(timer); }, [search]);
  const items = useResource(() => request<StudyItem[]>(`/api/items${query({ q: debouncedSearch, tag, status, weak })}`), [debouncedSearch, tag, status, weak]);
  const allTags = useResource(() => request<StudyItem[]>('/api/items?status=all'));
  const history = useResource(() => selected ? request<AnswerRecord[]>(`/api/answers${query({ itemId: selected.id })}`) : Promise.resolve([]), [selected?.id]);
  const tags = Array.from(new Set((allTags.data ?? []).flatMap(item => item.tags))).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const modify = async (patch: { status?: 'active' | 'archived'; useLatest?: true }) => {
    if (!selected || actionLock.current) return;
    actionLock.current = true;
    setBusy(true); setActionError(''); setNotice('');
    try {
      const result = await write<StudyItem>(`/api/items/${encodeURIComponent(selected.id)}`, 'PATCH', patch);
      setSelected(result); setConfirmLatest(false);
      setNotice(patch.useLatest ? '已确认使用更新后的资料，词条将重新进入学习安排。' : result.status === 'archived' ? '已归档，历史作答仍保留。' : '已恢复到词库。');
      await items.reload(); onProgress();
    } catch (cause) { setActionError(message(cause)); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const practice = async () => {
    if (!selected || actionLock.current) return;
    actionLock.current = true; setBusy(true); setActionError(''); setNotice('');
    try { onPractice(await write<Question>('/api/practice', 'POST', { itemId: selected.id })); }
    catch (cause) { setActionError(message(cause)); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const choose = (item: StudyItem) => { setSelected(item); setActionError(''); setNotice(''); setConfirmLatest(false); };
  return <>
    <PageHeading eyebrow="字句之间 · LIBRARY" title="我的词库">每一项都能找到它的笔记来源，辨析词组按一项安排学习。</PageHeading>
    <div className="filter-bar"><label className="search-field"><span>搜索词条</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="英文、中文或笔记内容" /></label><label><span>标签</span><select value={tag} onChange={event => setTag(event.target.value)}><option value="">全部标签</option>{tags.map(value => <option key={value}>{value}</option>)}</select></label><label><span>状态</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="active">使用中</option><option value="archived">已归档</option><option value="pending">待核对</option><option value="all">全部</option></select></label><label className="checkbox-label"><input type="checkbox" checked={weak} onChange={event => setWeak(event.target.checked)} /><span>只看薄弱项</span></label></div>
    <ErrorNotice error={items.error} retry={() => { void items.reload(); }} />
    <div className="library-layout"><section className="panel item-list"><div className="section-heading"><h3>词条</h3><span className="muted">{items.loading ? '读取中…' : `${items.data?.length ?? 0} 项`}</span></div>{items.loading && !items.data ? <Loading /> : items.data?.length ? items.data.map(item => <button key={item.id} className={`library-item ${selected?.id === item.id ? 'is-active' : ''}`} onClick={() => choose(item)}><span className="library-item-title">{item.term || item.title}</span>{item.chinese && <span className="muted">{item.chinese}</span>}<small>{item.source.folderName} / {item.source.noteTitle}</small><ItemFlags item={item} /><div className="tags">{item.tags.slice(0, 3).map(value => <Tag key={value}>{value}</Tag>)}{item.lastRating === 'again' || item.lastRating === 'hard' ? <Tag tone="amber">薄弱</Tag> : null}</div></button>) : <EmptyState title="暂无匹配词条"><p>调整筛选条件，或到同步页导入笔记。</p></EmptyState>}</section>
    <section className="panel item-detail">{selected ? <><div className="item-detail-heading"><div><span className="eyebrow">词条详情</span><h2 className="term-title">{selected.term || selected.title}</h2></div><div className="button-row"><button className="button button-primary" disabled={busy || !selected.learnedAt || selected.status !== 'active' || selected.needsRelearn} onClick={() => { void practice(); }}>重练此项</button><button className="button button-secondary" disabled={busy} onClick={() => { void modify({ status: selected.status === 'archived' ? 'active' : 'archived' }); }}>{busy ? '保存中…' : selected.status === 'archived' ? '恢复词条' : '归档词条'}</button></div></div>
      {!selected.learnedAt && <p className="muted">完成新学后，可以主动重练这一项。</p>}
      {selected.status === 'pending' && <div className="notice notice-warn"><p>这条资料在同步时出现了匹配歧义，暂不进入每日计划。请核对原笔记的标题与内容，调整后重新同步。</p></div>}
      {selected.needsRelearn && <div className="notice notice-warn"><div><strong>笔记资料有更新</strong><p>核对下方最新内容后，确认将它重新纳入学习。</p>{confirmLatest ? <><p>确认使用最新资料重新学习？已有作答历史会保留。</p><div className="button-row"><button className="button button-primary" disabled={busy} onClick={() => { void modify({ useLatest: true }); }}>确认重新学习</button><button className="button button-secondary" disabled={busy} onClick={() => setConfirmLatest(false)}>取消</button></div></> : <button className="button button-secondary" onClick={() => setConfirmLatest(true)}>查看后重新学习</button>}</div></div>}
      <ErrorNotice error={actionError} />{notice && <p className="notice notice-success" role="status">{notice}</p>}<ItemContent item={selected} />
      <dl className="item-meta"><div><dt>上次自评</dt><dd>{ratingLabel(selected.lastRating)}</dd></div><div><dt>下次复习</dt><dd>{selected.dueAt ? dateTime(selected.dueAt) : '学习后安排'}</dd></div><div><dt>资料版本</dt><dd>{selected.version}</dd></div></dl>
      <section className="history-section"><h3>历史作答</h3><ErrorNotice error={history.error} retry={() => { void history.reload(); }} />{history.loading ? <Loading /> : history.data?.length ? history.data.map(answer => <details className="history-answer" key={answer.id}><summary><span>{answer.date} · {stageLabels[answer.stage]}</span><Tag>{answer.rating ? ratingLabel(answer.rating) : answerStatus(answer.status)}</Tag></summary><p className="muted">{answer.prompt}</p><h4>原始回答</h4><p className="answer-text">{answer.originalAnswer || '空白草稿'}</p>{answer.revisedAnswer && <><h4>修订回答</h4><p className="answer-text">{answer.revisedAnswer}</p></>}{answer.feedback && <><h4>评阅反馈</h4><p className="answer-text">{answer.feedback}</p></>}{answer.status !== 'draft' && <><h4>当时的笔记参考</h4>{answer.reference.map((line, index) => <p key={index}>{line}</p>)}</>}</details>) : <p className="muted">这项还没有历史作答。</p>}</section>
    </> : <EmptyState title="翻开一个词条"><p>在左侧选择词条，查看笔记原文、用法与历史回答。</p></EmptyState>}</section></div>
  </>;
}
