import fc from 'fast-check';
import MarkdownIt, { type Token } from 'markdown-it';
import { describe, expect, it } from 'vitest';

import { checkMarkdown } from './check.js';
import { readMarkdown } from './lexer.js';
import { contactKeyOf } from './scan.js';
import type { Block, Inline } from './tree.js';

// The differential test of the content policy (ADR 0030): a second parser,
// which ChurchTools could as well show Markdown with, reads every text the
// policy lets pass. It must find only nodes of the allowed part and the
// same text a reader sees as the lexer of the policy. markdown-it reads
// HTML and turns bare web addresses into links here, even domains without
// a scheme, so that it finds what a careless renderer would show. It is a
// tool of development only and never ships (place contentDifferential).

const seed = 30_011;
const run = { seed, numRuns: 400 };

const parser = new MarkdownIt('default', { html: true, linkify: true });
// Links also for a domain without a scheme or www., as some renderers do.
parser.linkify.set({ fuzzyLink: true, fuzzyEmail: true });

// The tokens of markdown-it a text of the allowed part may give.
const allowed = new Set([
  'paragraph_open',
  'paragraph_close',
  'heading_open',
  'heading_close',
  'inline',
  'text',
  'softbreak',
  'strong_open',
  'strong_close',
  'em_open',
  'em_close',
  'bullet_list_open',
  'bullet_list_close',
  'ordered_list_open',
  'ordered_list_close',
  'list_item_open',
  'list_item_close',
  'table_open',
  'table_close',
  'thead_open',
  'thead_close',
  'tbody_open',
  'tbody_close',
  'tr_open',
  'tr_close',
  'th_open',
  'th_close',
  'td_open',
  'td_close',
]);

interface SecondReading {
  readonly types: readonly string[];
  readonly links: readonly string[];
  readonly text: string;
}

// Every token type, the target of every link and the text a reader sees.
const secondReading = (markdown: string): SecondReading => {
  const types: string[] = [];
  const links: string[] = [];
  let text = '';
  const visit = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      types.push(token.type);
      if (token.type === 'link_open') {
        links.push(String(token.attrGet('href') ?? ''));
      }
      if (token.type === 'text') text += token.content;
      // A line break and the end of a block are a space to a reader.
      if (token.type === 'softbreak' || (token.block && token.nesting === -1)) {
        text += ' ';
      }
      visit(token.children ?? []);
    }
  };
  visit(parser.parse(markdown, {}));
  return { types, links, text };
};

const plain = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) => (node.kind === 'text' ? node.text : plain(node.children)))
    .join('');

const readable = (blocks: readonly Block[]): string =>
  blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return plain(block.children);
        case 'list':
          return block.items.map(readable).join(' ');
        case 'table':
          return [...block.header, ...block.rows.flat()].map(plain).join(' ');
      }
    })
    .join(' ');

const squeeze = (value: string): string =>
  value.replaceAll(/\s+/gu, ' ').trim();

// Asserts what the second parser finds in a text the policy wrote.
const expectAllowed = (
  written: string,
  mailto: ReadonlySet<string> = new Set(),
): void => {
  const second = secondReading(written);
  const outside = second.types.filter(
    (type) =>
      !allowed.has(type) && type !== 'link_open' && type !== 'link_close',
  );
  expect(outside).toEqual([]);
  for (const href of second.links) {
    // Only an e-mail address the policy lists, which a renderer may link.
    expect(href.startsWith('mailto:')).toBe(true);
    expect(mailto.has(href.slice('mailto:'.length).toLowerCase())).toBe(true);
  }
  const read = readMarkdown(written);
  expect(read.ok).toBe(true);
  if (!read.ok) return;
  expect(squeeze(second.text)).toBe(squeeze(readable(read.blocks)));
};

const options = { contacts: new Set<string>() };

describe('the differential test with markdown-it', () => {
  it('finds HTML, links and images in what the content policy refuses', () => {
    // The counter-check: the second parser sees what it is asked to find.
    for (const [markdown, type] of [
      ['<b>x</b>', 'html_inline'],
      ['<div>x</div>', 'html_block'],
      ['[x](https://example.org)', 'link_open'],
      ['Mehr unter example.org', 'link_open'],
      ['![x](https://example.org/b.png)', 'image'],
      ['`x`', 'code_inline'],
    ] as const) {
      expect(secondReading(markdown).types).toContain(type);
      expect(checkMarkdown(markdown, options).ok).toBe(false);
    }
  });

  it('finds only the allowed part in a written report', () => {
    const report = checkMarkdown(
      '# Dienstplan\n\nAm **Sonntag** spielt *Max*, 5 * 3 = 15.\n\n1. Probe\n2. Gottesdienst\n   - Musik\n\n| Tag | Dienst |\n|:--|--:|\n| So | Technik \\| Licht |',
      options,
    );
    expect(report.ok).toBe(true);
    if (report.ok) expectAllowed(report.text);
  });

  it('finds a listed e-mail address at most as a link to it', () => {
    const address = 'sekretariat@example.org';
    const contacts = new Set([contactKeyOf(address) as string]);
    const result = checkMarkdown(`Fragen an ${address}.`, { contacts });
    expect(result.ok).toBe(true);
    if (result.ok) expectAllowed(result.text, new Set([address]));
  });

  it('finds only the allowed part in every generated text that passes', () => {
    const signs = [
      ...Array.from('aZäß09 '),
      ...Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'),
      '\n',
    ];
    const raw = fc.string({ unit: fc.constantFrom(...signs), maxLength: 80 });
    const word = fc.stringMatching(/^[a-zA-Zäö]{1,8}$/u);
    const piece = fc.oneof(
      raw,
      word,
      word.map((value) => `**${value}**`),
      word.map((value) => `_${value}_`),
      fc.constantFrom('- ', '1. ', '# ', '| a |\n|---|\n| b |', '\n\n', '\n'),
    );
    const markdown = fc
      .array(piece, { minLength: 1, maxLength: 8 })
      .map((pieces) => pieces.join(''));
    fc.assert(
      fc.property(markdown, (value) => {
        const result = checkMarkdown(value, options);
        if (result.ok) expectAllowed(result.text);
      }),
      run,
    );
  });
});
