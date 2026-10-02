import type { ReactNode } from 'react';

export function ErrorNotice({ error, retry, children }: { error: string; retry?: () => void; children?: ReactNode }) {
  if (!error) return null;
  return <div className="notice notice-error" role="alert"><div><strong>操作未完成</strong><p>{error}</p>{children}</div>{retry && <button className="button button-secondary" type="button" onClick={retry}>重试</button>}</div>;
}

export function Loading({ text = '正在读取…' }: { text?: string }) {
  return <div className="loading" role="status"><span className="loading-dots" aria-hidden="true"><span className="loading-dot" /><span className="loading-dot" /><span className="loading-dot" /></span>{text}</div>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-mark" aria-hidden="true" /><h3>{title}</h3>{children && <div className="muted">{children}</div>}{action}</div>;
}

export function PageHeading({ eyebrow, title, children, actions }: { eyebrow: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return <header className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1>{children && <p>{children}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</header>;
}

export function Tag({ children, tone = '' }: { children: ReactNode; tone?: string }) {
  return <span className={`tag ${tone ? `tag-${tone}` : ''}`}>{children}</span>;
}

export function Icon({ name }: { name: 'today' | 'library' | 'archive' | 'sync' | 'settings' }) {
  const paths = {
    today: <><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M8 3v4M16 3v4M4 11h16M8 15h3M8 18h7" /></>,
    library: <><path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-3-2H4zM13 7a3 3 0 0 1 3-3h4v15h-4a4 4 0 0 0-3 2" /></>,
    archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v12h14V8M10 12h4" /></>,
    sync: <><path d="M20 8a8 8 0 0 0-14-2L3 9M3 4v5h5M4 16a8 8 0 0 0 14 2l3-3M21 20v-5h-5" /></>,
    settings: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  };
  return <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
