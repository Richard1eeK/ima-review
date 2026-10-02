import { useEffect, useRef, useState } from 'react';
import type { BackupData, BackupFile, Notebook, Settings } from '../../shared/types';
import { message, request, write } from '../api';
import { EmptyState, ErrorNotice, Loading, PageHeading, Tag } from '../components/Common';
import { useResource } from '../hooks/useResource';
import { dateTime } from '../lib';

export function SettingsPage({ settings, error, loading, retry, onSaved, onRestored }: {
  settings?: Settings; error: string; loading: boolean; retry: () => void;
  onSaved: (settings: Settings) => void; onRestored: () => void;
}) {
  return <>
    <PageHeading eyebrow="循序而行 · SETTINGS" title="学习设置">安排适合自己的节奏，选择资料范围，并保留可恢复的备份。</PageHeading>
    <ErrorNotice error={error} retry={retry} />{loading && !settings ? <Loading /> : settings && <SettingsForm settings={settings} onSaved={onSaved} />}
    <BackupSettings timezone={settings?.timezone} onRestored={onRestored} />
  </>;
}

function SettingsForm({ settings, onSaved }: { settings: Settings; onSaved: (settings: Settings) => void }) {
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const notebooks = useResource(() => request<Notebook[]>('/api/notebooks'));
  useEffect(() => { setForm(settings); }, [settings]);
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm(current => ({ ...current, [key]: value })); setSaved(false);
  };
  const save = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setSaved(false);
    try {
      new Intl.DateTimeFormat('zh-CN', { timeZone: form.timezone }).format();
      const result = await write<Settings>('/api/settings', 'PATCH', form);
      setForm(result); onSaved(result); setSaved(true);
    } catch (cause) { setError(cause instanceof RangeError ? '请填写有效的时区，例如 Asia/Shanghai。' : message(cause)); }
    finally { lock.current = false; setBusy(false); }
  };
  const toggleFolder = (id: string) => update('folderIds', form.folderIds.includes(id) ? form.folderIds.filter(folder => folder !== id) : [...form.folderIds, id]);
  const unknownFolders = form.folderIds.filter(id => !notebooks.data?.some(notebook => notebook.id === id));
  return <form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <section className="panel"><div className="section-heading"><h2>每日学习节奏</h2><Tag>可随时调整</Tag></div><div className="settings-grid"><label><span>每天新学</span><div className="number-input"><input type="number" min="0" max="500" step="1" required value={form.newLimit} disabled={busy} onChange={event => update('newLimit', Number(event.target.value))} /><span>项</span></div></label><label><span>每天复习</span><div className="number-input"><input type="number" min="0" max="500" step="1" required value={form.reviewLimit} disabled={busy} onChange={event => update('reviewLimit', Number(event.target.value))} /><span>项</span></div></label><label><span>每天应用题</span><div className="number-input"><input type="number" min="0" max="500" step="1" required value={form.practiceLimit} disabled={busy} onChange={event => update('practiceLimit', Number(event.target.value))} /><span>题</span></div></label></div><p className="muted">辨析词组按一个词条计算；应用题来自当天实际完成的新学与复习。</p><div className="settings-grid"><label><span>学习时间</span><input type="time" required value={form.studyTime} disabled={busy} onChange={event => update('studyTime', event.target.value)} /></label><label><span>每日同步时间</span><input type="time" required value={form.syncTime} disabled={busy} onChange={event => update('syncTime', event.target.value)} /></label><label><span>所在时区</span><input list="timezones" value={form.timezone} required disabled={busy} onChange={event => update('timezone', event.target.value)} /><datalist id="timezones"><option value="Asia/Shanghai" /><option value="Asia/Hong_Kong" /><option value="Asia/Tokyo" /><option value="Australia/Sydney" /><option value="Europe/London" /><option value="America/New_York" /></datalist></label></div><label className="checkbox-label motion-option"><input type="checkbox" checked={form.reducedMotion} disabled={busy} onChange={event => update('reducedMotion', event.target.checked)} /><span>减少界面动效</span></label></section>
    <section className="panel"><div className="section-heading"><h2>资料笔记本</h2><button className="button button-secondary" type="button" disabled={notebooks.loading} onClick={() => { void notebooks.reload(); }}>{notebooks.loading ? '读取中…' : '刷新列表'}</button></div><p className="muted">从 ima 读取笔记本列表，选定后保存设置，再到同步页导入。</p><ErrorNotice error={notebooks.error} retry={() => { void notebooks.reload(); }} />{notebooks.loading && !notebooks.data ? <Loading text="正在读取 ima 笔记本…" /> : notebooks.data?.length ? <div className="notebook-list">{notebooks.data.map(notebook => <label className={`notebook-option ${form.folderIds.includes(notebook.id) ? 'is-selected' : ''}`} key={notebook.id}><input type="checkbox" disabled={busy} checked={form.folderIds.includes(notebook.id)} onChange={() => toggleFolder(notebook.id)} /><span><strong>{notebook.name}</strong><small>{notebook.count} 份笔记</small></span></label>)}</div> : !notebooks.error && <EmptyState title="暂时没有可选择的笔记本"><p>核对 ima 连接后，刷新列表。</p></EmptyState>}{unknownFolders.length > 0 && <div className="unknown-folders"><p className="muted">以下已选笔记本暂未出现在本次列表中，可保留或移除。</p>{unknownFolders.map(id => <label className="checkbox-label" key={id}><input type="checkbox" disabled={busy} checked onChange={() => toggleFolder(id)} /><span>已选笔记本 <small className="muted">{id}</small></span></label>)}</div>}</section>
    <ErrorNotice error={error} retry={() => { void save(); }} /><div className="settings-save"><span className="muted" role="status">{saved ? '设置已保存。' : dirty ? '设置有改动，保存后生效。' : '当前设置已保存。'}</span><button className="button button-primary" type="submit" disabled={busy || !dirty}>{busy ? '保存中…' : '保存学习设置'}</button></div>
  </form>;
}

function BackupSettings({ timezone, onRestored }: { timezone?: string; onRestored: () => void }) {
  const backups = useResource(() => request<BackupFile[]>('/api/backups'));
  const [creating, setCreating] = useState(false);
  const [backupError, setBackupError] = useState('');
  const [backupNotice, setBackupNotice] = useState('');
  const [file, setFile] = useState<{ name: string; content: unknown } | null>(null);
  const [validation, setValidation] = useState<{ items: number; answers: number; reviews: number } | null>(null);
  const [reading, setReading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const [restoreNotice, setRestoreNotice] = useState('');
  const createLock = useRef(false);
  const restoreLock = useRef(false);
  const fileReadId = useRef(0);
  const create = async () => {
    if (createLock.current) return;
    createLock.current = true; setCreating(true); setBackupError(''); setBackupNotice('');
    try {
      const result = await write<BackupFile>('/api/backups', 'POST');
      setBackupNotice(`备份已创建：${result.name}`); await backups.reload();
    } catch (cause) { setBackupError(message(cause)); }
    finally { createLock.current = false; setCreating(false); }
  };
  const readFile = async (selected?: File) => {
    const id = ++fileReadId.current;
    setFile(null); setValidation(null); setRestoreError(''); setRestoreNotice('');
    if (!selected) return;
    setReading(true);
    try {
      const content: unknown = JSON.parse(await selected.text());
      if (id === fileReadId.current) setFile({ name: selected.name, content });
    } catch { if (id === fileReadId.current) setRestoreError('这个文件不能读取为 JSON。请使用从本应用导出的 JSON 备份。'); }
    finally { if (id === fileReadId.current) setReading(false); }
  };
  const validate = async () => {
    if (!file || validating || restoring) return;
    setValidating(true); setValidation(null); setRestoreError(''); setRestoreNotice('');
    try {
      const result = await write<{ valid: true; counts: { items: number; answers: number; reviews: number } }>('/api/restore/validate', 'POST', file.content);
      if (result.valid) setValidation(result.counts);
    } catch (cause) { setRestoreError(message(cause)); }
    finally { setValidating(false); }
  };
  const restore = async () => {
    if (!file || !validation || restoreLock.current) return;
    restoreLock.current = true; setRestoring(true); setRestoreError(''); setRestoreNotice('');
    try {
      const result = await write<{ restored: true }>('/api/restore', 'POST', { backup: file.content as BackupData, confirm: true });
      if (result.restored) {
        setRestoreNotice('备份已恢复。恢复前的现有资料也已自动备份。'); setFile(null); setValidation(null);
        onRestored(); await backups.reload();
      }
    } catch (cause) { setRestoreError(message(cause)); }
    finally { restoreLock.current = false; setRestoring(false); }
  };
  return <section className="panel backup-panel"><div className="section-heading"><div><span className="eyebrow">备份与恢复</span><h2>为学习留下副本</h2></div><button className="button button-secondary" disabled={creating || restoring} onClick={() => { void create(); }}>{creating ? '创建中…' : '创建本机备份'}</button></div><p className="muted">本机备份可下载保存；需要恢复时，使用从作答档案导出的完整 JSON 备份。</p><ErrorNotice error={backupError} retry={() => { void create(); }} />{backupNotice && <p className="notice notice-success" role="status">{backupNotice}</p>}<ErrorNotice error={backups.error} retry={() => { void backups.reload(); }} />{backups.loading && !backups.data ? <Loading /> : backups.data?.length ? <div className="backup-list">{backups.data.map(backup => <div className="backup-row" key={backup.name}><span><strong>{backup.name}</strong><small>{dateTime(backup.createdAt, timezone)} · {(backup.bytes / 1024).toFixed(1)} KB</small></span><a className="button button-secondary" href={`/api/backups/${encodeURIComponent(backup.name)}`} download>下载备份</a></div>)}</div> : <p className="muted">尚未创建本机备份。</p>}
    <div className="restore-section"><h3>从 JSON 备份恢复</h3><p className="muted">先选择文件并验证内容，再明确确认恢复。恢复会替换现有词库、作答与设置；操作前会自动创建备份。</p><label className="file-label"><span>选择 JSON 备份</span><input type="file" accept=".json,application/json" disabled={validating || restoring} onChange={event => { void readFile(event.target.files?.[0]); }} /></label>{reading && <Loading text="正在读取文件…" />}{file && <div className="restore-file"><p>已选择：<strong>{file.name}</strong></p><button className="button button-secondary" disabled={validating || restoring} onClick={() => { void validate(); }}>{validating ? '验证中…' : '验证备份内容'}</button></div>}{validation && <div className="restore-confirm"><h4>备份验证通过</h4><p>{validation.items} 项词条 · {validation.answers} 份作答 · {validation.reviews} 条自评记录</p><p>请确认用这份备份替换当前资料。</p><button className="button button-danger" disabled={restoring} onClick={() => { void restore(); }}>{restoring ? '恢复中…' : '确认恢复此备份'}</button></div>}<ErrorNotice error={restoreError} />{restoreNotice && <p className="notice notice-success" role="status">{restoreNotice}</p>}</div>
  </section>;
}
