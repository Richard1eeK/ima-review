import assert from 'node:assert/strict';
import test from 'node:test';
import type { NoteSnapshot } from '../shared/types.ts';
import { parseNote } from '../server/parser.ts';

// All note content here is synthetic; no personal ima notes are stored as fixtures.
const block = (type: string, text: string, id = `synthetic-${type}`) => ({ type, id, children: [{ text }] });
function snapshot(content: unknown): NoteSnapshot {
  return { noteId: 'synthetic-note', title: 'Synthetic vocabulary', folderId: 'synthetic-folder',
    folderName: 'Synthetic IELTS Vocabulary', modifiedAt: '2026-10-01T00:00:00.000Z',
    content: JSON.stringify(content), hash: 'synthetic', fetchedAt: '2026-10-02T00:00:00.000Z' };
}

test('IMA h2/h3/p tree preserves paragraphs, nested text, definition and application references', () => {
  const note = snapshot([
    block('p', 'Synthetic bank overview'), block('h2', 'A', 'category-a'),
    block('h3', 'abundant → existing in large amounts（丰富的）', 'entry-one'),
    { type: 'p', id: 'definition-one', children: [{ text: 'Definition: ' },
      { type: 'strong', children: [{ text: 'more than enough' }] }, { text: ' for the test.' }] },
    block('p', '📣 Speaking: There is abundant food.'),
    block('p', '✍️ Writing: The region has abundant resources.'),
    block('p', '⚠️ Warning: Do not use this example as a factual claim.'),
    block('hr', ''),
  ]);
  const [item] = parseNote(note);
  assert.equal(item.term, 'abundant');
  assert.equal(item.gloss, 'existing in large amounts');
  assert.equal(item.chinese, '丰富的');
  assert.equal(item.definition, 'more than enough for the test.');
  assert.deepEqual(item.tags, ['A', 'Speaking', 'Writing']);
  assert.deepEqual(item.speaking, ['There is abundant food.']);
  assert.deepEqual(item.writing, ['The region has abundant resources.']);
  assert.deepEqual(item.warnings, ['Do not use this example as a factual claim.']);
  assert.deepEqual(item.body, [
    'Definition: more than enough for the test.', '📣 Speaking: There is abundant food.',
    '✍️ Writing: The region has abundant resources.', '⚠️ Warning: Do not use this example as a factual claim.',
  ]);
  assert.equal(item.source.blockId, 'entry-one');
  assert.equal(item.source.noteId, note.noteId);
  assert.equal(item.needsSupplement, false);
});

test('a synonym ↔ group remains one study item and category boundaries keep references separate', () => {
  const items = parseNote(snapshot([
    block('h2', 'Nuance'), block('h3', 'inventive ↔ creative → able to form new ideas（有创造力的）', 'group'),
    block('p', 'Definition: A synthetic contrast reference.'),
    block('blockquote', '⚠ Use the reference context when choosing a word.'),
    block('h2', 'B'), block('p', 'This category introduction is not part of the previous entry.'),
    block('h3', 'brief（简短的）', 'second'), block('p', 'Chinese: 简短的'),
  ]));
  assert.equal(items.length, 2);
  assert.equal(items[0].kind, 'contrast');
  assert.deepEqual(items[0].members, ['inventive', 'creative']);
  assert.deepEqual(items[0].tags, ['Nuance']);
  assert.deepEqual(items[0].warnings, ['⚠ Use the reference context when choosing a word.']);
  assert.equal(items[0].body.length, 2);
  assert.deepEqual(items[1].tags, ['B']);
  assert.equal(items[1].term, 'brief');
});

test('a title with a short gloss remains available and needs supplementation', () => {
  const [item] = parseNote(snapshot([block('h3', 'make progress → move forward（取得进展）', 'title-only')]));
  assert.equal(item.term, 'make progress');
  assert.equal(item.kind, 'phrase');
  assert.equal(item.gloss, 'move forward');
  assert.equal(item.chinese, '取得进展');
  assert.equal(item.needsSupplement, true);
  assert.deepEqual(item.body, []);
  assert.deepEqual(item.speaking, []);
  assert.deepEqual(item.writing, []);
  assert.deepEqual(item.warnings, []);
  assert.equal(item.definition, '');
});

test('content hashes ignore every block ID and source location, but change with source text', () => {
  const original = [block('h2', 'D', 'h2-old'), block('h3', 'durable → lasting a long time', 'old'),
    block('p', 'Definition: It lasts.', 'p-old')];
  const moved = original.map((value, index) => ({ ...value, id: `new-${index}` }));
  const oldItem = parseNote(snapshot(original))[0];
  const movedItem = parseNote({ ...snapshot(moved), noteId: 'new-note', title: 'Renamed note', folderId: 'new-folder' })[0];
  assert.equal(oldItem.contentHash, movedItem.contentHash);
  assert.notEqual(oldItem.source.blockId, movedItem.source.blockId);
  const changed = [...moved.slice(0, 2), block('p', 'Definition: It lasts longer.', 'p-new')];
  assert.notEqual(oldItem.contentHash, parseNote(snapshot(changed))[0].contentHash);
});

test('ProseMirror content and heading-level attributes are supported without dropping inline text', () => {
  const [item] = parseNote(snapshot({ type: 'doc', content: [
    { type: 'heading', attrs: { level: 2, id: 'category' }, content: [{ type: 'text', text: 'Patterns' }] },
    { type: 'heading', attrs: { level: 3, id: 'pattern' }, content: [{ type: 'text', text: 'enable sb to do sth' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Definition: allow someone' },
      { type: 'text', text: ' to act.' }] },
  ] }));
  assert.equal(item.kind, 'pattern');
  assert.equal(item.definition, 'allow someone to act.');
  assert.equal(item.source.blockId, 'pattern');
});

test('explicit Term/Definition fallback works while generic personal prose is rejected', () => {
  const [item] = parseNote(snapshot([
    block('p', 'Term: concise'), block('p', 'Definition: using few words.'),
    block('p', 'Chinese: 简明的'), block('p', 'Speaking: Keep the answer concise.'),
  ]));
  assert.equal(item.term, 'concise');
  assert.equal(item.definition, 'using few words.');
  assert.equal(item.chinese, '简明的');
  assert.deepEqual(item.speaking, ['Keep the answer concise.']);
  assert.throws(() => parseNote(snapshot([block('p', 'A private journal entry about tomorrow.'),
    block('p', 'It contains ordinary prose and no vocabulary structure.')])), /缺少可识别的词条结构/);
  assert.throws(() => parseNote(snapshot([block('p', 'Term: merely a heading')])), /词条结构不完整/);
});

test('an explicit h2 term → gloss can be conservatively extracted without h3', () => {
  const [item] = parseNote(snapshot([block('h2', 'clarify → make clear'), block('p', 'Writing: Please clarify the rule.')]));
  assert.equal(item.term, 'clarify');
  assert.equal(item.gloss, 'make clear');
  assert.deepEqual(item.writing, ['Please clarify the rule.']);
});

test('empty, malformed, empty-heading and unknown text structures fail rather than returning an empty import', () => {
  assert.throws(() => parseNote(snapshot([])), /缺少可识别/);
  assert.throws(() => parseNote({ ...snapshot([]), content: 'secret invalid content' }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /不是有效的 JSON/);
    assert.ok(!error.message.includes('secret invalid content'));
    return true;
  });
  assert.throws(() => parseNote(snapshot([block('h3', '')])), /空标题/);
  assert.throws(() => parseNote(snapshot([{ type: 'unknown', text: 'secret body' }])), /未知文本结构/);
});

test('qualified inline Writing/Speaking labels split references and add explicit usage tags', () => {
  const [item] = parseNote(snapshot([
    block('h2', 'S'), block('h3', 'slow → moving without haste'),
    block('p', 'Definition: (informal, chiefly BrE) a synthetic definition.'),
    block('p', '📝 Writing (literary, rare): leisurely / unhurried | 📣 Speaking: slow'),
    block('p', '⚪ Both | 📣 Speaking: take time | 📝 Writing: proceed gradually'),
  ]));
  assert.deepEqual(item.writing, ['leisurely / unhurried', 'proceed gradually']);
  assert.deepEqual(item.speaking, ['slow', 'take time']);
  assert.equal(item.definition, '(informal, chiefly BrE) a synthetic definition.');
  assert.deepEqual(new Set(item.tags), new Set(['S', 'informal', 'BrE', 'Writing', 'literary', 'rare', 'Speaking', 'Both']));
  assert.equal(item.body[1], '📝 Writing (literary, rare): leisurely / unhurried | 📣 Speaking: slow');
});

test('bare qualified usage labels establish context without inventing a definition or reference', () => {
  const [item] = parseNote(snapshot([
    block('h3', 'tasty → pleasant to eat'), block('p', '📣 Speaking (BrE)'),
  ]));
  assert.equal(item.definition, '');
  assert.deepEqual(item.speaking, []);
  assert.deepEqual(new Set(item.tags), new Set(['Speaking', 'BrE']));
  assert.equal(item.needsSupplement, true);
  const [continued] = parseNote(snapshot([
    block('h3', 'tasty → pleasant to eat'), block('p', '📣 Speaking (AmE, informal)'),
    block('p', 'The food is tasty.'), block('h4', 'Writing (formal)'),
    block('p', 'The meal was pleasant.'),
  ]));
  assert.equal(continued.definition, '');
  assert.deepEqual(continued.speaking, ['The food is tasty.']);
  assert.deepEqual(continued.writing, ['The meal was pleasant.']);
  assert.deepEqual(new Set(continued.tags), new Set(['Speaking', 'AmE', 'informal', 'Writing', 'formal']));
});

test('multiline labeled paragraphs keep all text in the appropriate field', () => {
  const [item] = parseNote(snapshot([
    block('h3', 'helpful → useful to someone'),
    block('p', 'Speaking: The advice is helpful.\nIt helps me prepare.'),
  ]));
  assert.deepEqual(item.speaking, ['The advice is helpful.\nIt helps me prepare.']);
  assert.equal(item.definition, '');
});

test('fallback rejects a partial Term entry or an ordinary arrow-based tutorial', () => {
  assert.throws(() => parseNote(snapshot([
    block('p', 'Term: helpful'), block('p', 'Definition: useful to someone.'),
    block('p', 'Term: incomplete'),
  ])), /完整|缺少|结构/);
  assert.throws(() => parseNote(snapshot([
    block('p', 'Open the browser → click the button'), block('p', 'Then complete the form.'),
  ])), /缺少可识别/);
});
