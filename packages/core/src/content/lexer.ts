/**
 * Reads a text as Markdown with the lexer of `marked` and turns it into
 * the tree of the content policy, or names why it cannot (ADR 0030).
 *
 * Where it stands in the way of a write: right after the normal form,
 * before the checks of what a reader sees. Only the tokens of the allowed
 * part become nodes of the tree. Every other token is a reason to refuse
 * the text, and the content policy never drops one silently: HTML,
 * images, links of any kind, references and their definitions, mentions,
 * code, quotes, rules, hard line breaks, struck text and task lists.
 *
 * This is the only module that imports `marked` (place `contentLexer`).
 * It builds a lexer with complete options for every text, never through
 * `marked.use` or `setOptions`, which change the state of the module, and
 * never with the options of an earlier call, which the lexer changes.
 *
 * @packageDocumentation
 */
import { Lexer, type Token, type Tokens } from 'marked';

import type {
  Block,
  Cell,
  Heading,
  Inline,
  List,
  ListItem,
  Paragraph,
  Table,
} from './tree.js';
import { hasCharacterReference } from './scan.js';
import { maxInlineDepth, maxListDepth } from './tree.js';
import type { ContentViolationKind } from './violations.js';

/** What {@link readMarkdown} gives: the tree, or why the text has none. */
export type ReadMarkdown =
  | { readonly ok: true; readonly blocks: readonly Block[] }
  | {
      readonly ok: false;
      readonly violations: ReadonlySet<ContentViolationKind>;
    };

// The options of one call, new each time: the lexer stores its tokenizer
// in the object it gets. GFM is on for tables; it also reads bare web
// addresses as links, which the content policy then refuses.
const freshOptions = () => ({
  async: false,
  breaks: false,
  extensions: null,
  gfm: true,
  hooks: null,
  pedantic: false,
  renderer: null,
  silent: false,
  tokenizer: null,
  walkTokens: null,
});

// The highest number a list of CommonMark can carry: nine digits.
const maxListNumber = 999_999_999;

const isBlank = (code: number): boolean => code === 0x20 || code === 0x09;

// Spaces and tabs around a line break mean nothing to a reader, and two
// spaces before one would read as a hard break, so they go.
const tidyLineBreaks = (text: string): string => {
  let tidy = '';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) {
      let end = tidy.length;
      while (end > 0 && isBlank(tidy.charCodeAt(end - 1))) end -= 1;
      tidy = `${tidy.slice(0, end)}\n`;
      while (isBlank(text.charCodeAt(index + 1))) index += 1;
      continue;
    }
    tidy += text.charAt(index);
  }
  return tidy;
};

// Adds a node to a run of inline nodes. Text right after text becomes one
// text, and bold right after bold one bold part, also inside: a reader sees
// the same, and written as one it leaves no run of four asterisks, which
// parsers of Markdown read in different ways.
const appendInline = (nodes: Inline[], node: Inline): void => {
  const last = nodes.at(-1);
  if (last?.kind === 'text' && node.kind === 'text') {
    nodes[nodes.length - 1] = { kind: 'text', text: last.text + node.text };
    return;
  }
  if (
    last !== undefined &&
    last.kind !== 'text' &&
    node.kind !== 'text' &&
    last.kind === node.kind
  ) {
    const children = [...last.children];
    for (const child of node.children) appendInline(children, child);
    nodes[nodes.length - 1] = { kind: node.kind, children };
    return;
  }
  nodes.push(node);
};

// The cells of one line of a table: one more than its bars that no
// backslash escapes, without a bar at either end.
const cellsOf = (line: string): number => {
  const row = line.trim();
  let bars = 0;
  let trailing = 0;
  let backslashes = 0;
  for (let index = 0; index < row.length; index += 1) {
    const code = row.charCodeAt(index);
    if (code === 0x7c && backslashes % 2 === 0) {
      bars += 1;
      trailing = index === row.length - 1 ? 1 : 0;
    }
    backslashes = code === 0x5c ? backslashes + 1 : 0;
  }
  const leading = row.startsWith('|') ? 1 : 0;
  return bars + 1 - leading - trailing;
};

// Whether a row of a table has more cells than its header. The lexer fits
// every row to the width of the header and drops the cells beyond it, so
// their text would never be checked although a reader of the raw text
// sees it. The raw text is only read here, never written.
const hasWideRow = (raw: string, width: number): boolean =>
  raw
    .split('\n')
    .slice(2)
    .some((line) => line.trim() !== '' && cellsOf(line) > width);

// A mention, as the editor of ChurchTools writes one: a link to the view of
// a person (F21).
const isMention = (href: string): boolean =>
  href.includes('ctmd_layout=mention') || href.includes('PersonView');

// Reads one token of the top level into a node of the tree, recording
// every reason to refuse it in `found` and in `markup` whether it holds
// HTML, as a block or inside a text.
const readToken = (
  token: Token,
  found: Set<ContentViolationKind>,
  markup: { value: boolean },
): Block | undefined => {
  const inlines = (tokens: readonly Token[], depth: number): Inline[] => {
    const nodes: Inline[] = [];
    const pushText = (value: string): void => {
      appendInline(nodes, { kind: 'text', text: value });
    };
    for (const token of tokens) {
      switch (token.type) {
        case 'text': {
          const node = token as Tokens.Text;
          if (node.tokens !== undefined) {
            for (const inner of inlines(node.tokens, depth)) {
              appendInline(nodes, inner);
            }
          } else if (hasCharacterReference(node.raw)) {
            found.add('html');
          } else {
            pushText(node.text);
          }
          break;
        }
        case 'escape':
          pushText((token as Tokens.Escape).text);
          break;
        case 'strong':
        case 'em': {
          if (depth >= maxInlineDepth) {
            found.add('tooDeep');
            break;
          }
          const kind = token.type === 'strong' ? 'strong' : 'emphasis';
          // Bold inside bold is bold: its parts join the outer one, so no
          // run of four asterisks is written.
          const children: Inline[] = [];
          for (const child of inlines(
            (token as Tokens.Strong | Tokens.Em).tokens,
            depth + 1,
          )) {
            if (child.kind === kind) {
              for (const part of child.children) appendInline(children, part);
            } else {
              appendInline(children, child);
            }
          }
          appendInline(nodes, { kind, children });
          break;
        }
        case 'link': {
          const link = token as Tokens.Link;
          // A bare web address or e-mail address that GFM reads as a link
          // is text the author wrote, not a link: the checks of what a
          // reader sees decide about it, so that an address the policy
          // lists can stand. Its text is literal, without references.
          if (link.autolink === true) pushText(link.text);
          else found.add(isMention(link.href) ? 'mention' : 'link');
          break;
        }
        case 'image':
          found.add('image');
          break;
        case 'html':
          found.add('html');
          markup.value = true;
          break;
        default:
          // codespan, br, del, checkbox and anything a later version of the
          // lexer adds.
          found.add('unsupported');
      }
    }
    return nodes.map((node) =>
      node.kind === 'text'
        ? { kind: 'text', text: tidyLineBreaks(node.text) }
        : node,
    );
  };

  // Spaces at the edges of a heading, paragraph or cell mean nothing to a
  // reader.
  const trimmed = (nodes: Inline[]): readonly Inline[] => {
    const first = nodes[0];
    if (first?.kind === 'text') {
      nodes[0] = { kind: 'text', text: first.text.trimStart() };
    }
    const last = nodes.at(-1);
    if (last?.kind === 'text') {
      nodes[nodes.length - 1] = { kind: 'text', text: last.text.trimEnd() };
    }
    return nodes.filter((node) => node.kind !== 'text' || node.text !== '');
  };

  const flat = (nodes: readonly Inline[]): readonly Inline[] =>
    nodes.map((node) =>
      node.kind === 'text'
        ? { kind: 'text', text: node.text.replaceAll('\n', ' ') }
        : { kind: node.kind, children: flat(node.children) },
    );

  const paragraph = (tokens: readonly Token[]): Paragraph => ({
    kind: 'paragraph',
    children: trimmed(inlines(tokens, 0)),
  });

  const list = (token: Tokens.List, depth: number): List | undefined => {
    if (depth >= maxListDepth) {
      found.add('tooDeep');
      return undefined;
    }
    const start = token.ordered && token.start !== '' ? token.start : 1;
    if (start + token.items.length - 1 > maxListNumber) {
      found.add('unsupported');
      return undefined;
    }
    const items = token.items.map((item): ListItem => {
      if (item.task) found.add('unsupported');
      const blocks: (Paragraph | List)[] = [];
      for (const inner of item.tokens) {
        // A tight item holds a block of text whose inline tokens the
        // lexer fills in, a loose one paragraphs.
        if (inner.type === 'text') {
          blocks.push(paragraph([inner]));
        } else if (inner.type === 'paragraph') {
          blocks.push(paragraph((inner as Tokens.Paragraph).tokens));
        } else if (inner.type === 'list') {
          const nested = list(inner as Tokens.List, depth + 1);
          if (nested !== undefined) blocks.push(nested);
        } else if (inner.type !== 'space' && inner.type !== 'checkbox') {
          block(inner, depth + 1);
        }
      }
      return blocks;
    });
    return {
      kind: 'list',
      ordered: token.ordered,
      start,
      loose: token.loose,
      items,
    };
  };

  const cell = (tokens: readonly Token[]): Cell =>
    flat(trimmed(inlines(tokens, 0)));

  const table = (token: Tokens.Table): Table => {
    if (hasWideRow(token.raw, token.header.length)) found.add('unsupported');
    return {
      kind: 'table',
      align: token.align,
      header: token.header.map((entry) => cell(entry.tokens)),
      rows: token.rows.map((row) => row.map((entry) => cell(entry.tokens))),
    };
  };

  // A block of the top level, or a block inside a list item that is not
  // allowed there: its reason is recorded and it has no node.
  function block(token: Token, depth: number): Block | undefined {
    switch (token.type) {
      case 'heading': {
        const node = token as Tokens.Heading;
        const heading: Heading = {
          kind: 'heading',
          level: node.depth as Heading['level'],
          children: flat(trimmed(inlines(node.tokens, 0))),
        };
        if (depth > 0) found.add('unsupported');
        return heading;
      }
      case 'paragraph':
        return paragraph((token as Tokens.Paragraph).tokens);
      case 'list':
        return list(token as Tokens.List, depth);
      case 'table':
        if (depth > 0) found.add('unsupported');
        return table(token as Tokens.Table);
      case 'html':
        found.add('html');
        markup.value = true;
        return undefined;
      case 'def':
        found.add('reference');
        return undefined;
      default:
        // code, blockquote, hr and anything a later version adds, such as
        // a block of text outside a list item.
        found.add('unsupported');
        return undefined;
    }
  }

  return block(token, 0);
};

/** One block of the top level of a text, as the lexer read it. */
export interface TopLevelPart {
  /** A blank line, a paragraph, a block of HTML or another block. */
  readonly type: 'space' | 'paragraph' | 'html' | 'other';
  /**
   * The text of the part as it stands in the source, to find its lines
   * and to read a line of the marking (ADR 0032). It is only read, never
   * written: what Ecclium writes comes from the tree alone.
   */
  readonly source: string;
  /** Its node of the tree, or undefined for a blank line and a part with a reason. */
  readonly node: Block | undefined;
  /** Every reason to refuse it. */
  readonly violations: ReadonlySet<ContentViolationKind>;
  /** Whether it is HTML or holds some, which a browser could use to hide what follows. */
  readonly markup: boolean;
}

const typeOf = (token: Token): TopLevelPart['type'] =>
  token.type === 'space' || token.type === 'paragraph' || token.type === 'html'
    ? token.type
    : 'other';

/**
 * Reads a text as Markdown into its blocks of the top level, each with
 * its node or its reasons. The check code of the marking takes the
 * sections of a page from them (ADR 0032).
 *
 * @param text - A text with line breaks as `\n`.
 * @returns The parts in the order of the text, or undefined when the
 *   lexer fails.
 * @example
 * ```ts
 * readTopLevel('# Plan\n\nText').map((part) => part.type); // ['other', 'space', 'paragraph']
 * ```
 */
export function readTopLevel(
  text: string,
): readonly TopLevelPart[] | undefined {
  let tokens: Token[];
  try {
    tokens = new Lexer(freshOptions()).lex(text);
  } catch {
    return undefined;
  }
  return tokens.map((token) => {
    const found = new Set<ContentViolationKind>();
    const markup = { value: false };
    const node =
      token.type === 'space' ? undefined : readToken(token, found, markup);
    return {
      type: typeOf(token),
      source: token.raw,
      node: found.size > 0 ? undefined : node,
      violations: found,
      markup: markup.value,
    };
  });
}

/**
 * Reads a text in its normal form as Markdown.
 *
 * @param text - The text after {@link normalizeContent}.
 * @returns The tree of the allowed part, or every reason found to refuse
 *   the text; `unparsable` alone when the lexer fails, for example on
 *   lists so deep that its stack runs out.
 * @example
 * ```ts
 * readMarkdown('# Plan\n\n- Probe');
 * // { ok: true, blocks: [{ kind: 'heading', level: 1, ... }, { kind: 'list', ... }] }
 * readMarkdown('![x](https://example.org/x.png)');
 * // { ok: false, violations: Set { 'image' } }
 * ```
 */
export function readMarkdown(text: string): ReadMarkdown {
  const parts = readTopLevel(text);
  if (parts === undefined) {
    return { ok: false, violations: new Set(['unparsable']) };
  }
  const found = new Set<ContentViolationKind>();
  const blocks: Block[] = [];
  for (const part of parts) {
    for (const violation of part.violations) found.add(violation);
    if (part.node !== undefined) blocks.push(part.node);
  }
  return found.size > 0
    ? { ok: false, violations: found }
    : { ok: true, blocks };
}
