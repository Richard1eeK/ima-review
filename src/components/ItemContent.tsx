import type { StudyItem } from '../../shared/types';
import { sourceLabel } from '../lib';
import { Tag } from './Common';

export function ItemFlags({ item }: { item: StudyItem }) {
  return <div className="tags">{item.needsSupplement && <Tag tone="amber">资料待补充</Tag>}{item.needsRelearn && <Tag tone="amber">资料已更新 · 需重新学习</Tag>}{item.status === 'pending' && <Tag tone="amber">待核对</Tag>}{item.status === 'archived' && <Tag>已归档</Tag>}</div>;
}

export function ItemContent({ item, compact = false }: { item: StudyItem; compact?: boolean }) {
  return <div className={`item-content ${compact ? 'item-content-compact' : ''}`}>
    <div className="source-line">来源：{sourceLabel(item.source)}</div>
    <ItemFlags item={item} />
    {item.needsSupplement && <p className="notice-inline">当前资料还不完整；学习以已有笔记为依据，缺少的内容可回到原笔记补充。</p>}
    {item.chinese && <p className="chinese-gloss">{item.chinese}</p>}
    {item.gloss && <p className="english-text">{item.gloss}</p>}
    {item.definition && <section><h4>定义</h4><p className="english-text">{item.definition}</p></section>}
    {item.members.length > 0 && <section><h4>辨析词组</h4><p className="english-text">{item.members.join(' / ')}</p></section>}
    {item.body.length > 0 && <section className="note-original"><h4>笔记原文</h4>{item.body.map((line, index) => <p key={index}>{line}</p>)}</section>}
    {item.speaking.length > 0 && <section><h4>口语用法</h4>{item.speaking.map((line, index) => <p key={index} className="english-text">{line}</p>)}</section>}
    {item.writing.length > 0 && <section><h4>写作用法</h4>{item.writing.map((line, index) => <p key={index} className="english-text">{line}</p>)}</section>}
    {item.warnings.length > 0 && <section className="warning-block"><h4>使用提醒</h4>{item.warnings.map((line, index) => <p key={index}>{line}</p>)}</section>}
    {item.tags.length > 0 && <div className="tags">{item.tags.map(tag => <Tag key={tag}>{tag}</Tag>)}</div>}
  </div>;
}
