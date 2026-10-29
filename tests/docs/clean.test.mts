// Tests of the cleaning of texts and of the conversion of HTML for
// pnpm docs:refresh (ADR 0066). The checks of the docs index only refuse,
// so these tests hold the refresh to them: every cleaned text passes the
// check of the hosts and of markup in the package. Every host under
// church.tools and every invisible character is built at run time, so
// that neither gitleaks nor a reader of this file meets one.
import {
  findForeignHosts,
  hasHtmlTag,
} from '@ecclium/mcp-churchtools-docs-index';
import { describe, expect, it } from 'vitest';

import {
  academyPathOf,
  decodeEntities,
  htmlToLine,
  htmlToMarkdown,
} from '../../scripts/docs/lib/html.mts';
import {
  cleanBlock,
  cleanHosts,
  cleanLine,
  escapeMarkup,
  normalizeText,
  removalNotes,
} from '../../scripts/docs/lib/text.mts';

const char = (code: number): string => String.fromCodePoint(code);
const hosted = (label: string): string => [label, 'church', 'tools'].join('.');
const page = new URL('https://churchtools.academy/de/help/gruppen/eine-seite/');

const softHyphen = char(0xad);
const zeroWidth = char(0x200b);
const bidi = char(0x202e);
const tag = char(0xe0041);
const privateUse = char(0xe000);
const lone = String.fromCharCode(0xd800);
const bell = char(0x07);

// Texts that hide hosts, addresses and markup in many ways. Each must
// come out of the cleaning without anything the checks refuse.
const hostile: readonly string[] = [
  `Siehe https://${hosted('demo-tenant')}/?q=churchdb#/persons`,
  `Login unter ${hosted('meine-gemeinde')} oder ${hosted('www')}`,
  'Mehr auf https://www.example.com/x und http:other.example.net/y.',
  'Ohne Schema: www.example.app, shop.example.de und example.io/a',
  'Kontakt: someone@example.com, mailto:x@sub.example.net oder max.mustermann@example.org',
  'Als Pfad: //cdn.example.com/lib.js und https://[2001:db8::1]/x',
  'IPv4: 192.168.1.10 und 10.0.0.1, aber Version 3.138.0 bleibt',
  `Breite Punkte: example${char(0x3002)}com und ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ`,
  `Code: <div class="a">x</div> und <https://example.org/a> und <!-- c --> und <?x?>`,
  'Bild: ![alt](https://example.com/b.png) und [Link](https://example.com/c)',
  `Unsichtbar: a${softHyphen}b${zeroWidth}c${bidi}d${tag}e${privateUse}f${lone}g${bell}h`,
  `Gemischt: https:${hosted('x')}, ftp://files.example.at/a und wss://example.li`,
  'Escape: example\\.com und https:\\\\example.com\\x',
];

describe('normalizeText', () => {
  it('removes control and invisible characters and keeps line breaks and tabs', () => {
    expect(
      normalizeText(
        `a${softHyphen}b${zeroWidth}c${bidi}d${tag}e${privateUse}f${lone}g${bell}\th\r\ni\rj`,
      ),
    ).toBe('abcdefg\th\ni\nj');
  });

  it('folds letters and dots of full width and line separators', () => {
    expect(normalizeText(`ｗｗｗ．a${char(0x3002)}b${char(0x2028)}c`)).toBe(
      'www.a.b\nc',
    );
  });
});

describe('cleanHosts', () => {
  const notes = removalNotes.de;

  it('gives an instance under church.tools the placeholder and keeps the path', () => {
    expect(cleanHosts(`https://${hosted('demo-tenant')}/a/b?c#d`, 'de')).toBe(
      'https://example.church.tools/a/b?c#d',
    );
    expect(cleanHosts(`Name: ${hosted('demo-tenant')}.`, 'de')).toBe(
      'Name: example.church.tools.',
    );
  });

  it('removes the hosts of the vendor under church.tools and every other host', () => {
    expect(cleanHosts(`https://${hosted('www')}/`, 'de')).toBe(notes.link);
    expect(cleanHosts(hosted('forum'), 'de')).toBe(notes.link);
    expect(cleanHosts('Siehe https://example.com/x.', 'de')).toBe(
      `Siehe ${notes.link}.`,
    );
    expect(cleanHosts('https:example.com', 'de')).toBe(notes.link);
    expect(cleanHosts('www.example.app', 'de')).toBe(notes.link);
    expect(cleanHosts('example.de', 'en')).toBe(removalNotes.en.link);
  });

  it('keeps the Academy, the placeholder and paths of fields', () => {
    const kept = [
      'https://churchtools.academy/de/help/wiki/',
      'https://example.church.tools/api',
      'example.church.tools',
      'group.name und person.firstName',
      'max.mustermann@example.org',
      'Version 3.138.0',
    ];
    for (const text of kept) {
      expect(cleanHosts(text, 'de')).toBe(text);
    }
  });

  it('removes e-mail addresses, IPv4 addresses and links that start with //', () => {
    expect(cleanHosts('an someone@example.com schreiben', 'de')).toBe(
      `an ${notes.mail} schreiben`,
    );
    expect(cleanHosts('Server 192.168.1.10', 'de')).toBe(`Server ${notes.ip}`);
    expect(cleanHosts('Quelle //cdn.example.com/a.js', 'de')).toBe(
      `Quelle ${notes.link}`,
    );
  });

  it.each(hostile)('leaves no host the check refuses in %s', (text) => {
    expect(findForeignHosts(cleanLine(text, 'de') ?? '')).toEqual([]);
    expect(findForeignHosts(cleanBlock(text, 'en') ?? '')).toEqual([]);
  });
});

describe('escapeMarkup', () => {
  it('turns every start of a tag into &lt; and keeps other signs', () => {
    expect(
      escapeMarkup('<div> </p> <!-- x --> <?php <https://x a < b <= c'),
    ).toBe('&lt;div> &lt;/p> &lt;!-- x --> &lt;?php &lt;https://x a < b <= c');
  });

  it('breaks images and definitions of links', () => {
    expect(escapeMarkup('![x](y)')).toBe('! [x](y)');
    expect(escapeMarkup('  [ref]: /x')).toBe('  [ref] : /x');
  });

  it.each(hostile)('leaves no markup in %s', (text) => {
    for (const cleaned of [cleanLine(text, 'de'), cleanBlock(text, 'en')]) {
      expect(hasHtmlTag(cleaned ?? '')).toBe(false);
      expect(cleaned ?? '').not.toContain('![');
      expect(cleaned ?? '').not.toContain('](');
    }
  });
});

describe('cleanLine and cleanBlock', () => {
  it('makes one line of a text and nothing of an empty one', () => {
    expect(cleanLine('  a\n\tb  c ', 'en')).toBe('a b c');
    expect(cleanLine(`${softHyphen} ${zeroWidth}`, 'en')).toBeUndefined();
  });

  it('keeps the lines of a block, tidy', () => {
    expect(cleanBlock('\n\na  \n\n\n\nb\n\n', 'en')).toBe('a\n\nb');
    expect(cleanBlock(' \n ', 'en')).toBeUndefined();
  });

  it('keeps the text of a link and of emphasis, turns <br> into a line and escapes placeholders', () => {
    expect(
      cleanBlock(
        'Use <a href="https://example.com/x">this</a><br>with <b>care</b>: GET /api/x/<id> and [docs](https://example.com)',
        'en',
      ),
    ).toBe('Use this\nwith care: GET /api/x/&lt;id> and docs');
  });
});

describe('decodeEntities', () => {
  it('decodes names WordPress uses and every number', () => {
    expect(
      decodeEntities('a&amp;b &lt;c&gt; &#8211; &#x2014; &nbsp;&ouml;'),
    ).toBe(
      `a&b <c> ${char(0x2013)} ${char(0x2014)} ${char(0xa0)}${char(0xf6)}`,
    );
    expect(decodeEntities('&unknown; &#0; &#xD800;')).toBe(
      `&unknown; ${char(0xfffd)} ${char(0xfffd)}`,
    );
  });
});

describe('academyPathOf', () => {
  it('takes a German path of the Academy with an anchor in lower case', () => {
    const path = (href: string) => academyPathOf(new URL(href, page));
    expect(path('/de/help/wiki/')).toBe('/de/help/wiki/');
    expect(path('../andere/#abschnitt-1')).toBe(
      '/de/help/gruppen/andere/#abschnitt-1',
    );
    expect(path('/de/help/%C3%A4rger/')).toBe('/de/help/%c3%a4rger/');
    expect(path('/de/help/x/#Gross')).toBe('/de/help/x/');
  });

  it('refuses every other host, language and scheme', () => {
    for (const href of [
      'https://example.com/de/help/',
      '/en/help/wiki/',
      'http://churchtools.academy/de/help/',
      '/de/Help/',
      '/de/help/x/?a=1',
      '/de/?p=4711',
      'mailto:max.mustermann@example.org',
    ]) {
      expect(academyPathOf(new URL(href, page))).toBeUndefined();
    }
  });
});

describe('htmlToMarkdown', () => {
  const md = (html: string) => htmlToMarkdown(html, page);

  it('writes headings, paragraphs and line breaks', () => {
    expect(
      md(
        '<h2>Titel</h2><p>Ein <strong>kurzer</strong>\n Satz.<br>Zweite Zeile</p><p>Noch einer',
      ),
    ).toBe('## Titel\n\nEin kurzer Satz.\nZweite Zeile\n\nNoch einer');
  });

  it('writes lists, nested and numbered, also without closed items', () => {
    expect(
      md(
        '<ul><li>eins<li>zwei<ul><li>a</li><li>b</li></ul></li></ul><ol><li>x</li><li>y</li></ol>',
      ),
    ).toBe('- eins\n- zwei\n  - a\n  - b\n\n1. x\n2. y');
  });

  it('writes tables with a head and protected pipes', () => {
    expect(
      md(
        '<figure class="t"><table><thead><tr><th>Recht</th><th>Wirkung</th></tr></thead><tbody><tr><td>a|b</td><td><p>sehen</p></td></tr><tr><td>c</td></tr></tbody></table></figure>',
      ),
    ).toBe('| Recht | Wirkung |\n| --- | --- |\n| a\\|b | sehen |\n| c |  |');
  });

  it('writes code with fences and in lines, with &lt; for tags', () => {
    expect(
      md(
        '<pre><code>if (a &lt; b) {\n  &lt;div&gt;x&lt;/div&gt;\n}</code></pre><p>Mit <code>GET /api</code> lesen</p>',
      ),
    ).toBe(
      '```\nif (a < b) {\n  &lt;div>x&lt;/div>\n}\n```\n\nMit `GET /api` lesen',
    );
  });

  it('keeps links to help pages as paths and only the text of others', () => {
    expect(
      md(
        '<p><a href="/de/help/wiki/">Wiki</a>, <a href="https://churchtools.academy/de/help/personen/#Felder">Personen</a>, ' +
          '<a href="https://example.com/x">fremd</a>, <a href="mailto:someone@example.com">someone@example.com</a>, ' +
          `<a href="https://${hosted('demo-tenant')}/">Instanz</a>, <a href="/en/help/">englisch</a></p>`,
      ),
    ).toBe(
      '[Wiki](/de/help/wiki/), [Personen](/de/help/personen/), fremd, (E-Mail-Adresse entfernt), Instanz, englisch',
    );
  });

  it('drops images, media, scripts, styles, forms and captions with their content', () => {
    expect(
      md(
        '<figure><img src="https://example.com/a.png" alt="Bild"><figcaption>Bildunterschrift</figcaption></figure>' +
          '<p>Text<video src="v.mp4">kein Video</video><iframe src="https://example.com">Rahmen</iframe></p>' +
          '<script>alert("x")</script><style>p{}</style><form><input value="x">Feld</form><nav>Menü</nav><!-- Kommentar --><p>Ende</p>',
      ),
    ).toBe('Text\n\nEnde');
  });

  it('decodes entities, removes invisible characters and protects brackets', () => {
    expect(
      md(
        `<p>Grup&shy;pen&#8203;mitglieder&nbsp;sehen [x](y) und ![b](c)${zeroWidth}</p>`,
      ),
    ).toBe('Gruppenmitglieder sehen \\[x\\] (y) und !\\[b\\] (c)');
  });

  it('replaces the host of an instance in the text with the placeholder', () => {
    expect(
      md(
        `<p>Ihre Adresse <b>${hosted('demo-tenant')}</b> oder <b>gemeinde</b>.church.tools</p>`,
      ),
    ).toBe('Ihre Adresse example.church.tools oder example.church.tools');
  });

  it('gives nothing for a page of images only', () => {
    expect(
      md('<p><img src="a.png"></p><figure><img src="b.png"></figure>'),
    ).toBe('');
  });

  it.each(hostile)(
    'leaves nothing the checks refuse in a paragraph with %s',
    (text) => {
      const html = `<p>${text.replaceAll('<', '&lt;')}</p><p>${text}</p>`;
      const result = md(html);
      expect(findForeignHosts(result)).toEqual([]);
      expect(hasHtmlTag(result)).toBe(false);
      expect(result).not.toContain('![');
      for (const match of result.matchAll(/\]\(([^)\s]*)/g)) {
        expect(match[1]).toMatch(/^\/de\//);
      }
    },
  );
});

describe('htmlToLine', () => {
  it('makes plain text of a title', () => {
    expect(htmlToLine('Gruppen &amp; <em>Mitglieder</em>&#8230;')).toBe(
      `Gruppen & Mitglieder...`,
    );
    expect(htmlToLine('<img src="a.png">')).toBeUndefined();
  });
});

describe('htmlToMarkdown with links in links', () => {
  it('closes an open link when a new one starts, as browsers do', () => {
    expect(
      htmlToMarkdown(
        '<ul><li><a href="/de/help/a/"><a href="/de/help/b/">Innen</a></a></li><li><a href="/de/help/c/">Aussen <a href="/de/help/d/">innen</a> weiter</a></li></ul>',
        page,
      ),
    ).toBe(
      '- [Innen](/de/help/b/)\n- [Aussen](/de/help/c/) [innen](/de/help/d/) weiter',
    );
  });
});

describe('cleaning of the forms the first review found', () => {
  it('keeps a word with a colon before a bracket as text', () => {
    expect(cleanBlock('Use the syntax filter:[name] to filter.', 'en')).toBe(
      'Use the syntax filter: [name] to filter.',
    );
    expect(findForeignHosts('filter: [name]')).toEqual([]);
    expect(cleanLine('See https://[2001:db8::1]/x', 'en')).toBe(
      'See (link removed)',
    );
  });

  it('keeps an escaped dot in code and still finds a host written with one', () => {
    expect(
      htmlToMarkdown('<pre><code>^\\d+\\.\\d+$ und a\\.b</code></pre>', page),
    ).toBe('```\n^\\d+\\.\\d+$ und a\\.b\n```');
    expect(cleanLine('see example\\.com and 10\\.0\\.0\\.1', 'en')).toBe(
      'see (link removed) and (address removed)',
    );
  });

  it('numbers an ordered list on from its start and the value of an item', () => {
    expect(
      htmlToMarkdown(
        '<ol><li>Eins</li><li>Zwei</li></ol><figure><img src="a.png"></figure><ol start="3"><li>Drei</li><li value="7">Sieben</li><li>Acht</li></ol>',
        page,
      ),
    ).toBe('1. Eins\n2. Zwei\n\n3. Drei\n7. Sieben\n8. Acht');
  });

  it('keeps the caption of a table and drops the one of an image', () => {
    expect(
      htmlToMarkdown(
        '<figure class="wp-block-table"><table><caption>Rechte</caption><tr><td>a</td></tr></table><figcaption>Tabelle: Angaben</figcaption></figure><figure><img src="a.png"><figcaption>Ein Bild</figcaption></figure>',
        page,
      ),
    ).toBe('Rechte\n\n| a |\n| --- |\n\nTabelle: Angaben');
  });

  it('keeps no link with a query', () => {
    expect(
      htmlToMarkdown(
        '<p><a href="https://churchtools.academy/de/?p=4711">diesen Artikel</a></p>',
        page,
      ),
    ).toBe('diesen Artikel');
  });
});
