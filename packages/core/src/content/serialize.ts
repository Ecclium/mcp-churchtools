/**
 * Writes the tree of the content policy as Markdown (ADR 0030): the only
 * way a text of a write reaches ChurchTools.
 *
 * Where it stands in the way of a write: last in the content policy, after
 * the checks. It writes one form for each node, whatever form the text
 * had: `#` for headings, `-` before the items of a list, `**` for bold,
 * `*` for italic, one blank line between blocks. Every sign that could
 * start Markdown is escaped in text, so the lexer reads the output back as
 * the same text, and writing the output once more gives it unchanged. The
 * check code of a section (ADR 0032) is taken over this form, so a change
 * to it needs a new prefix of that code.
 *
 * @packageDocumentation
 */
import type { Alignment, Block, Inline, List, Table } from './tree.js';

// Signs escaped wherever they stand in text: they start emphasis, code,
// links and their references, HTML and autolinks, tables, struck text,
// character references and headings, also the closing #s of a heading.
const alwaysEscaped = '\\`*_[]<>|~&#';

const escapeText = (text: string): string => {
  let escaped = '';
  for (const sign of text) {
    escaped += alwaysEscaped.includes(sign) ? `\\${sign}` : sign;
  }
  return escaped;
};

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

// A line of a paragraph that starts like a list item, the line under a
// heading or a rule gets a backslash before that sign: -, + and = always,
// a number before the . or ) right after it.
const escapeLineStart = (line: string): string => {
  const first = line.charCodeAt(0);
  if (first === 0x2d || first === 0x2b || first === 0x3d) return `\\${line}`;
  let end = 0;
  while (isDigit(line.charCodeAt(end))) end += 1;
  const after = line.charCodeAt(end);
  return end > 0 && (after === 0x2e || after === 0x29)
    ? `${line.slice(0, end)}\\${line.slice(end)}`
    : line;
};

const inlines = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) => {
      if (node.kind === 'text') return escapeText(node.text);
      const mark = node.kind === 'strong' ? '**' : '*';
      return `${mark}${inlines(node.children)}${mark}`;
    })
    .join('');

const paragraph = (nodes: readonly Inline[]): string =>
  inlines(nodes).split('\n').map(escapeLineStart).join('\n');

// Every line after the first gets the width of the marker as indent, so
// it stays inside the item; a blank line stays blank.
const indent = (body: string, marker: string): string => {
  if (body === '') return marker.trimEnd();
  const pad = ' '.repeat(marker.length);
  return body
    .split('\n')
    .map((line, index) =>
      index === 0 ? marker + line : line === '' ? '' : pad + line,
    )
    .join('\n');
};

const delimiters: Readonly<Record<'left' | 'center' | 'right', string>> =
  Object.freeze({ left: ':--', center: ':-:', right: '--:' });

const delimiter = (align: Alignment): string =>
  align === null ? '---' : delimiters[align];

const row = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;

const table = (node: Table): string =>
  [
    row(node.header.map(inlines)),
    row(node.align.map(delimiter)),
    ...node.rows.map((cells) => row(cells.map(inlines))),
  ].join('\n');

// The blocks of a text or of a list item. Two lists in a row with the same
// kind of marker would read as one, so every second one takes the other
// marker of its kind: * instead of -, ) instead of . after the number.
const sequence = (nodes: readonly Block[], gap: string): string => {
  const parts: string[] = [];
  let previous:
    { readonly ordered: boolean; readonly other: boolean } | undefined;
  for (const node of nodes) {
    if (node.kind === 'list') {
      const other = previous?.ordered === node.ordered && !previous.other;
      parts.push(list(node, other));
      previous = { ordered: node.ordered, other };
    } else {
      parts.push(
        node.kind === 'paragraph' ? paragraph(node.children) : single(node),
      );
      previous = undefined;
    }
  }
  return parts.join(gap);
};

function list(node: List, other: boolean): string {
  const gap = node.loose ? '\n\n' : '\n';
  return node.items
    .map((item, index) => {
      const marker = node.ordered
        ? `${String(node.start + index)}${other ? ')' : '.'} `
        : other
          ? '* '
          : '- ';
      return indent(sequence(item, gap), marker);
    })
    .join(gap);
}

// A heading or a table, which stand only at the top level.
const single = (node: Exclude<Block, List | { kind: 'paragraph' }>): string => {
  if (node.kind === 'table') return table(node);
  const text = inlines(node.children);
  const marks = '#'.repeat(node.level);
  return text === '' ? marks : `${marks} ${text}`;
};

/**
 * Writes the blocks of a text as Markdown, with one blank line between
 * blocks and a line break at the end; no blocks give an empty text.
 *
 * @param blocks - The tree of a checked text.
 * @returns The text that goes to ChurchTools.
 * @example
 * ```ts
 * serializeBlocks([{ kind: 'paragraph', children: [{ kind: 'text', text: '5 * 3' }] }]);
 * // '5 \\* 3\n'
 * ```
 */
export function serializeBlocks(blocks: readonly Block[]): string {
  return blocks.length === 0 ? '' : `${sequence(blocks, '\n\n')}\n`;
}
