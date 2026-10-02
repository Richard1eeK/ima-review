import { useEffect, useRef, useState } from 'react';
import type { Settings, SyncStatus } from '../../shared/types';
import { message, request, write } from '../api';
import { ErrorNotice, Loading, PageHeading, Tag } from '../components/Common';
import { useResource } from '../hooks/useResource';
import { dateTime } from '../lib';

export function SyncPage({ settings, onSynced, openSettings }: { settings?: Settings; onSynced: () => void; openSettings: () => void }) {
  const status = useResource(() => request<SyncStatus>('/api/sync'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  useEffect(() => {
    if (!status.data?.running) return;
    const timer = setTimeout(() => { void status.reload(); }, 2500);
    return () => clearTimeout(timer);
  }, [status.data, status.reload]);
  const sync = async () => {
    if (lock.current || status.data?.running) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await write<SyncStatus>('/api/sync', 'POST');
      status.setData(result);
      if (result.error) setError(result.error);
      else if (result.lastSuccessAt) onSynced();
    } catch (cause) { setError(message(cause)); await status.reload(); }
    finally { lock.current = false; setBusy(false); }
  };
  const current = status.data;
  return <>
    <PageHeading eyebrow="笔记为源 · SYNC" title="同步笔记" actions={<button className="button button-primary" disabled={busy || current?.running || status.loading} onClick={() => { void sync(); }}>{busy || current?.running ? '同步进行中…' : '立即同步'}</button>}>把选定笔记本中的英语资料纳入复习，原笔记仍是学习依据。</PageHeading>
    <ErrorNotice error={status.error} retry={() => { void status.reload(); }} />
    <ErrorNotice error={error || current?.error || ''} retry={() => { void sync(); }} />
    {status.loading && !current ? <Loading /> : current && <section className="panel sync-overview"><div className="section-heading"><h2>{current.running || busy ? '正在读取笔记' : current.error ? '上次同步未完成' : current.lastSuccessAt ? '笔记已同步' : '等待首次同步'}</h2><Tag tone={current.error ? 'amber' : 'green'}>{current.running || busy ? '进行中' : current.error ? '需重试' : current.lastSuccessAt ? '可学习' : '待同步'}</Tag></div><dl className="sync-times"><div><dt>上次成功同步</dt><dd>{dateTime(current.lastSuccessAt, settings?.timezone)}</dd></div><div><dt>最近尝试</dt><dd>{dateTime(current.lastAttemptAt, settings?.timezone)}</dd></div></dl>{current.counts && <div className="sync-counts">{([{ key: 'added', title: '新增词条' }, { key: 'modified', title: '资料更新' }, { key: 'archived', title: '归档词条' }, { key: 'pending', title: '待核对' }, { key: 'unchanged', title: '内容未变' }] as const).map(count => <div key={count.key}><strong>{current.counts![count.key]}</strong><span>{count.title}</span></div>)}</div>}{current.error && <p className="notice-inline">同步失败时，已保存的词库和作答继续保留。修正连接问题后可再次同步。</p>}</section>}
    <div className="sync-info-grid"><section className="panel"><span className="eyebrow">同步安排</span><h3>启动、每日与手动</h3><p>服务启动时检查同步，之后按设定时间每日检查，也可点击「立即同步」。</p><p className="muted">每日同步时间：{settings?.syncTime ?? '读取中…'}<br />时区：{settings?.timezone ?? '读取中…'}</p><p className="muted">ima 笔记修改后不会立即推送到这里；下一次检查时才会读取。</p></section><section className="panel"><span className="eyebrow">资料范围</span><h3>只读取选定笔记本</h3><p>{settings ? settings.folderIds.length ? `目前选择了 ${settings.folderIds.length} 个笔记本。` : '尚未选择笔记本。请先在设置中选择英语资料所在的笔记本。' : '正在读取资料范围…'}</p><button className="button button-secondary" onClick={openSettings}>选择笔记本</button><p className="muted">资料更新需要核对后重新学习；匹配有歧义的词条会进入待核对状态。</p></section></div>
  </>;
}
