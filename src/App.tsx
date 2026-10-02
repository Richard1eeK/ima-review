import { useEffect, useState } from 'react';
import type { AppStats, Question, Settings } from '../shared/types';
import { request } from './api';
import { Icon } from './components/Common';
import { useResource } from './hooks/useResource';
import { ArchivePage } from './pages/ArchivePage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';
import { SyncPage } from './pages/SyncPage';
import { TodayPage } from './pages/TodayPage';

type Section = 'today' | 'library' | 'archive' | 'sync' | 'settings';
const sections: { id: Section; label: string; subtitle: string }[] = [
  { id: 'today', label: '今日学习', subtitle: '新学 · 复习 · 应用' },
  { id: 'library', label: '我的词库', subtitle: '笔记与词条' },
  { id: 'archive', label: '作答档案', subtitle: '回看与修订' },
  { id: 'sync', label: '同步笔记', subtitle: '资料更新' },
  { id: 'settings', label: '学习设置', subtitle: '节奏与备份' },
];
function sectionFromHash(): Section {
  const value = window.location.hash.slice(1);
  return sections.some(section => section.id === value) ? value as Section : 'today';
}

export default function App() {
  const [section, setSection] = useState<Section>(sectionFromHash);
  const settings = useResource(() => request<Settings>('/api/settings'));
  const stats = useResource(() => request<AppStats>('/api/stats'));
  const [refreshKey, setRefreshKey] = useState(0);
  const [practiceFocus, setPracticeFocus] = useState<Question | null>(null);
  useEffect(() => {
    const change = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = settings.data?.reducedMotion ? 'true' : 'false';
  }, [settings.data?.reducedMotion]);
  const navigate = (destination: Section) => { window.location.hash = destination; setSection(destination); window.scrollTo({ top: 0, behavior: 'instant' }); };
  const progress = () => { void stats.reload(); };
  const restored = () => { void settings.reload(); void stats.reload(); setRefreshKey(current => current + 1); };
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <aside className="sidebar"><a className="brand" href="#today" onClick={() => navigate('today')}><span className="brand-seal" aria-hidden="true">温</span><span><strong>温故</strong><small>英语复习手册</small></span></a><div className="sidebar-divider" /><nav className="main-nav" aria-label="主要导航">{sections.map(item => <a key={item.id} href={`#${item.id}`} className={section === item.id ? 'is-active' : ''} aria-current={section === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><Icon name={item.id} /><span><strong>{item.label}</strong><small>{item.subtitle}</small></span><span className="nav-dot" aria-hidden="true" /></a>)}</nav><div className="sidebar-footer"><span className="sidebar-motto" aria-hidden="true">温故而知新</span><div className="library-stat"><span>正在学习的词条</span><strong>{stats.data?.active ?? '—'}</strong></div><p>学而时习之</p><small>从自己的笔记，走向自己的表达。</small>{stats.error && <button className="text-button" onClick={() => { void stats.reload(); }}>词库数量读取失败 · 重试</button>}</div></aside>
    <main id="main-content" className="main-content page-enter" key={`${refreshKey}:${section}`} tabIndex={-1}>
      <div className="mobile-brand"><span className="brand-seal" aria-hidden="true">温</span><strong>温故 · 英语复习</strong></div>
      {section === 'today' && <TodayPage onProgress={progress} openSettings={() => navigate('settings')} openSync={() => navigate('sync')} practiceFocus={practiceFocus} onFocusHandled={() => setPracticeFocus(null)} />}
      {section === 'library' && <LibraryPage onProgress={progress} onPractice={question => { setPracticeFocus(question); navigate('today'); }} />}
      {section === 'archive' && <ArchivePage />}
      {section === 'sync' && <SyncPage settings={settings.data} onSynced={progress} openSettings={() => navigate('settings')} />}
      {section === 'settings' && <SettingsPage settings={settings.data} error={settings.error} loading={settings.loading} retry={() => { void settings.reload(); }} onSaved={result => settings.setData(result)} onRestored={restored} />}
    </main>
  </div>;
}
