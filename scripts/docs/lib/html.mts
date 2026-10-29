/**
 * Turns the HTML of a help page of the Academy into Markdown in the
 * simple form the docs index takes (ADR 0066): headings, paragraphs,
 * lists, tables with text in their cells, blocks and spans of code, and
 * links only as a path on the Academy. Images, videos, frames, figures
 * with their caption, scripts, styles, forms and navigation leave with
 * their content. Emphasis and quotes become plain text. No HTML stays,
 * and a link to any other host keeps only its text (ADR 0027).
 *
 * The parser is small on purpose and uses nothing but the language
 * (ADR 0020). It reads the HTML WordPress renders for a page, which is
 * well formed in practice, and recovers from the common gaps: a
 * paragraph, an item of a list or a cell of a table that is not closed.
 *
 * @packageDocumentation
 */
import {
  academyHost,
  cleanHosts,
  cleanLine,
  escapeMarkup,
  normalizeText,
  tidyLines,
} from './text.mts';

/** One element of the parsed page. */
interface Element {
  readonly tag: string;
  readonly href: string | undefined;
  readonly children: Node[];
}

type Node = Element | string;

// Elements that never have content.
const voidTags: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

// Elements whose content is raw text up to their end tag.
const rawTextTags: ReadonlySet<string> = new Set([
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
]);

// Elements that leave with all their content: media, embedded content,
// code of the page, forms and navigation (ADR 0027). A caption belongs
// to the figure it describes, which is mostly an image.
const droppedTags: ReadonlySet<string> = new Set([
  'area',
  'audio',
  'button',
  'canvas',
  'embed',
  'figcaption',
  'form',
  'head',
  'iframe',
  'img',
  'input',
  'link',
  'map',
  'math',
  'meta',
  'nav',
  'noembed',
  'noframes',
  'noscript',
  'object',
  'option',
  'param',
  'picture',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'track',
  'video',
  'xmp',
]);

// Elements that stand as blocks of their own. Every other element is
// read as part of a line of text.
const blockTags: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'center',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'html',
  'legend',
  'li',
  'main',
  'menu',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);

// A new block closes an open paragraph, as in HTML.
const closesParagraph: ReadonlySet<string> = new Set([
  ...[...blockTags].filter((tag) => tag !== 'li' && tag !== 'body'),
]);

/**
 * Parses HTML into a tree of elements and texts. Comments, declarations
 * and processing instructions leave, raw text elements keep no content.
 *
 * @param html - The HTML of a page.
 * @returns The root element.
 */
function parse(html: string): Element {
  const root: Element = { tag: '#root', href: undefined, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1] ?? root;
  const popTo = (index: number) => {
    stack.length = Math.max(1, index);
  };
  const lastIndexOf = (tags: readonly string[], stop: readonly string[]) => {
    for (let index = stack.length - 1; index > 0; index -= 1) {
      const tag = stack[index]?.tag ?? '';
      if (tags.includes(tag)) {
        return index;
      }
      if (stop.includes(tag)) {
        return -1;
      }
    }
    return -1;
  };

  let position = 0;
  while (position < html.length) {
    const open = html.indexOf('<', position);
    if (open === -1) {
      top().children.push(html.slice(position));
      break;
    }
    if (open > position) {
      top().children.push(html.slice(position, open));
    }
    position = open;
    if (html.startsWith('<!--', position)) {
      const end = html.indexOf('-->', position + 4);
      position = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<![CDATA[', position)) {
      const end = html.indexOf(']]>', position + 9);
      position = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[position + 1] === '!' || html[position + 1] === '?') {
      const end = html.indexOf('>', position);
      position = end === -1 ? html.length : end + 1;
      continue;
    }
    const tag = readTag(html, position);
    if (tag === undefined) {
      // A `<` that starts no tag is text.
      top().children.push('<');
      position += 1;
      continue;
    }
    position = tag.end;
    if (tag.closing) {
      const index = lastIndexOf([tag.name], []);
      if (index > 0) {
        popTo(index);
      }
      continue;
    }
    if (closesParagraph.has(tag.name)) {
      const index = lastIndexOf(['p'], ['td', 'th', 'li', 'table']);
      if (index > 0) {
        popTo(index);
      }
    }
    if (tag.name === 'li') {
      const index = lastIndexOf(['li'], ['ul', 'ol', 'menu']);
      if (index > 0) {
        popTo(index);
      }
    } else if (tag.name === 'dt' || tag.name === 'dd') {
      const index = lastIndexOf(['dt', 'dd'], ['dl']);
      if (index > 0) {
        popTo(index);
      }
    } else if (tag.name === 'tr') {
      const index = lastIndexOf(['tr'], ['table']);
      if (index > 0) {
        popTo(index);
      }
    } else if (tag.name === 'td' || tag.name === 'th') {
      const index = lastIndexOf(['td', 'th'], ['tr', 'table']);
      if (index > 0) {
        popTo(index);
      }
    }
    const element: Element = {
      tag: tag.name,
      href: tag.href,
      children: [],
    };
    top().children.push(element);
    if (rawTextTags.has(tag.name)) {
      const end = html.toLowerCase().indexOf(`</${tag.name}`, position);
      position =
        end === -1 ? html.length : html.indexOf('>', end) + 1 || html.length;
      continue;
    }
    if (!voidTags.has(tag.name) && !tag.selfClosing) {
      stack.push(element);
    }
  }
  return root;
}

interface Tag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly href: string | undefined;
  readonly end: number;
}

const tagName = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]{0,40})/;

// Reads one tag that starts at `start`, with its attribute href, quotes
// respected, up to its `>`.
function readTag(html: string, start: number): Tag | undefined {
  const head = tagName.exec(html.slice(start, start + 44));
  if (head === null) {
    return undefined;
  }
  const closing = head[1] === '/';
  const name = (head[2] ?? '').toLowerCase();
  let position = start + head[0].length;
  let href: string | undefined;
  let selfClosing = false;
  while (position < html.length) {
    const char = html[position] ?? '';
    if (char === '>') {
      return { name, closing, selfClosing, href, end: position + 1 };
    }
    if (/\s/.test(char)) {
      position += 1;
      continue;
    }
    if (char === '/') {
      selfClosing = html[position + 1] === '>';
      position += 1;
      continue;
    }
    let nameEnd = position;
    while (nameEnd < html.length && !/[\s/>=]/.test(html[nameEnd] ?? '')) {
      nameEnd += 1;
    }
    const attribute = html.slice(position, nameEnd).toLowerCase();
    position = nameEnd;
    while (/\s/.test(html[position] ?? '')) {
      position += 1;
    }
    let value: string | undefined;
    if (html[position] === '=') {
      position += 1;
      while (/\s/.test(html[position] ?? '')) {
        position += 1;
      }
      const quote = html[position];
      if (quote === '"' || quote === "'") {
        const end = html.indexOf(quote, position + 1);
        const stop = end === -1 ? html.length : end;
        value = html.slice(position + 1, stop);
        position = stop + 1;
      } else {
        let end = position;
        while (end < html.length && !/[\s>]/.test(html[end] ?? '')) {
          end += 1;
        }
        value = html.slice(position, end);
        position = end;
      }
    }
    if (attribute === 'href' && value !== undefined) {
      href = decodeEntities(value);
    }
  }
  return { name, closing, selfClosing, href, end: html.length };
}

// The entities WordPress writes by name; every other one it writes as a
// number. An unknown name stays as written.
const namedEntities: Readonly<Record<string, string>> = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  shy: '\u00ad',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  laquo: '\u00ab',
  raquo: '\u00bb',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  bull: '\u2022',
  middot: '\u00b7',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  euro: '\u20ac',
  times: '\u00d7',
  divide: '\u00f7',
  deg: '\u00b0',
  sect: '\u00a7',
  para: '\u00b6',
  auml: '\u00e4',
  ouml: '\u00f6',
  uuml: '\u00fc',
  Auml: '\u00c4',
  Ouml: '\u00d6',
  Uuml: '\u00dc',
  szlig: '\u00df',
  eacute: '\u00e9',
  egrave: '\u00e8',
  agrave: '\u00e0',
  aacute: '\u00e1',
  ccedil: '\u00e7',
  rarr: '\u2192',
  larr: '\u2190',
  harr: '\u2194',
  uarr: '\u2191',
  darr: '\u2193',
  thinsp: '\u2009',
  ensp: '\u2002',
  emsp: '\u2003',
  zwj: '\u200d',
  zwnj: '\u200c',
  lrm: '\u200e',
  rlm: '\u200f',
});

const entityPattern = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});/g;

/**
 * Decodes the character references of HTML: the names WordPress uses and
 * every number. A number outside Unicode or of a surrogate becomes the
 * replacement character, an unknown name stays as written.
 *
 * @param text - Text from HTML.
 * @returns The text with its characters.
 */
export function decodeEntities(text: string): string {
  return text.replace(entityPattern, (match: string, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : '\ufffd';
    }
    return namedEntities[body] ?? match;
  });
}

// Marks of a link inside the text until the end, so that the checks of
// the whole text cannot take the brackets of a link for anything else.
// They are control characters, which no cleaned text holds.
const linkStart = '\u0001';
const linkMiddle = '\u0002';
const linkEnd = '\u0003';

/**
 * The path of a help page of the Academy for a link, in the form the
 * docs index takes: on the host of the Academy, under `/de/`, with
 * percent-codes in lower case, an anchor only of lower-case letters,
 * digits, `_` and `-`, and without a query.
 *
 * @param url - The resolved target of a link.
 * @returns The path with its anchor, or `undefined` if the link may not stay.
 */
export function academyPathOf(url: URL): string | undefined {
  if (url.protocol !== 'https:' || url.host !== academyHost) {
    return undefined;
  }
  const path = url.pathname.replace(/%[0-9A-F]{2}/gi, (code) =>
    code.toLowerCase(),
  );
  if (!/^\/de\/(?:[a-z0-9%_-]+\/)*(?:[a-z0-9%_-]+\/?)?$/.test(path)) {
    return undefined;
  }
  const anchor = url.hash.slice(1);
  return /^[a-z0-9_-]{1,100}$/.test(anchor) ? `${path}#${anchor}` : path;
}

/**
 * Turns the HTML of a help page into Markdown in simple form.
 *
 * @param html - The rendered content of the page.
 * @param pageUrl - The address of the page, to resolve relative links.
 * @returns The Markdown, empty if the page holds no text.
 */
export function htmlToMarkdown(html: string, pageUrl: URL): string {
  const blocks = renderBlocks(parse(html), pageUrl);
  // The whole text runs through the same cleaning again: a host split
  // over two elements, such as `<b>name</b>.de`, is one only now.
  const text = escapeMarkup(cleanHosts(blocks.join('\n\n'), 'de'))
    .replaceAll('](', '] (')
    .replaceAll(`!${linkStart}`, `! ${linkStart}`)
    .replace(
      new RegExp(
        `${linkStart}([^${linkMiddle}]*)${linkMiddle}([^${linkEnd}]*)${linkEnd}`,
        'g',
      ),
      '[$1]($2)',
    );
  return tidyLines(text);
}

/**
 * Turns HTML of one line, such as the title of a page, into plain text.
 *
 * @param html - The HTML.
 * @returns The text, or `undefined` if nothing is left.
 */
export function htmlToLine(html: string): string | undefined {
  return cleanLine(decodeEntities(textOf(parse(html), true)), 'de');
}

// The text of an element and everything below it, without what leaves,
// for cells of tables, code and titles. A line break stays a line break
// unless `flat` is set.
function textOf(node: Node, flat: boolean): string {
  if (typeof node === 'string') {
    return node;
  }
  if (droppedTags.has(node.tag)) {
    return '';
  }
  if (node.tag === 'br') {
    return flat ? ' ' : '\n';
  }
  const inner = node.children.map((child) => textOf(child, flat)).join('');
  return blockTags.has(node.tag) || node.tag === 'td' || node.tag === 'th'
    ? ` ${inner} `
    : inner;
}

// Cleans a piece of text from the page: characters, hosts, and the
// brackets of Markdown, so that no text forms a link.
function cleanText(text: string): string {
  return cleanHosts(normalizeText(decodeEntities(text)), 'de').replace(
    /[[\]]/g,
    '\\$&',
  );
}

// Renders the content of an element as blocks of Markdown: lines of text
// between the blocks become paragraphs.
function renderBlocks(element: Element, pageUrl: URL): string[] {
  const blocks: string[] = [];
  let line = '';
  const flush = () => {
    const paragraph = paragraphOf(line);
    if (paragraph !== '') {
      blocks.push(paragraph);
    }
    line = '';
  };
  for (const child of element.children) {
    if (typeof child !== 'string' && droppedTags.has(child.tag)) {
      continue;
    }
    if (typeof child !== 'string' && blockTags.has(child.tag)) {
      flush();
      blocks.push(...renderBlock(child, pageUrl));
      continue;
    }
    line += inlineOf(child, pageUrl);
  }
  flush();
  return blocks;
}

// A paragraph: white space in a line as one space, line breaks from
// `<br>` kept, empty lines gone.
function paragraphOf(text: string): string {
  return text
    .split('\n')
    .map((part) => part.replace(/[ \t]+/g, ' ').trim())
    .filter((part) => part !== '')
    .join('\n');
}

function renderBlock(element: Element, pageUrl: URL): string[] {
  const heading = /^h([1-6])$/.exec(element.tag);
  if (heading !== null) {
    const text = paragraphOf(inlineOf(element, pageUrl)).replace(/\n/g, ' ');
    return text === '' ? [] : [`${'#'.repeat(Number(heading[1]))} ${text}`];
  }
  switch (element.tag) {
    case 'hr':
      return [];
    case 'pre':
      return codeBlock(element);
    case 'ul':
    case 'ol':
    case 'menu':
      return listOf(element, pageUrl);
    case 'table':
      return tableOf(element);
    default:
      return renderBlocks(element, pageUrl);
  }
}

// Text of an element inside a line, with links as marks.
function inlineOf(node: Node, pageUrl: URL): string {
  if (typeof node === 'string') {
    return cleanText(node).replace(/\s+/g, ' ');
  }
  if (droppedTags.has(node.tag)) {
    return '';
  }
  if (node.tag === 'br') {
    return '\n';
  }
  if (node.tag === 'code' || node.tag === 'kbd' || node.tag === 'samp') {
    return codeSpan(textOf(node, true));
  }
  const inner = node.children.map((child) => inlineOf(child, pageUrl)).join('');
  const spaced = blockTags.has(node.tag) ? ` ${inner} ` : inner;
  if (node.tag !== 'a' || node.href === undefined) {
    return spaced;
  }
  const text = inner.replace(/\s+/g, ' ').trim();
  const target = linkTarget(node.href, pageUrl);
  if (text === '' || target === undefined) {
    return spaced;
  }
  return `${linkStart}${text}${linkMiddle}${target}${linkEnd}`;
}

function linkTarget(href: string, pageUrl: URL): string | undefined {
  try {
    return academyPathOf(new URL(href.trim(), pageUrl));
  } catch {
    return undefined;
  }
}

// Code in a line, between as many backticks as it needs.
function codeSpan(raw: string): string {
  const code = cleanHosts(normalizeText(decodeEntities(raw)), 'de')
    .replace(/\s+/g, ' ')
    .trim();
  if (code === '') {
    return '';
  }
  const longest = Math.max(
    0,
    ...[...code.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  const pad = code.startsWith('`') || code.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

// A block of code between fences longer than any run of backticks in it.
function codeBlock(element: Element): string[] {
  const code = tidyLines(
    cleanHosts(
      normalizeText(
        decodeEntities(
          element.children.map((child) => textOf(child, false)).join(''),
        ),
      ),
      'de',
    ),
  );
  if (code === '') {
    return [];
  }
  const longest = Math.max(
    2,
    ...[...code.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return [`${fence}\n${code}\n${fence}`];
}

function listOf(element: Element, pageUrl: URL): string[] {
  const ordered = element.tag === 'ol';
  const items: string[] = [];
  let number = 1;
  for (const child of element.children) {
    if (typeof child === 'string') {
      continue;
    }
    if (child.tag !== 'li') {
      // Content between the items, such as a nested list without its own
      // item, joins the last item.
      if (blockTags.has(child.tag) && !droppedTags.has(child.tag)) {
        const nested = renderBlock(child, pageUrl).join('\n');
        if (nested !== '') {
          items.push(indent(nested, ordered ? 3 : 2));
        }
      }
      continue;
    }
    const content = renderBlocks(child, pageUrl).join('\n');
    if (content === '') {
      continue;
    }
    const marker = ordered ? `${String(number)}. ` : '- ';
    number += 1;
    items.push(`${marker}${indent(content, marker.length).trimStart()}`);
  }
  return items.length === 0 ? [] : [items.join('\n')];
}

function indent(text: string, width: number): string {
  const pad = ' '.repeat(width);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${pad}${line}`))
    .join('\n');
}

// A table of text: each cell one line, `|` protected, the first row as
// head, every row as wide as the widest.
function tableOf(element: Element): string[] {
  const rows: string[][] = [];
  const visit = (node: Element) => {
    for (const child of node.children) {
      if (typeof child === 'string' || droppedTags.has(child.tag)) {
        continue;
      }
      if (child.tag === 'tr') {
        const cells = child.children
          .filter(
            (cell): cell is Element =>
              typeof cell !== 'string' &&
              (cell.tag === 'td' || cell.tag === 'th'),
          )
          .map((cell) =>
            cleanText(textOf(cell, true))
              .replace(/\s+/g, ' ')
              .trim()
              .replaceAll('|', '\\|'),
          );
        if (cells.some((cell) => cell !== '')) {
          rows.push(cells);
        }
      } else if (child.tag !== 'table') {
        visit(child);
      }
    }
  };
  visit(element);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) {
    return [];
  }
  const line = (cells: readonly string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  const [head = [], ...body] = rows;
  return [
    [
      line(head),
      line(Array.from({ length: width }, () => '---')),
      ...body.map(line),
    ].join('\n'),
  ];
}
