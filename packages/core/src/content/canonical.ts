/**
 * The canonical form of a text, over which the check code of the marking
 * is taken (ADR 0032).
 *
 * Where it stands in the way of a write: when the core adds a section to
 * the wiki, it takes the check code over the canonical form of what it
 * writes, and when it reads a page, over the canonical form of each part
 * of the page that could be the section. Both read the text into its
 * blocks of the top level with the lexer of the content policy and write
 * the blocks with its serializer, with every run of spaces and line breaks
 * in a text as one space. So the signs before the items of a list, blank
 * lines, the alignment of a table and how the lines of a paragraph are
 * broken do not count, as the web editor of ChurchTools changes such
 * things when it saves a page (F13). Text, headings, emphasis and the
 * build of lists and tables count.
 *
 * Only the form counts here, not what a reader sees: a section a person
 * changed may hold contact data the policy does not list. A block with
 * anything outside the allowed part has no canonical form, such as a link
 * the editor made from a bare address or a hard line break. Unlike the
 * check of the content policy, the canonical form keeps the text as it
 * stands, without NFKC and with hidden signs, so that a mark that turns
 * the direction of a number or a raised two a person puts in changes the
 * code. Ecclium writes neither. A protected space counts as a space.
 *
 * @packageDocumentation
 */
import { readTopLevel, type TopLevelPart } from './lexer.js';
import { hasTooManyDelimiters, maxContentBytes } from './normalize.js';
import { serializeBlocks } from './serialize.js';
import type { Block, Inline, List } from './tree.js';

/** A block of the top level of a page, for the sections of the marking. */
export interface CanonicalPart {
  /** A blank line, a paragraph, a block of HTML or another block. */
  readonly type: TopLevelPart['type'];
  /** How many line breaks it holds, to find its lines in the page. */
  readonly breaks: number;
  /** For a paragraph on one line, that line as it stands, to read a marking. */
  readonly line: string | undefined;
  /** Its block, when it is in the allowed part: then it can be part of a section of Ecclium. */
  readonly node: Block | undefined;
  /**
   * Whether it is or holds HTML other than a closed comment, with which a
   * browser could hide what follows, such as an open `<details>`.
   */
  readonly hides: boolean;
}

// A block of HTML that is one comment and nothing else.
const isComment = (source: string): boolean => {
  const text = source.trim();
  return (
    text.startsWith('<!--') &&
    text.endsWith('-->') &&
    text.indexOf('-->') === text.length - 3
  );
};

/**
 * Reads a page into its blocks of the top level for the sections of the
 * marking.
 *
 * @param text - The text of a page; a carriage return before a line break
 *   is dropped.
 * @returns The parts in the order of the page, or undefined when the text
 *   is too long, has too many signs of emphasis, holds a lone surrogate or
 *   another carriage return, or the lexer fails: then no section of the
 *   page counts as Ecclium's own.
 * @example
 * ```ts
 * canonicalPartsOf('# Plan\n\nText\n').map((part) => part.type); // ['other', 'space', 'paragraph']
 * ```
 */
export function canonicalPartsOf(
  text: string,
): readonly CanonicalPart[] | undefined {
  const source = text.replaceAll('\r\n', '\n');
  if (
    source.includes('\r') ||
    !source.isWellFormed() ||
    new TextEncoder().encode(source).byteLength > maxContentBytes ||
    hasTooManyDelimiters(source)
  ) {
    return undefined;
  }
  const parts = readTopLevel(source);
  // The parts cover the text exactly, or their lines cannot be found.
  if (
    parts === undefined ||
    parts.map((part) => part.source).join('') !== source
  ) {
    return undefined;
  }
  return Object.freeze(
    parts.map((part) => {
      const line = part.source.trimEnd();
      return Object.freeze({
        type: part.type,
        breaks: part.source.split('\n').length - 1,
        line:
          part.type === 'paragraph' && !line.includes('\n') ? line : undefined,
        node: part.node,
        hides: part.type === 'html' ? !isComment(part.source) : part.markup,
      });
    }),
  );
}

// A run of text with every run of spaces and line breaks as one space, as
// a reader sees it, inside bold and italic as well.
const spaced = (nodes: readonly Inline[]): Inline[] =>
  nodes.map((node) =>
    node.kind === 'text'
      ? { kind: 'text', text: node.text.split(/\s+/u).join(' ') }
      : { kind: node.kind, children: spaced(node.children) },
  );

const spacedList = (list: List): List => ({
  ...list,
  items: list.items.map((item) =>
    item.map((inner) =>
      inner.kind === 'list'
        ? spacedList(inner)
        : { ...inner, children: spaced(inner.children) },
    ),
  ),
});

/**
 * Writes blocks in their canonical form.
 *
 * @param blocks - The blocks of a section, such as the nodes of
 *   {@link canonicalPartsOf}.
 * @returns The canonical form.
 * @example
 * ```ts
 * canonicalFormOf([{ kind: 'paragraph', children: [{ kind: 'text', text: 'Eine\nZeile' }] }]);
 * // 'Eine Zeile\n'
 * ```
 */
export function canonicalFormOf(blocks: readonly Block[]): string {
  return serializeBlocks(
    blocks.map((block): Block => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return { ...block, children: spaced(block.children) };
        case 'list':
          return spacedList(block);
        case 'table':
          return {
            ...block,
            header: block.header.map(spaced),
            rows: block.rows.map((cells) => cells.map(spaced)),
          };
      }
    }),
  );
}

/**
 * Gives the canonical form of a text, such as a section Ecclium writes.
 *
 * @param markdown - The text.
 * @returns The canonical form, or undefined when a block of it has none.
 * @example
 * ```ts
 * canonicalMarkdown('# Plan\n\n* Probe\n* Pause'); // '# Plan\n\n- Probe\n- Pause\n'
 * canonicalMarkdown('Eine\nZeile'); // 'Eine Zeile\n'
 * canonicalMarkdown('Mehr: [https://example.org/](https://example.org/)'); // undefined
 * ```
 */
export function canonicalMarkdown(markdown: string): string | undefined {
  const parts = canonicalPartsOf(markdown);
  if (parts === undefined) return undefined;
  const blocks: Block[] = [];
  for (const part of parts) {
    if (part.type === 'space') continue;
    if (part.node === undefined) return undefined;
    blocks.push(part.node);
  }
  return canonicalFormOf(blocks);
}
