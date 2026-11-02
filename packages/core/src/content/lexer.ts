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

const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

const isAsciiLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isHexDigit = (code: number): boolean =>
  isDigit(code) ||
  (code >= 0x41 && code <= 0x46) ||
  (code >= 0x61 && code <= 0x66);

// Whether a raw text holds a character reference such as &amp; or &#60;.
// The lexer decodes the numeric ones in its text and keeps the named ones,
// both for HTML, so a text with either does not say what a reader sees.
// HTML is not written, so a reference counts as HTML. The raw text is only
// read here, never written.
const hasCharacterReference = (raw: string): boolean => {
  let at = raw.indexOf('&');
  while (at !== -1) {
    let end = at + 1;
    if (raw.charCodeAt(end) === 0x23) {
      end += 1;
      const hex = raw.charCodeAt(end) === 0x78 || raw.charCodeAt(end) === 0x58;
      if (hex) end += 1;
      const digitsStart = end;
      while (
        end < raw.length &&
        (hex ? isHexDigit(raw.charCodeAt(end)) : isDigit(raw.charCodeAt(end)))
      ) {
        end += 1;
      }
      if (end > digitsStart && raw.charCodeAt(end) === 0x3b) return true;
    } else if (isAsciiLetter(raw.charCodeAt(end))) {
      while (
        end < raw.length &&
        (isAsciiLetter(raw.charCodeAt(end)) || isDigit(raw.charCodeAt(end)))
      ) {
        end += 1;
      }
      if (raw.charCodeAt(end) === 0x3b) return true;
    }
    at = raw.indexOf('&', at + 1);
  }
  return false;
};

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

// A mention, as the editor of ChurchTools writes one: a link to the view of
// a person (F21).
const isMention = (href: string): boolean =>
  href.includes('ctmd_layout=mention') || href.includes('PersonView');

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
  const found = new Set<ContentViolationKind>();

  const inlines = (tokens: readonly Token[], depth: number): Inline[] => {
    const nodes: Inline[] = [];
    const pushText = (value: string): void => {
      const last = nodes.at(-1);
      if (last?.kind === 'text') {
        nodes[nodes.length - 1] = { kind: 'text', text: last.text + value };
      } else {
        nodes.push({ kind: 'text', text: value });
      }
    };
    for (const token of tokens) {
      switch (token.type) {
        case 'text': {
          const node = token as Tokens.Text;
          if (node.tokens !== undefined) {
            for (const inner of inlines(node.tokens, depth)) {
              if (inner.kind === 'text') pushText(inner.text);
              else nodes.push(inner);
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
          const children = inlines(
            (token as Tokens.Strong | Tokens.Em).tokens,
            depth + 1,
          );
          nodes.push({
            kind: token.type === 'strong' ? 'strong' : 'emphasis',
            children,
          });
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

  const table = (token: Tokens.Table): Table => ({
    kind: 'table',
    align: token.align,
    header: token.header.map((entry) => cell(entry.tokens)),
    rows: token.rows.map((row) => row.map((entry) => cell(entry.tokens))),
  });

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

  let tokens: Token[];
  try {
    tokens = new Lexer(freshOptions()).lex(text);
  } catch {
    return { ok: false, violations: new Set(['unparsable']) };
  }
  const blocks: Block[] = [];
  for (const token of tokens) {
    if (token.type === 'space') continue;
    const node = block(token, 0);
    if (node !== undefined) blocks.push(node);
  }
  return found.size > 0
    ? { ok: false, violations: found }
    : { ok: true, blocks };
}
