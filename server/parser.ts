import { createHash } from 'node:crypto';
import type { NoteSnapshot, ParsedStudyItem } from '../shared/types.ts';

type JsonObject = Record<string, unknown>;
interface TextBlock { level: number; text: string; id: string }
interface Section { heading: TextBlock; category: string; blocks: TextBlock[] }
type ReferenceField = 'definition' | 'chinese' | 'gloss' | 'speaking' | 'writing' | 'warnings';
type ReferenceContext = ReferenceField | 'both';
interface ReferenceMarker { field: ReferenceContext; value: string; tags: string[] }

const han = /\p{Script=Han}/u;
const paragraphTypes = new Set(['p', 'paragraph', 'blockquote', 'quote', 'codeblock', 'code_block']);
const inlineTypes = new Set(['text', 'span', 'link', 'a', 'strong', 'em', 'bold', 'italic', 'mention']);
const decorativeTypes = new Set(['hr', 'horizontalrule', 'horizontal_rule', 'divider', 'image', 'img']);

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function children(node: JsonObject): unknown[] {
  for (const key of ['children', 'content', 'blocks', 'elements']) {
    if (Array.isArray(node[key])) return node[key] as unknown[];
  }
  if (object(node.document)) return [node.document];
  if (object(node.doc)) return [node.doc];
  if (object(node.content)) return [node.content];
  return [];
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (!object(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (['br', 'hardbreak', 'hard_break'].includes(String(value.type).toLowerCase())) return '\n';
  return children(value).map(textOf).join('');
}

function normalize(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ')
    .split('\n').map(line => line.replace(/[\t ]+/g, ' ').trim()).join('\n').trim();
}

function blockLevel(node: JsonObject): number {
  const type = String(node.type ?? '').toLowerCase();
  const match = /^(?:h|heading[_-]?)([1-6])$/.exec(type);
  if (match) return Number(match[1]);
  if (type === 'heading' || type === 'header') {
    const attrs = object(node.attrs) ? node.attrs : object(node.attributes) ? node.attributes : {};
    const level = Number(node.level ?? attrs.level);
    if (Number.isInteger(level) && level >= 1 && level <= 6) return level;
  }
  return 0;
}

function blocksFrom(content: string): TextBlock[] {
  let root: unknown;
  try { root = JSON.parse(content); }
  catch { throw new Error('ima 笔记内容不是有效的 JSON；已停止同步，保留原资料。'); }
  const blocks: TextBlock[] = [];
  let visited = 0;
  const walk = (value: unknown, path: string, depth: number): void => {
    if (depth > 80 || ++visited > 100_000) throw new Error('ima 笔记结构过深或过大，无法安全解析。');
    if (Array.isArray(value)) { value.forEach((node, index) => walk(node, `${path}.${index}`, depth + 1)); return; }
    if (!object(value)) return;
    const type = String(value.type ?? '').toLowerCase();
    if (decorativeTypes.has(type)) return;
    const level = blockLevel(value);
    if (level || paragraphTypes.has(type)) {
      const text = normalize(textOf(value));
      if (level && !text) throw new Error('ima 笔记含空标题，无法确定词条边界。');
      if (text) {
        const attrs = object(value.attrs) ? value.attrs : {};
        const id = value.id ?? value.blockId ?? value.block_id ?? attrs.id;
        blocks.push({ level, text, id: typeof id === 'string' && id ? id : `block:${path}` });
      }
      return;
    }
    const nested = children(value);
    if (nested.length) {
      nested.forEach((node, index) => walk(node, `${path}.${index}`, depth + 1));
    } else if (typeof value.text === 'string' && !inlineTypes.has(type)) {
      throw new Error('ima 笔记含未知文本结构，无法安全解析。');
    }
  };
  walk(root, 'root', 0);
  return blocks;
}

function cleanTitle(title: string): string {
  return normalize(title).replace(/^\s*(?:\d+[.)、]\s*|[-*•]\s+)/, '')
    .replace(/^\*\*(.*?)\*\*$/, '$1').trim();
}

function splitHeading(title: string): { term: string; gloss: string; chinese: string } {
  let term = cleanTitle(title);
  let gloss = '';
  let chinese = '';
  const arrow = /\s*(?:→|⇒|->)\s*/.exec(term);
  if (arrow) {
    gloss = term.slice(arrow.index + arrow[0].length).trim();
    term = term.slice(0, arrow.index).trim();
  } else {
    const bracket = /^(.*?)\s*[（(]([^（）()]+)[）)]\s*$/.exec(term);
    if (bracket && han.test(bracket[2])) { term = bracket[1].trim(); chinese = bracket[2].trim(); }
    else {
      const separated = /^([A-Za-z][A-Za-z0-9'’\s.,/&↔⇄<>−-]*?)\s*(?:[:：]|[—–]\s*|\s+)\s*(\p{Script=Han}.*)$/u.exec(term);
      if (separated) { term = separated[1].trim(); chinese = separated[2].trim(); }
    }
  }
  if (gloss) {
    const bracket = /[（(]([^（）()]*\p{Script=Han}[^（）()]*)[）)]\s*$/u.exec(gloss);
    if (bracket) { chinese = bracket[1].trim(); gloss = gloss.slice(0, bracket.index).trim(); }
    else if (han.test(gloss) && !/[A-Za-z]/.test(gloss)) { chinese = gloss; gloss = ''; }
  }
  return { term, gloss, chinese };
}

const labelPatterns: Array<[ReferenceContext, string]> = [
  ['speaking', 'speaking(?:\\s+(?:usage|examples?|application))?|口语(?:例句|用法|应用)?|雅思口语'],
  ['writing', 'writing(?:\\s+(?:usage|examples?|application))?|写作(?:例句|用法|应用)?|雅思写作'],
  ['both', 'both|口语与写作|口语和写作|两者皆可'],
  ['warnings', 'warnings?|pitfalls?|caution|avoid|注意(?:事项)?|警告|避坑|误区|易错(?:点)?|禁忌|语域|register'],
  ['definition', 'definition|english\\s+definition|英文释义|英文定义|定义'],
  ['chinese', 'chinese(?:\\s+(?:meaning|gloss|definition))?|中文(?:释义|意思)?|释义|含义|意思'],
  ['gloss', 'gloss|meaning|释义提示'],
];

function metadataTags(text: string): string[] {
  const tags = new Set<string>();
  for (const match of text.matchAll(/\b(BrE|AmE|informal|formal|literary|rare)\b/gi)) {
    if (/\b(?:not|non)\s*[- ]?$/i.test(text.slice(0, match.index))) continue;
    const lower = match[1].toLowerCase();
    tags.add(lower === 'bre' ? 'BrE' : lower === 'ame' ? 'AmE' : lower);
  }
  return [...tags];
}

function annotationTags(text: string): string[] {
  return [...text.matchAll(/[（(]([^（）()]*)[）)]/g)].flatMap(match => metadataTags(match[1]));
}

function referenceMarkers(text: string): ReferenceMarker[] {
  const pattern = new RegExp(`(?:^|[|;\\n]\\s*|[\\p{Extended_Pictographic}\\uFE0F]+\\s*)(${labelPatterns.map(([, label]) => `(?:${label})`).join('|')})`
    + '(?:\\s*[（(]([^（）()]*)[）)])?\\s*(?:[:：]|(?=\\s*(?:$|[|;\\n])))', 'giu');
  const matches = [...text.matchAll(pattern)];
  const markers = matches.map((match, index): ReferenceMarker => {
    let field = labelPatterns.find(([, label]) => new RegExp(`^(?:${label})$`, 'iu').test(match[1]))![0];
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const value = text.slice(match.index! + match[0].length, end).replace(/^[|;\s]+|[|;\s]+$/g, '');
    if (field === 'gloss' && han.test(value) && !/[A-Za-z]/.test(value)) field = 'chinese';
    const tags = metadataTags(match[2] ?? '');
    if (field === 'speaking') tags.unshift('Speaking');
    else if (field === 'writing') tags.unshift('Writing');
    else if (field === 'both') tags.unshift('Both');
    if (field === 'definition' || field === 'gloss') tags.push(...annotationTags(value));
    if (/^(?:register|语域)$/i.test(match[1])) tags.push(...metadataTags(value));
    return { field, value, tags };
  });
  if (!markers.length && /^(?:⚠|❗)/u.test(text)) return [{ field: 'warnings', value: text.trim(), tags: [] }];
  return markers;
}

function itemFrom(section: Section, snapshot: NoteSnapshot): ParsedStudyItem {
  const title = cleanTitle(section.heading.text);
  const heading = splitHeading(title);
  if (!heading.term) throw new Error('ima 笔记存在无法识别词条名称的标题。');
  const body: string[] = [];
  const fields: Record<ReferenceField, string[]> = {
    definition: [], chinese: [], gloss: [], speaking: [], writing: [], warnings: [],
  };
  const tags = new Set(section.category ? [section.category] : []);
  annotationTags(heading.gloss).forEach(tag => tags.add(tag));
  let context: ReferenceContext | null = null;
  let hasReferenceBody = false;
  const appendReference = (field: ReferenceContext, value: string): void => {
    if (!value) return;
    hasReferenceBody = true;
    if (field === 'both') { fields.speaking.push(value); fields.writing.push(value); }
    else fields[field].push(value);
  };
  for (const block of section.blocks) {
    body.push(block.text);
    const markers = referenceMarkers(block.text);
    if (markers.length) {
      for (const marker of markers) {
        context = marker.field;
        marker.tags.forEach(tag => tags.add(tag));
        appendReference(marker.field, marker.value);
      }
    } else if (context) appendReference(context, block.text);
    else if (!block.level && !fields.definition.length && /[A-Za-z]/.test(block.text)) appendReference('definition', block.text);
    else hasReferenceBody = true;
  }
  const members = heading.term.split(/\s*(?:↔|⇄|<->)\s*/).map(part => part.trim()).filter(Boolean);
  const contrast = members.length > 1;
  const kind: ParsedStudyItem['kind'] = contrast ? 'contrast'
    : /\b(?:sth|sb|somebody|someone|something)\b|\.\.\.|…/i.test(heading.term) ? 'pattern'
      : heading.term.split(/\s+/).length > 1 ? 'phrase' : 'word';
  const chinese = [heading.chinese, ...fields.chinese].filter(Boolean).join('\n');
  const gloss = [heading.gloss, ...fields.gloss].filter(Boolean).join('\n');
  const definition = fields.definition.join('\n');
  const data = {
    title, term: heading.term, gloss, chinese, definition, body,
    speaking: fields.speaking, writing: fields.writing, warnings: fields.warnings,
    members: contrast ? members : [], tags: [...tags], kind,
    needsSupplement: !hasReferenceBody || !(definition || gloss || chinese),
  };
  return {
    source: { noteId: snapshot.noteId, noteTitle: snapshot.title, folderId: snapshot.folderId,
      folderName: snapshot.folderName, blockId: section.heading.id },
    ...data, contentHash: createHash('sha256').update(JSON.stringify(data)).digest('hex'),
  };
}

function fallbackSections(blocks: TextBlock[]): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const block of blocks) {
    const explicit = /^(?:term|word|phrase|expression|词条|单词|短语|表达)\s*[:：]\s*(.+)$/i.exec(block.text);
    const arrowHeading = block.level > 0 && block.level <= 2
      && /^[A-Za-z][^\n]*\s(?:→|⇒|->)\s*\S/.test(block.text);
    if (explicit || arrowHeading) {
      current = { heading: { ...block, text: explicit ? explicit[1] : block.text }, category: '', blocks: [] };
      sections.push(current);
    } else if (block.level && block.level <= 2) current = null;
    else if (current) current.blocks.push(block);
  }
  // Explicit but incomplete entries invalidate the whole note; dropping one could archive its old version.
  for (const section of sections) {
    let labeledContext = false;
    const hasReference = section.blocks.some(block => {
      const markers = referenceMarkers(block.text);
      if (markers.some(marker => marker.value)) return true;
      if (markers.length) { labeledContext = true; return false; }
      return labeledContext && !block.level;
    });
    if (!hasReference) throw new Error('笔记中的词条结构不完整，已停止同步并保留原资料。请提供明确的定义或使用参考。');
  }
  return sections;
}

export function parseNote(snapshot: NoteSnapshot): ParsedStudyItem[] {
  const blocks = blocksFrom(snapshot.content);
  let sections: Section[];
  if (blocks.some(block => block.level === 3)) {
    sections = [];
    let category = '';
    let current: Section | null = null;
    for (const block of blocks) {
      if (block.level === 1) { current = null; category = ''; }
      else if (block.level === 2) { category = block.text; current = null; }
      else if (block.level === 3) {
        current = { heading: block, category, blocks: [] };
        sections.push(current);
      } else if (current) current.blocks.push(block);
    }
  } else sections = fallbackSections(blocks);
  if (!sections.length) {
    throw new Error('有笔记缺少可识别的词条结构；已停止同步，保留原资料。请使用三级标题或明确的 Term/Definition 结构。');
  }
  return sections.map(section => itemFrom(section, snapshot));
}
