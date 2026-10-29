/**
 * Cleans the texts that `pnpm docs:refresh` takes from its sources, so
 * that the checks of the docs index accept them (ADR 0066). Those checks
 * only refuse: a text with a control character, a character nobody sees,
 * a host other than the two of ADR 0027, an e-mail address, markup of
 * HTML or an image fails the build. The refresh must therefore remove all
 * of that itself, before it writes a fact.
 *
 * The rules mirror the check of the hosts in `packages/docs-index` and go
 * further where they can: every URL with a scheme leaves unless it points
 * to the Academy or the placeholder, and a host of an instance under
 * `church.tools` becomes the placeholder (ADR 0027).
 *
 * @packageDocumentation
 */

/** The public host of the Academy, the one host besides the placeholder. */
export const academyHost = 'churchtools.academy';

/** The placeholder that stands for the host of any instance. */
export const placeholderHost = 'example.church.tools';

/** The one domain an e-mail address may keep: the placeholder. */
export const placeholderMailDomain = 'example.org';

/** The language of the notes that stand where something was removed. */
export type NoteLanguage = 'de' | 'en';

/** What stands where the refresh removed a link, an address or an IP. */
export const removalNotes = Object.freeze({
  de: Object.freeze({
    link: '(Link entfernt)',
    mail: '(E-Mail-Adresse entfernt)',
    ip: '(Adresse entfernt)',
  }),
  en: Object.freeze({
    link: '(link removed)',
    mail: '(e-mail address removed)',
    ip: '(address removed)',
  }),
});

// The endings that make a name without a scheme a host for the check of
// the docs index. A name with another ending stays: a path of a field
// such as `group.name` is no host.
const checkedEndings: ReadonlySet<string> = new Set([
  'academy',
  'at',
  'ch',
  'church',
  'com',
  'de',
  'eu',
  'io',
  'li',
  'net',
  'org',
  'tools',
]);

// Hosts under church.tools that belong to the vendor, not to an instance.
// They are no placeholder for an instance, so a mention of one leaves.
const vendorLabels: ReadonlySet<string> = new Set(['www', 'blog', 'forum']);

// Control characters and characters nobody sees: format characters such
// as a soft hyphen or a zero-width space, characters for private use,
// lone surrogates and every character Unicode lets a renderer ignore,
// such as the variation selectors, which can carry hidden text, and the
// fillers of Hangul. With the flag u a lone surrogate counts as \p{Cs}.
const hiddenCharacters =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Default_Ignorable_Code_Point}]/gu;
// Dots that a browser reads as a dot in a name.
const otherDots = /[\u3002\uff0e\uff61]/g;
const lineSeparators = /[\u2028\u2029]/g;

/**
 * Brings a text into one form: line breaks as `\n`, without control and
 * hidden characters except line breaks and tabs, in NFKC, so that letters
 * and dots in full width become plain ones, as the check reads them.
 *
 * @param text - Any text from a source.
 * @returns The text in that form.
 */
export function normalizeText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      .replace(lineSeparators, '\n')
      .replace(hiddenCharacters, keepLines)
      .normalize('NFKC')
      // NFKC can turn one invisible character into another, such as a
      // filler of Hangul into the one of its letters.
      .replace(hiddenCharacters, keepLines)
      .replace(otherDots, '.')
  );
}

function keepLines(char: string): string {
  return char === '\n' || char === '\t' ? char : '';
}

/**
 * Removes or replaces every host, address and URL that the facts may not
 * hold, and keeps the Academy and the placeholder.
 *
 * - A URL with a scheme to an instance under `church.tools` keeps its
 *   path but gets the placeholder as host. Any other URL with a scheme,
 *   also one with fewer slashes such as `https:host`, a host in brackets
 *   or a link that starts with `//`, becomes a note.
 * - An e-mail address becomes a note, except one under `example.org`.
 * - A name under `church.tools` becomes the placeholder, a host of the
 *   vendor there a note, and so does a name with `www.` or with an ending
 *   the check knows, such as `.de`.
 * - Four numbers with dots, as an IPv4 address, become a note.
 *
 * @param text - A text in the form of {@link normalizeText}.
 * @param language - The language of the notes.
 * @returns The text without hosts other than the two allowed ones.
 */
export function cleanHosts(text: string, language: NoteLanguage): string {
  const notes = removalNotes[language];
  // The check reads the Markdown escape of a dot as a dot, so every
  // pattern below takes one as a dot too. Only what it removes or
  // replaces changes: a dot escaped in code stays as it is.
  return text
    .replace(bracketedUrl, notes.link)
    .replace(bracketAfterColon, '$1: $2$3')
    .replace(urlPattern, (match: string) => replaceUrl(match, notes.link))
    .replace(protocolRelative, (match: string, before: string, host: string) =>
      isAllowedHost(unescapeDots(host).toLowerCase())
        ? match
        : `${before}${notes.link}`,
    )
    .replace(mailPattern, (match: string, domain: string) =>
      unescapeDots(domain).toLowerCase() === placeholderMailDomain
        ? match
        : notes.mail,
    )
    .replace(namePattern, (match: string) => replaceName(match, notes.link))
    .replace(ipv4Pattern, notes.ip);
}

// Every pattern is bounded or follows a fixed text, so it runs in linear
// time. Characters that end a word for the check end a URL here too, and
// so do the marks of links and brackets that the conversion of HTML puts
// into a text before it writes them as Markdown (html.mts).
const urlEnd = String.raw`[^\s<>()[\]{}"'\x60|,;*\x01-\x05]`;
// A bracket, also as the mark html.mts gives it until the end.
const openBracket = String.raw`(?:\[|\x04)`;
const closeBracket = String.raw`(?:\]|\x05)`;
// A host in brackets, such as an IPv6 address, after a scheme of the web
// or one with `//`. Any other word with a colon before a bracket, such
// as `filter:[name]`, is text, and a space after its colon is enough for
// the check, which takes any letter before `:[` for a scheme.
const bracketedUrl = new RegExp(
  String.raw`(?:(?:https?|ftps?|wss?):\/{0,3}|[a-z][a-z0-9+.-]{0,30}:\/\/)${openBracket}${urlEnd}{0,2000}(?:${closeBracket}${urlEnd}{0,2000})?`,
  'gi',
);
const bracketAfterColon = new RegExp(
  String.raw`([a-z]):(\/{0,3})(${openBracket})`,
  'gi',
);
// No word boundary before the scheme: the check finds a URL inside a
// word as well, such as in `1https://`.
const urlPattern = new RegExp(
  String.raw`(?:[a-z][a-z0-9+.-]{0,30}:\/\/|(?:https?|ftps?|wss?):\/{0,3})${urlEnd}{0,2000}`,
  'gi',
);
// A dot, also escaped for Markdown as the check reads it.
const dot = String.raw`\\?\.`;
// A label of a name: letters of every script, marks, digits, _ and -.
// The check reads only ASCII, so a name that is ASCII only in its end,
// such as one with an umlaut, must leave as a whole here.
const label = String.raw`[\p{L}\p{M}\p{N}_-]`;
const name = String.raw`${label}{1,63}(?:${dot}${label}{1,63}){1,30}`;
const protocolRelative = new RegExp(
  String.raw`(^|[\s<>()[\]{}"'\x60|,;*\x01-\x05])\/\/(${name})${urlEnd}{0,2000}`,
  'gmu',
);
const mailPattern = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}._%+-])(?:mailto:)?[\p{L}\p{M}\p{N}._%+-]{1,64}@(${name})(?!${label})`,
  'gu',
);
// A name starts where no label goes on before it, also not one ended by
// a dot: after `...`, which NFKC makes of an ellipsis, a name begins.
const namePattern = new RegExp(
  String.raw`(?<!${label}|${label}${dot})${name}(?!${label})`,
  'gu',
);
const octet = String.raw`(?:25[0-5]|2[0-4]\d|1?\d?\d)`;
const ipv4Pattern = new RegExp(
  String.raw`(?<![\d.])${octet}(?:${dot}${octet}){3}(?![\d.]|\\\.)`,
  'g',
);

function unescapeDots(text: string): string {
  return text.replaceAll('\\.', '.');
}
const trailingPunctuation = /[.,:;!?]+$/;

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
  // A link with a query, such as a search or `?p=` with the number of a
  // post, leads to another page than its path, so it does not stay.
  if (
    url.protocol !== 'https:' ||
    url.host !== academyHost ||
    url.search !== ''
  ) {
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

function isAllowedHost(host: string): boolean {
  return host === academyHost || host === placeholderHost;
}

// An instance under church.tools: any name below it except the hosts of
// the vendor and the placeholder itself.
function isInstanceHost(host: string): boolean {
  if (!host.endsWith('.church.tools') || host === placeholderHost) {
    return false;
  }
  const label = host.slice(0, -'.church.tools'.length);
  return label !== '' && !vendorLabels.has(label);
}

function replaceUrl(match: string, note: string): string {
  // A dot or comma after a URL ends the sentence, not the URL.
  const punctuation = trailingPunctuation.exec(match)?.[0] ?? '';
  // Browsers read a backslash in a URL as a slash, and so does the check.
  const url = unescapeDots(
    match.slice(0, match.length - punctuation.length),
  ).replaceAll('\\', '/');
  const scheme = /^[a-z][a-z0-9+.-]{0,30}:\/{0,3}/i.exec(url)?.[0] ?? '';
  const rest = url.slice(scheme.length);
  const end = rest.search(/[/?#]/);
  const authority = end === -1 ? rest : rest.slice(0, end);
  const host = hostOf(authority).toLowerCase();
  if (host === '') {
    return match;
  }
  // A URL of the Academy stays only as the link to a German help page
  // (ADR 0027), any other one becomes a note like a foreign host.
  if (host === academyHost) {
    const parsed = URL.parse(url);
    return parsed !== null && academyPathOf(parsed) !== undefined
      ? match
      : `${note}${punctuation}`;
  }
  if (host === placeholderHost) {
    return match;
  }
  if (isInstanceHost(host)) {
    const path = end === -1 ? '' : rest.slice(end);
    return `https://${placeholderHost}${path}${punctuation}`;
  }
  return `${note}${punctuation}`;
}

// The host of the part after the scheme: without user, port and a final
// dot.
function hostOf(authority: string): string {
  const afterUser = authority.slice(authority.lastIndexOf('@') + 1);
  const colon = afterUser.indexOf(':');
  const host = colon === -1 ? afterUser : afterUser.slice(0, colon);
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function replaceName(match: string, note: string): string {
  const name = unescapeDots(match).toLowerCase();
  if (isAllowedHost(name) || name === placeholderMailDomain) {
    return match;
  }
  if (isInstanceHost(name)) {
    return placeholderHost;
  }
  if (name === 'church.tools' || name.endsWith('.church.tools')) {
    return note;
  }
  if (name.startsWith('www.')) {
    return note;
  }
  const ending = name.slice(name.lastIndexOf('.') + 1);
  return /^[a-z]{2,63}$/.test(ending) && checkedEndings.has(ending)
    ? note
    : match;
}

/**
 * Makes a text safe for the checks of markup: a character reference
 * keeps its `&` as `&amp;`, a `<` that could start a
 * tag, a comment, a declaration or an autolink becomes `&lt;`, also in
 * code, an image `![` becomes `! [`, and a line that would define a link
 * for later reference gets a space before its colon. A reader and a model
 * still read `&lt;` as the sign, and no text of the facts holds HTML.
 *
 * @param text - A cleaned text.
 * @returns The text without anything the checks read as markup.
 */
export function escapeMarkup(text: string): string {
  return (
    text
      // A character reference, also one that decoding left over such as
      // `&#46;` from `&amp;#46;`, would turn into its character when
      // the Markdown is shown, a dot of a host for instance. It stays text.
      .replace(/&(?=#?[A-Za-z0-9]{1,32};)/g, '&amp;')
      .replace(/<(?=[A-Za-z/!?])/g, '&lt;')
      .replaceAll('![', '! [')
      .replace(/^([ ]{0,3}\[(?:\\.|[^\]\\\n])*\]):/gm, '$1 :')
  );
}

/**
 * Turns a text into one line for a field without line breaks: cleaned,
 * white space as single spaces, without spaces at either end.
 *
 * @param text - Any text from a source.
 * @param language - The language of the notes for removed hosts.
 * @returns The line, or `undefined` if nothing is left.
 */
export function cleanLine(
  text: string,
  language: NoteLanguage,
): string | undefined {
  const line = escapeMarkup(
    cleanHosts(normalizeText(text).replace(/\s+/g, ' ').trim(), language),
  )
    .replaceAll('](', '] (')
    .trim();
  return line === '' ? undefined : line;
}

/**
 * Turns a text with several lines into the form of a fact: cleaned,
 * without spaces at the end of a line, at most one empty line in a row
 * and without empty lines at either end. A link in Markdown keeps only
 * its text, since a link in a fact of the OpenAPI document may not lead
 * anywhere. The few tags of HTML that descriptions of the OpenAPI
 * document use leave: a line break becomes one, a link and emphasis keep
 * their text. Any other `<`, such as the one of a placeholder `<id>`,
 * becomes `&lt;`.
 *
 * @param text - Any text from a source.
 * @param language - The language of the notes for removed hosts.
 * @returns The text, or `undefined` if nothing is left.
 */
export function cleanBlock(
  text: string,
  language: NoteLanguage,
): string | undefined {
  const normal = normalizeText(text)
    .replace(markdownImage, '')
    .replace(markdownLink, '$1')
    .replace(/<br\s{0,20}\/?>/gi, '\n')
    .replace(inlineTag, '');
  const block = tidyLines(
    escapeMarkup(cleanHosts(normal, language)).replaceAll('](', '] ('),
  );
  return block === '' ? undefined : block;
}

// An image in Markdown leaves entirely, a link keeps its text. Bounded,
// so linear in time.
const markdownImage = /!\[[^\]\n]{0,1000}\]\([^)\n]{0,2000}\)/g;
const markdownLink = /\[([^\]\n]{0,1000})\]\([^)\n]{0,2000}\)/g;
// Tags of a line of HTML whose text stays, the link with its target.
const inlineTag =
  /<\/?(?:a|b|code|em|i|small|span|strong|sub|sup|u)(?:\s[^<>]{0,1000})?>/gi;

/**
 * Removes spaces at the end of each line, keeps at most one empty line in
 * a row and trims empty lines at either end.
 *
 * @param text - A text with lines.
 * @returns The tidy text.
 */
export function tidyLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}
