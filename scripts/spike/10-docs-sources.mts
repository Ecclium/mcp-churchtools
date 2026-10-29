/**
 * Probe 10: the sources of the docs index.
 *
 * Reads: `GET /api/wiki/categories`, to tell the test instance by its
 * identification category, and `GET /api/permissions/definitions`, if the
 * instance documents it. The OpenAPI document comes from the state file of
 * 00-inventory, without a request.
 * Writes: nothing.
 * Answers: what the docs index can take from the OpenAPI document
 * (ADR 0027): which keys `info` has, whether its licence is CC BY 4.0,
 * whether it names the copyright, the vendor or a disclaimer, whether its
 * version is the one of the instance, how many operations there are for
 * each method, how many are deprecated and have an `operationId`, how many
 * `GET` operations each prefix has, how many descriptions name rights,
 * which hosts `servers`, examples and descriptions carry, as classes, and
 * how large the parts of the document are. Names of prefixes appear only
 * on the test instance: elsewhere they would show which modules are
 * active, which 00-inventory keeps back for the same reason.
 *
 * Of the definitions of the rights it gives the structure of the answer,
 * whether the modules and the rights of the tools appear in it, how many
 * names of rights it holds, and whether it carries values of the
 * instance: a text equal to the name of a wiki category the account sees,
 * or lists of objects with an ID and a name. No name and no value of the
 * answer reaches the output.
 *
 * Of the academy, the public help pages of the vendor, it reads
 * `robots.txt` first and stops if that forbids a path it needs. Then it
 * reads the overview of the help pages for its languages, the index of the
 * REST interface of WordPress, the categories, the knowledge bases and
 * every help page in German, and the number of help pages of each other
 * language. It gives counts per section with the slug of the section, the
 * size of the texts, the years of the last change, and as classes how
 * many pages carry images, videos, tables, code and links of each class
 * of host. It never asks for the authors of a page, and no text, link or
 * host of the academy reaches the output.
 *
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import {
  academyOrigin,
  formatSize,
  hreflangCodes,
  maxAcademyPauseMs,
  pageFeatures,
  parseRobots,
  robotsAllow,
  type AcademyClient,
  type AcademyResponse,
  type RobotsRules,
} from './lib/academy.mts';
import { errorCodes, SpikeError } from './lib/errors.mts';
import type { SpikeState } from './lib/env.mts';
import { identificationCategoryName } from './lib/gate.mts';
import type { Guard, Json } from './lib/guard.mts';
import { userAgent, type Client } from './lib/http.mts';
import { operations } from './lib/operations.mts';
import { main, type ProbeDefinition } from './lib/probe.mts';
import { describeResponse } from './lib/report.mts';
import {
  basePath,
  findOperation,
  isObject,
  Schemas,
  type JsonObject,
  type OpenApiDocument,
} from './lib/spec.mts';
import { countClass, countClasses } from './lib/structure.mts';

/** The methods whose operations the probe counts. */
export const countedMethods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'trace',
] as const;

/**
 * The rights the tools of Ecclium name in their metadata, as module and
 * right. They are fixed here, and a test compares them with the reference
 * of the tools in `docs/tools.md`.
 */
export const toolRights = [
  { module: 'churchcal', right: 'view category' },
  { module: 'churchdb', right: 'view alldata' },
  { module: 'churchgroup', right: 'security level group' },
  { module: 'churchgroup', right: 'view groups of grouptype' },
  { module: 'churchresource', right: 'view resource' },
  { module: 'churchservice', right: 'view agenda' },
  { module: 'churchservice', right: 'view events' },
  { module: 'churchservice', right: 'view servicegroup' },
  { module: 'churchservice', right: 'view songcategory' },
  { module: 'churchwiki', right: 'view' },
  { module: 'churchwiki', right: 'view category' },
] as const;

/** The modules whose names the probe looks for in the definitions. */
export const knownModules = [
  'churchcore',
  'churchdb',
  'churchgroup',
  'churchcal',
  'churchresource',
  'churchservice',
  'churchwiki',
  'churchcheckin',
] as const;

/** One right of {@link toolRights}. */
export type ToolRight = (typeof toolRights)[number];

/**
 * The name of a right of the tools in the output.
 *
 * @param entry - One right of {@link toolRights}.
 * @returns The name, such as `view alldata in churchdb`.
 */
export function toolRightName(entry: ToolRight): string {
  return `${entry.right} in ${entry.module}`;
}

/** The classes of the hosts a text of the document can carry. */
export const hostClasses = [
  'hostDerInstanz',
  'andereInstanz',
  'hersteller',
  'platzhalter',
  'andererHost',
] as const;

/** One class of {@link hostClasses}. */
export type HostClass = (typeof hostClasses)[number];

// The public sites of the vendor. Every other host under church.tools is
// an instance of a customer.
const vendorHosts: ReadonlySet<string> = new Set([
  'church.tools',
  'www.church.tools',
  'blog.church.tools',
  'forum.church.tools',
  'churchtools.de',
  'www.churchtools.de',
  'churchtools.academy',
]);

/**
 * Puts a host into its class, without its name ever reaching the output.
 *
 * @param host - Host name.
 * @param instanceHost - Host of the instance the probe talks to, in lower case.
 * @returns The class of the host.
 * @example
 * ```ts
 * classifyHost('forum.church.tools', 'example.church.tools'); // 'hersteller'
 * ```
 */
export function classifyHost(host: string, instanceHost: string): HostClass {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (name === instanceHost) {
    return 'hostDerInstanz';
  }
  if (
    name === 'example.church.tools' ||
    name === 'localhost' ||
    /(?:^|\.)example\.(?:com|org|net)$/.test(name) ||
    name.endsWith('.example') ||
    name.endsWith('.test') ||
    name.endsWith('.invalid')
  ) {
    return 'platzhalter';
  }
  if (vendorHosts.has(name) || name.endsWith('.churchtools.de')) {
    return 'hersteller';
  }
  if (name.endsWith('.church.tools')) {
    return 'andereInstanz';
  }
  return 'andererHost';
}

// Hosts after a scheme, domains after an at sign, and names under
// church.tools without a scheme. Each run of characters has an upper bound,
// so a long text of the document costs linear time.
const urlHost = /\bhttps?:\/\/([a-z0-9.-]{1,253})/g;
const mailDomain =
  /[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,8})/g;
const churchToolsName = /\b([a-z0-9-]{1,63}\.church\.tools)\b/g;

/** What the texts of one part of the document carry, as counts. */
export interface HostCounts {
  texts: number;
  readonly hosts: Record<HostClass, number>;
  mails: number;
}

function emptyCounts(): HostCounts {
  return {
    texts: 0,
    hosts: {
      hostDerInstanz: 0,
      andereInstanz: 0,
      hersteller: 0,
      platzhalter: 0,
      andererHost: 0,
    },
    mails: 0,
  };
}

/**
 * Counts the hosts and mail addresses in one text. Each class counts once
 * per text. The host of the instance counts wherever it appears, also
 * inside a longer word.
 *
 * @param text - A text of the document.
 * @param instanceHost - Host of the instance in lower case.
 * @param counts - Counts to add to.
 */
export function countHosts(
  text: string,
  instanceHost: string,
  counts: HostCounts,
): void {
  counts.texts += 1;
  const lower = text.toLowerCase();
  const seen = new Set<HostClass>();
  for (const match of lower.matchAll(urlHost)) {
    seen.add(classifyHost(match[1] ?? '', instanceHost));
  }
  for (const match of lower.matchAll(churchToolsName)) {
    seen.add(classifyHost(match[1] ?? '', instanceHost));
  }
  let mail = false;
  for (const match of lower.matchAll(mailDomain)) {
    mail = true;
    seen.add(classifyHost(match[1] ?? '', instanceHost));
  }
  if (lower.includes(instanceHost)) {
    seen.add('hostDerInstanz');
  }
  for (const found of seen) {
    counts.hosts[found] += 1;
  }
  if (mail) {
    counts.mails += 1;
  }
}

// Keys whose values are examples or defaults of the document.
const exampleKeys: ReadonlySet<string> = new Set([
  'example',
  'examples',
  'x-example',
  'x-examples',
  'default',
]);

// Keys whose values are texts of the document for people.
const describingKeys: ReadonlySet<string> = new Set([
  'description',
  'summary',
  'title',
]);

/** Where a text of the document stands. */
export type Place = 'servers' | 'beispiele' | 'beschreibungen' | 'andere';

/**
 * Counts the hosts in every text of the document, by where the text
 * stands. The walk keeps its own stack, so a deep document cannot
 * overflow the call stack.
 *
 * @param document - The OpenAPI document.
 * @param instanceHost - Host of the instance in lower case.
 * @returns Counts for servers, examples, descriptions and every other text.
 */
export function hostsInDocument(
  document: OpenApiDocument,
  instanceHost: string,
): Record<Place, HostCounts> {
  const result: Record<Place, HostCounts> = {
    servers: emptyCounts(),
    beispiele: emptyCounts(),
    beschreibungen: emptyCounts(),
    andere: emptyCounts(),
  };
  const stack: { value: unknown; place: Place; key: string }[] = [];
  for (const [key, value] of Object.entries(document)) {
    stack.push({
      value,
      place: key === 'servers' ? 'servers' : 'andere',
      key,
    });
  }
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, place, key } = item;
    if (typeof value === 'string') {
      const where =
        place === 'andere' && describingKeys.has(key)
          ? 'beschreibungen'
          : place;
      countHosts(value, instanceHost, result[where]);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        stack.push({ value: entry, place, key });
      }
    } else if (isObject(value)) {
      for (const [inner, entry] of Object.entries(value)) {
        stack.push({
          value: entry,
          place:
            place === 'andere' && exampleKeys.has(inner) ? 'beispiele' : place,
          key: inner,
        });
      }
    }
  }
  return result;
}

/** One operation of the document with its method and full path. */
export interface DocumentOperation {
  readonly method: (typeof countedMethods)[number];
  readonly path: string;
  readonly operation: JsonObject;
}

/**
 * Lists every operation of the document, with the prefix of the document
 * in front of its path.
 *
 * @param document - The OpenAPI document.
 * @returns The operations in the order of the document.
 */
export function documentOperations(
  document: OpenApiDocument,
): DocumentOperation[] {
  const prefix = basePath(document);
  const result: DocumentOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isObject(item)) {
      continue;
    }
    for (const method of countedMethods) {
      const operation = item[method];
      if (isObject(operation)) {
        result.push({ method, path: `${prefix}${path}`, operation });
      }
    }
  }
  return result;
}

/**
 * The prefix of an operation: the first segment after `/api/`, or the
 * first segment of a path outside `/api/`.
 *
 * @param path - Full path of the operation.
 * @returns The prefix, possibly empty.
 */
export function prefixOf(path: string): string {
  const segments = path.split('/');
  return (path.startsWith('/api/') ? segments[2] : segments[1]) ?? '';
}

const prefixForm = /^[a-z][a-z0-9_-]{0,39}$/;
const extensionForm = /^x-[A-Za-z0-9-]{1,40}$/;

// Words that say a description is about rights. The German forms end at a
// word boundary, so «Rechteverwaltung» and «rechts» do not count.
const rightWords =
  /(?:^|[^\p{L}])(?:rechte?n?|berechtigung(?:en)?|permissions?)(?!\p{L})/iu;

/**
 * Tells whether a text names a right of the tools. A right of one word,
 * such as `view`, counts only with the name of its module, since the word
 * alone is common.
 *
 * @param text - Summary and description of an operation, in lower case.
 * @param entry - One right of {@link toolRights}.
 * @returns Whether the text names the right.
 */
export function namesToolRight(text: string, entry: ToolRight): boolean {
  const word = (part: string): boolean =>
    new RegExp(`(?:^|[^a-z0-9])${part}(?![a-z0-9])`).test(text);
  return entry.right.includes(' ')
    ? word(entry.right)
    : word(entry.right) && word(entry.module);
}

/**
 * Tells whether a text names one of the given rights as whole words.
 *
 * @param text - Summary and description of an operation, in lower case.
 * @param rights - Names of rights in lower case, such as `view alldata`.
 * @returns Whether one of them appears in the text.
 */
export function namesAny(text: string, rights: ReadonlySet<string>): boolean {
  for (const right of rights) {
    let from = text.indexOf(right);
    while (from !== -1) {
      const before = from === 0 ? '' : text.charAt(from - 1);
      const after = text.charAt(from + right.length);
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
        return true;
      }
      from = text.indexOf(right, from + 1);
    }
  }
  return false;
}

function descriptionOf(operation: JsonObject): string {
  return [operation['summary'], operation['description']]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

/**
 * Gives the size of a part of the document as text, so that no exact
 * number of bytes reaches the output.
 *
 * @param value - A part of the document.
 * @returns Size in MiB with one decimal, below 1 MiB in whole KiB rounded up.
 */
export function sizeOf(value: unknown): string {
  return formatSize(
    value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8'),
  );
}

const documentVersionForm = /^(\d{1,3})\.(\d{1,4})(?:\.\d{1,6})?$/;
const openApiVersionForm = /^\d\.\d(?:\.\d{1,2})?$/;

function licenceName(value: unknown): string {
  if (typeof value !== 'string') {
    return 'fehlt';
  }
  const compact = value.toLowerCase().replace(/[\s_-]+/g, '');
  return compact === 'ccby4.0' ||
    compact === 'creativecommonsattribution4.0international' ||
    compact === 'creativecommonsattribution4.0'
    ? 'CC BY 4.0'
    : 'anderer Text';
}

function licenceLink(value: unknown): string {
  if (typeof value !== 'string') {
    return 'fehlt';
  }
  const url = URL.parse(value);
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return 'kein Link';
  }
  return url.hostname === 'creativecommons.org' ||
    url.hostname === 'www.creativecommons.org'
    ? 'Creative Commons'
    : 'anderer Host';
}

function linkClass(value: unknown, instanceHost: string): string {
  if (typeof value !== 'string') {
    return 'fehlt';
  }
  const url = URL.parse(value);
  return url === null ? 'kein Link' : classifyHost(url.hostname, instanceHost);
}

function mailClass(value: unknown, instanceHost: string): string {
  if (typeof value !== 'string') {
    return 'fehlt';
  }
  const at = value.lastIndexOf('@');
  return at < 1
    ? 'keine Adresse'
    : classifyHost(value.slice(at + 1), instanceHost);
}

const infoKeys: ReadonlySet<string> = new Set([
  'title',
  'summary',
  'description',
  'termsOfService',
  'contact',
  'license',
  'version',
]);

const contactKeys: ReadonlySet<string> = new Set(['name', 'url', 'email']);

function keysOf(
  value: JsonObject,
  known: ReadonlySet<string>,
  guard: Guard,
): string[] {
  let unknown = 0;
  return Object.keys(value).map((key) => {
    if (known.has(key)) {
      guard.allowFixed(key);
      return key;
    }
    if (extensionForm.test(key)) {
      guard.allowDeclared(key);
      return key;
    }
    unknown += 1;
    const shown = `<key#${String(unknown)}>`;
    guard.allowFixed(shown);
    return shown;
  });
}

/** The namespaces of the REST interface the probe looks for. */
export const academyNamespaces = ['wp/v2', 'betterdocs', 'wpml/v1'] as const;

/** The routes of the help pages and their taxonomies. */
export const academyRoutes = [
  '/wp/v2/docs',
  '/wp/v2/doc_category',
  '/wp/v2/knowledge_base',
] as const;

/** The paths the probe reads, checked against `robots.txt` first. */
export const academyPaths = [
  '/de/help/',
  '/de/wp-json/',
  '/de/wp-json/wp/v2/docs',
  '/de/wp-json/wp/v2/doc_category',
  '/de/wp-json/wp/v2/knowledge_base',
] as const;

/** Fixed words of the part about the academy. */
const academyWords = [
  'academy',
  'robots',
  'status',
  'eigeneGruppe',
  'gruppeFuerAlle',
  'pfade',
  'erlaubt',
  'verboten',
  'crawlDelay',
  'sitemap',
  'gelesen',
  'grund',
  'robots.txt verbietet',
  'robots.txt nicht lesbar',
  'Crawl-delay zu lang',
  'Schnittstelle ohne Hilfeseiten',
  'hilfe',
  'sprachen',
  'schnittstelle',
  'namensraeume',
  'routen',
  'seiten',
  'gemeldet',
  'veroeffentlicht',
  'geschuetzt',
  'html',
  'text',
  'geaendert',
  'aeltestes',
  'neuestes',
  'jeJahr',
  'merkmale',
  'bilder',
  'videos',
  'tabellen',
  'code',
  'links',
  'relativ',
  'email',
  'hostsImText',
  'abschnitte',
  'wissensbasen',
  'ohneZuordnung',
  'kategorien',
  'weitereSprachen',
  'weitere',
  'Fehler',
  'fehler',
  ...errorCodes,
  ...academyNamespaces,
  ...academyRoutes,
  ...academyPaths,
] as const;

/** Fixed words of this probe. */
const words = [
  'probe',
  '10-docs-sources',
  'churchtoolsVersion',
  'unbekannt',
  'testinstanz',
  'ja',
  'nein',
  'nicht dokumentiert',
  'openapi',
  'format',
  'OpenAPI 3',
  'Swagger 2',
  'openapiVersion',
  'anderer Wert',
  'fehlt',
  'info',
  'schluessel',
  'lizenz',
  'name',
  'kennung',
  'url',
  'CC BY 4.0',
  'CC-BY-4.0',
  'anderer Text',
  'Creative Commons',
  'anderer Host',
  'kein Link',
  'keine Adresse',
  'kontakt',
  'email',
  'nutzungsbedingungen',
  'hinweise',
  'urheberrecht',
  'hersteller',
  'gewaehrleistung',
  'beschreibung',
  'leer',
  'version',
  'dokument',
  'vergleich',
  'gleich',
  'verschieden',
  'anderes Format',
  'operationen',
  'jeMethode',
  'veraltet',
  'operationId',
  'mit',
  'ohne',
  'doppelt',
  'getJePraefix',
  'beschreibungen',
  'mitText',
  'allgemeineWoerter',
  'rechteDerTools',
  'rechteDerDefinitionen',
  'erweiterungen',
  'rechte',
  'definitionen',
  'antwort',
  'module',
  'vorhanden',
  'definiert',
  'namen',
  'werteDerInstanz',
  'kategorienamen',
  'auswahllisten',
  'anzahlSchemas',
  'hosts',
  'servers',
  'beispiele',
  'andere',
  'texte',
  'emailAdressen',
  'groesse',
  'gesamt',
  'paths',
  'schemas',
  'komponentenUebrige',
  'tags',
  ...countedMethods,
  ...countClasses,
  ...hostClasses,
  ...toolRights.map(toolRightName),
  ...knownModules,
  ...academyWords,
];

/**
 * Describes `info`: its keys, the licence, the contact, whether title and
 * description name the copyright, the vendor, a disclaimer or a licence,
 * and the version against the one of the instance. No text of it reaches
 * the output.
 *
 * @param document - The OpenAPI document.
 * @param version - Version of the instance from the state, if known.
 * @param instanceHost - Host of the instance in lower case.
 * @param guard - Receives every word the description uses.
 * @returns The description.
 */
export function describeInfo(
  document: OpenApiDocument,
  version: string | null,
  instanceHost: string,
  guard: Guard,
): Json {
  const info = document['info'];
  if (!isObject(info)) {
    return 'fehlt';
  }
  const licence = isObject(info['license']) ? info['license'] : undefined;
  const contact = isObject(info['contact']) ? info['contact'] : undefined;
  const text = [info['title'], info['summary'], info['description']]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  const documentVersion =
    typeof info['version'] === 'string'
      ? documentVersionForm.exec(info['version'])
      : null;
  if (documentVersion !== null) {
    guard.allowFixed(documentVersion[0]);
  }
  const description = info['description'];
  if (typeof description === 'string') {
    guard.allowFixed(sizeOf(description));
  }
  const identifier = licence?.['identifier'];
  return {
    schluessel: keysOf(info, infoKeys, guard),
    lizenz:
      licence === undefined
        ? 'fehlt'
        : {
            name: licenceName(licence['name']),
            kennung:
              identifier === undefined
                ? 'fehlt'
                : identifier === 'CC-BY-4.0'
                  ? 'CC-BY-4.0'
                  : 'anderer Text',
            url: licenceLink(licence['url']),
          },
    kontakt:
      contact === undefined
        ? 'fehlt'
        : {
            schluessel: keysOf(contact, contactKeys, guard),
            url: linkClass(contact['url'], instanceHost),
            email: mailClass(contact['email'], instanceHost),
          },
    nutzungsbedingungen: linkClass(info['termsOfService'], instanceHost),
    hinweise: {
      urheberrecht: /©|\(c\)|copyright|urheberrecht/i.test(text)
        ? 'ja'
        : 'nein',
      hersteller: /churchtools innovations/i.test(text) ? 'ja' : 'nein',
      gewaehrleistung:
        /gewähr|garantie|haftung|warrant|liabilit|\bas is\b/i.test(text)
          ? 'ja'
          : 'nein',
      lizenz: /cc by|creative commons|lizenz|licen[cs]e/i.test(text)
        ? 'ja'
        : 'nein',
    },
    beschreibung:
      typeof description !== 'string'
        ? 'fehlt'
        : description.trim() === ''
          ? 'leer'
          : sizeOf(description),
    version: {
      dokument:
        documentVersion !== null
          ? documentVersion[0]
          : info['version'] === undefined
            ? 'fehlt'
            : 'anderes Format',
      vergleich:
        documentVersion === null || version === null
          ? 'unbekannt'
          : `${documentVersion[1] ?? ''}.${documentVersion[2] ?? ''}` ===
              version
            ? 'gleich'
            : 'verschieden',
    },
  };
}

function count(guard: Guard, value: number): number {
  guard.allowFixed(value);
  return value;
}

// A count the academy reports itself: it comes from outside, so it is
// checked like any public word.
function publicCount(guard: Guard, value: number): number {
  guard.allowPublic(String(value));
  return value;
}

const byName = <T,>([a]: readonly [string, T], [b]: readonly [string, T]) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Counts the operations of the document: for each method, the deprecated
 * ones, those with an `operationId`, the `GET` operations of each prefix,
 * the descriptions that name rights and the extensions of operations.
 *
 * @param document - The OpenAPI document.
 * @param testInstance - Whether the names of the prefixes may appear.
 * @param definedRights - Names of rights from the definitions, if read.
 * @param guard - Receives every word the description uses.
 * @returns The counts.
 */
export function describeOperations(
  document: OpenApiDocument,
  testInstance: boolean,
  definedRights: ReadonlySet<string> | undefined,
  guard: Guard,
): Json {
  const all = documentOperations(document);
  const perMethod = new Map<string, number>();
  const deprecated = new Map<string, number>();
  const ids = new Map<string, number>();
  let withoutId = 0;
  const prefixes = new Map<string, number>();
  const extensions = new Map<string, number>();
  let withText = 0;
  let generic = 0;
  let defined = 0;
  const named = new Map<string, number>();
  for (const { method, path, operation } of all) {
    perMethod.set(method, (perMethod.get(method) ?? 0) + 1);
    if (operation['deprecated'] === true) {
      deprecated.set(method, (deprecated.get(method) ?? 0) + 1);
    }
    const id = operation['operationId'];
    if (typeof id === 'string' && id !== '') {
      ids.set(id, (ids.get(id) ?? 0) + 1);
    } else {
      withoutId += 1;
    }
    if (method === 'get') {
      const prefix = prefixOf(path);
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
    for (const key of Object.keys(operation)) {
      if (key.startsWith('x-')) {
        extensions.set(key, (extensions.get(key) ?? 0) + 1);
      }
    }
    const text = descriptionOf(operation);
    if (text.trim() !== '') {
      withText += 1;
    }
    if (rightWords.test(text)) {
      generic += 1;
    }
    if (definedRights !== undefined && namesAny(text, definedRights)) {
      defined += 1;
    }
    for (const entry of toolRights) {
      if (namesToolRight(text, entry)) {
        const name = toolRightName(entry);
        named.set(name, (named.get(name) ?? 0) + 1);
      }
    }
  }
  let hidden = 0;
  const perPrefix: Record<string, number> = {};
  for (const [prefix, total] of [...prefixes].sort(byName)) {
    let shown: string;
    if (testInstance && prefixForm.test(prefix)) {
      guard.allowDeclared(prefix);
      shown = prefix;
    } else {
      hidden += 1;
      shown = `<prefix#${String(hidden)}>`;
      guard.allowFixed(shown);
    }
    perPrefix[shown] = count(guard, total);
  }
  let otherExtensions = 0;
  const perExtension: Record<string, number> = {};
  for (const [key, total] of [...extensions].sort(byName)) {
    let shown = key;
    if (extensionForm.test(key)) {
      guard.allowDeclared(key);
    } else {
      otherExtensions += 1;
      shown = `<key#${String(otherExtensions)}>`;
      guard.allowFixed(shown);
    }
    perExtension[shown] = count(guard, total);
  }
  const methods = countedMethods.filter((method) => perMethod.has(method));
  return {
    jeMethode: Object.fromEntries(
      methods.map((method) => [
        method,
        count(guard, perMethod.get(method) ?? 0),
      ]),
    ),
    veraltet: Object.fromEntries(
      methods.map((method) => [
        method,
        count(guard, deprecated.get(method) ?? 0),
      ]),
    ),
    operationId: {
      mit: count(guard, all.length - withoutId),
      ohne: count(guard, withoutId),
      doppelt: count(
        guard,
        [...ids.values()].filter((times) => times > 1).length,
      ),
    },
    getJePraefix: perPrefix,
    beschreibungen: {
      mitText: countClass(withText),
      allgemeineWoerter: countClass(generic),
      rechteDerDefinitionen:
        definedRights === undefined ? 'unbekannt' : countClass(defined),
      rechteDerTools: Object.fromEntries(
        toolRights.map((entry) => {
          const name = toolRightName(entry);
          return [name, countClass(named.get(name) ?? 0)];
        }),
      ),
    },
    erweiterungen: perExtension,
  };
}

function describeCounts(counts: HostCounts): Json {
  return {
    texte: countClass(counts.texts),
    ...Object.fromEntries(
      hostClasses.map((name) => [name, countClass(counts.hosts[name])]),
    ),
    emailAdressen: countClass(counts.mails),
  };
}

/**
 * Describes the OpenAPI document of the state, without any of its texts.
 *
 * @param state - The state of 00-inventory.
 * @param instanceHost - Host of the instance in lower case.
 * @param testInstance - Whether the names of the prefixes may appear.
 * @param definedRights - Names of rights from the definitions, if read.
 * @param guard - Receives every word the description uses.
 * @returns The description.
 */
export function describeDocument(
  state: SpikeState,
  instanceHost: string,
  testInstance: boolean,
  definedRights: ReadonlySet<string> | undefined,
  guard: Guard,
): Json {
  const document = state.specification;
  const openapi = document['openapi'];
  const swagger = document['swagger'];
  const version =
    typeof openapi === 'string'
      ? openapi
      : typeof swagger === 'string'
        ? swagger
        : '';
  const versionShown = openApiVersionForm.test(version);
  if (versionShown) {
    guard.allowFixed(version);
  }
  const components = isObject(document['components'])
    ? document['components']
    : {};
  const schemas = isObject(components['schemas'])
    ? components['schemas']
    : isObject(document['definitions'])
      ? document['definitions']
      : {};
  const otherComponents = Object.fromEntries(
    Object.entries(components).filter(([key]) => key !== 'schemas'),
  );
  const hosts = hostsInDocument(document, instanceHost);
  const sizes = {
    gesamt: sizeOf(document),
    paths: sizeOf(document.paths),
    schemas: sizeOf(schemas),
    komponentenUebrige: sizeOf(otherComponents),
    info: sizeOf(document['info']),
    servers: sizeOf(document['servers']),
    tags: sizeOf(document['tags']),
  };
  guard.allowFixed(...Object.values(sizes));
  return {
    format: typeof openapi === 'string' ? 'OpenAPI 3' : 'Swagger 2',
    openapiVersion: versionShown ? version : 'anderer Wert',
    info: describeInfo(document, state.version, instanceHost, guard),
    operationen: describeOperations(
      document,
      testInstance,
      definedRights,
      guard,
    ),
    anzahlSchemas: count(guard, Object.keys(schemas).length),
    hosts: {
      servers: describeCounts(hosts.servers),
      beispiele: describeCounts(hosts.beispiele),
      beschreibungen: describeCounts(hosts.beschreibungen),
      andere: describeCounts(hosts.andere),
    },
    groesse: sizes,
  };
}

/** What the probe learns from the list of wiki categories. */
export interface Categories {
  /** Whether the instance is the test instance. */
  readonly testInstance: 'ja' | 'nein' | 'nicht dokumentiert' | 'unbekannt';
  /** Names of the categories the account sees, empty if unknown. */
  readonly names: readonly string[];
}

/**
 * Reads the wiki categories the account sees. Their names tell the test
 * instance by its identification category, as the guard for personal data
 * does (ADR 0049): exactly one visible category must carry its name.
 *
 * @param client - Client of the instance.
 * @param document - The OpenAPI document of the instance.
 * @returns Whether it is the test instance, and the names of the categories.
 */
export async function readCategories(
  client: Client,
  document: OpenApiDocument,
): Promise<Categories> {
  const { method, template } = operations.wikiCategories;
  if (findOperation(document, method, template) === undefined) {
    return { testInstance: 'nicht dokumentiert', names: [] };
  }
  const response = await client.get({ path: template });
  const data = isObject(response.body) ? response.body['data'] : undefined;
  if (response.status !== 200 || !Array.isArray(data)) {
    return { testInstance: 'unbekannt', names: [] };
  }
  const names = data
    .map((entry) => (isObject(entry) ? entry['name'] : undefined))
    .filter((name): name is string => typeof name === 'string');
  const marked = names.filter((name) => name === identificationCategoryName);
  return { testInstance: marked.length === 1 ? 'ja' : 'nein', names };
}

/**
 * Tells whether the definitions define a right of the tools: the right
 * appears as a key or as a text of an object, and its module as a key or
 * a text of the same object or of one that holds it. So both
 * `{"churchdb": {"view alldata": {}}}` and
 * `[{"module": "churchdb", "auth": "view alldata"}]` count. The walk keeps
 * its own stack.
 *
 * @param body - The parsed answer of the definitions.
 * @param entry - One right of {@link toolRights}.
 * @returns Whether the right is defined in its module.
 */
export function definesRight(body: unknown, entry: ToolRight): boolean {
  const stack: { value: unknown; context: readonly string[] }[] = [
    { value: body, context: [] },
  ];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, context } = item;
    if (Array.isArray(value)) {
      for (const inner of value) {
        stack.push({ value: inner, context });
      }
      continue;
    }
    if (!isObject(value)) {
      continue;
    }
    const texts = Object.values(value).filter(
      (inner): inner is string => typeof inner === 'string',
    );
    const here = [...context, ...texts];
    if (
      (Object.hasOwn(value, entry.right) || texts.includes(entry.right)) &&
      (here.includes(entry.module) || Object.hasOwn(value, entry.module))
    ) {
      return true;
    }
    for (const [key, inner] of Object.entries(value)) {
      stack.push({ value: inner, context: [...here, key] });
    }
  }
  return false;
}

const rightName = /^[a-z]+(?: [a-z]+){1,5}$/;

// Fields whose text names a right, in an answer that lists rights as
// objects instead of keys.
const rightFields: ReadonlySet<string> = new Set([
  'auth',
  'key',
  'name',
  'permission',
  'right',
]);

interface DefinitionsWalk {
  readonly strings: Set<string>;
  readonly names: Set<string>;
  lists: number;
}

// Collects every key and text of the answer and counts the lists of
// objects that each carry an ID and a name. As names of rights it takes
// only what has the form of a right with more than one word and stands
// where a right stands: a key whose value is an object, or the text of a
// field that names a right. Other texts of that form, such as a label,
// would count descriptions that name no right.
function walkDefinitions(body: unknown): DefinitionsWalk {
  const walk: DefinitionsWalk = {
    strings: new Set(),
    names: new Set(),
    lists: 0,
  };
  const isRightName = (text: string): boolean =>
    text.length <= 60 && rightName.test(text);
  const stack: unknown[] = [body];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (typeof value === 'string') {
      walk.strings.add(value);
    } else if (Array.isArray(value)) {
      if (
        value.length > 0 &&
        value.every(
          (inner) =>
            isObject(inner) &&
            typeof inner['id'] === 'number' &&
            ['name', 'caption', 'title', 'label', 'bezeichnung'].some(
              (key) => typeof inner[key] === 'string',
            ),
        )
      ) {
        walk.lists += 1;
      }
      for (const inner of value as unknown[]) {
        stack.push(inner);
      }
    } else if (isObject(value)) {
      for (const [key, inner] of Object.entries(value)) {
        walk.strings.add(key);
        if (
          (isObject(inner) && isRightName(key)) ||
          (typeof inner === 'string' &&
            rightFields.has(key) &&
            isRightName(inner))
        ) {
          walk.names.add(typeof inner === 'string' ? inner : key);
        }
        stack.push(inner);
      }
    }
  }
  return walk;
}

/** What the probe learns from the definitions of the rights. */
export interface Definitions {
  /** The description for the output. */
  readonly output: Json;
  /** Names of rights with more than one word, if the answer was read. */
  readonly names: ReadonlySet<string> | undefined;
}

/**
 * Reads the definitions of the rights, if the instance documents the
 * operation, and describes them without any of their names or values.
 *
 * @param client - Client of the instance.
 * @param document - The OpenAPI document of the instance.
 * @param categories - Names of the wiki categories the account sees.
 * @param guard - Receives every word the description uses.
 * @returns The description and the names of rights for the descriptions.
 */
export async function readDefinitions(
  client: Client,
  document: OpenApiDocument,
  categories: readonly string[],
  guard: Guard,
): Promise<Definitions> {
  const { method, template } = operations.permissionsDefinitions;
  const operation = findOperation(document, method, template);
  if (operation === undefined) {
    return { output: 'nicht dokumentiert', names: undefined };
  }
  const response = await client.get({ path: template });
  const answer = describeResponse(response, {
    guard,
    schemas: new Schemas(document),
    operation,
    maxFields: 10,
  });
  if (response.status !== 200 || response.kind !== 'JSON') {
    return { output: { antwort: answer }, names: undefined };
  }
  const walk = walkDefinitions(response.body);
  return {
    output: {
      antwort: answer,
      module: Object.fromEntries(
        knownModules.map((name) => [
          name,
          walk.strings.has(name) ? 'vorhanden' : 'fehlt',
        ]),
      ),
      rechteDerTools: Object.fromEntries(
        toolRights.map((entry) => [
          toolRightName(entry),
          definesRight(response.body, entry) ? 'definiert' : 'fehlt',
        ]),
      ),
      namen: countClass(walk.names.size),
      werteDerInstanz: {
        kategorienamen:
          categories.length === 0
            ? 'unbekannt'
            : categories.some((name) => walk.strings.has(name))
              ? 'ja'
              : 'nein',
        auswahllisten: countClass(walk.lists),
      },
    },
    names: walk.names,
  };
}

/** At most this many pages of one list, so a wrong header cannot loop. */
export const maxListPages = 40;

/** At most this many other languages are counted. */
export const maxOtherLanguages = 3;

const slugForm = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const yearMonthForm = /^(\d{4})-(\d{2})/;

/**
 * Reads a count from a header of WordPress, such as `X-WP-Total`.
 *
 * @param response - An answer of the academy.
 * @param name - Name of the header.
 * @returns The count, or `undefined` if the header is missing or holds no count.
 */
function headerCount(
  response: AcademyResponse,
  name: string,
): number | undefined {
  const value = response.headers.get(name)?.trim();
  return value !== undefined && /^\d{1,7}$/.test(value)
    ? Number(value)
    : undefined;
}

// The path with its query, encoded as the client sends it, so that
// robots.txt judges the very request.
function withQuery(
  path: string,
  query: readonly (readonly [string, string])[],
): string {
  const search = new URLSearchParams();
  for (const [name, value] of query) {
    search.append(name, value);
  }
  return `${path}?${search.toString()}`;
}

/** What reading one list of the academy gave. */
interface ListResult {
  /** The number of entries the academy reports, if it does. */
  readonly total: number | undefined;
  /** The number of entries read. */
  readonly read: number;
  /** Whether robots.txt forbade one of its pages, so reading stopped. */
  readonly blocked: boolean;
}

// Reads a list page by page and hands each entry to `visit`, so that the
// texts of hundreds of pages are never held at once. Before each page it
// asks robots.txt about the path with its query.
async function readList(
  academy: AcademyClient,
  rules: RobotsRules,
  path: string,
  perPage: number,
  fields: string,
  visit: (entry: JsonObject) => void,
): Promise<ListResult> {
  let total: number | undefined;
  let read = 0;
  let pages = 1;
  for (let page = 1; page <= pages; page += 1) {
    const query = [
      ['per_page', String(perPage)],
      ['page', String(page)],
      ['_fields', fields],
    ] as const;
    if (!robotsAllow(rules, withQuery(path, query))) {
      return { total, read, blocked: true };
    }
    const response = await academy.get({ path, query });
    if (response.status !== 200 || !Array.isArray(response.body)) {
      break;
    }
    if (page === 1) {
      pages = Math.max(
        1,
        Math.min(headerCount(response, 'x-wp-totalpages') ?? 1, maxListPages),
      );
      total = headerCount(response, 'x-wp-total');
    }
    for (const entry of response.body as unknown[]) {
      if (isObject(entry)) {
        read += 1;
        visit(entry);
      }
    }
  }
  return { total, read, blocked: false };
}

/** A term of a taxonomy of the academy: its slug and its parent. */
interface Term {
  readonly slug: string;
  readonly parent: number;
}

function termsOf(entries: readonly JsonObject[]): Map<number, Term> {
  const terms = new Map<number, Term>();
  for (const entry of entries) {
    const id = entry['id'];
    const slug = entry['slug'];
    const parent = entry['parent'];
    if (typeof id === 'number' && typeof slug === 'string') {
      terms.set(id, { slug, parent: typeof parent === 'number' ? parent : 0 });
    }
  }
  return terms;
}

// The section of a term is its topmost ancestor. A loop in the parents
// ends the walk at the term seen twice.
function rootOf(terms: ReadonlyMap<number, Term>, id: number): number {
  const seen = new Set<number>();
  let current = id;
  for (;;) {
    const term = terms.get(current);
    if (term === undefined || term.parent === 0 || seen.has(current)) {
      return current;
    }
    seen.add(current);
    current = term.parent;
  }
}

/** What the probe counts for one section. */
interface Section {
  pages: number;
  bytes: number;
}

function addTo(
  sections: Map<string, Section>,
  name: string,
  bytes: number,
): void {
  const section = sections.get(name) ?? { pages: 0, bytes: 0 };
  section.pages += 1;
  section.bytes += bytes;
  sections.set(name, section);
}

function idsOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((id): id is number => typeof id === 'number')
    : [];
}

/** The classes of the links of a help page. */
export const linkClasses = [
  'academy',
  'relativ',
  'email',
  ...hostClasses,
] as const;

/**
 * Puts the target of a link into its class.
 *
 * @param link - The target as the page writes it.
 * @param instanceHost - Host of the instance in lower case.
 * @returns The class of the target.
 */
export function classifyLink(
  link: string,
  instanceHost: string,
): (typeof linkClasses)[number] {
  if (/^mailto:/i.test(link)) {
    return 'email';
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(link) && !link.startsWith('//')) {
    return 'relativ';
  }
  const url = URL.parse(link, academyOrigin);
  if (url === null) {
    return 'andererHost';
  }
  if (url.origin === academyOrigin) {
    return 'academy';
  }
  return classifyHost(url.hostname, instanceHost);
}

/** At most this many sections or knowledge bases appear by name. */
export const maxSections = 100;

function namedSections(
  sections: ReadonlyMap<string, Section>,
  hiddenLabel: string,
  guard: Guard,
): Json {
  const result: Record<string, Json> = {};
  let hidden = 0;
  const sorted = [...sections].sort(byName);
  if (sorted.length > maxSections) {
    // The slugs come from outside. A cap keeps them from filling the
    // output, whatever the academy sends.
    result['weitere'] = countClass(sorted.length - maxSections);
  }
  for (const [name, section] of sorted.slice(0, maxSections)) {
    let shown = name;
    if (name === '') {
      // Pages without a term of this taxonomy.
      shown = 'ohneZuordnung';
    } else if (slugForm.test(name) && name.length <= 64) {
      guard.allowPublic(name);
    } else {
      hidden += 1;
      shown = `<${hiddenLabel}#${String(hidden)}>`;
      guard.allowFixed(shown);
    }
    const size = formatSize(section.bytes);
    guard.allowFixed(size);
    result[shown] = { seiten: count(guard, section.pages), text: size };
  }
  return result;
}

/**
 * Reads the help pages of the academy and describes them with counts,
 * classes and the slugs of their sections.
 *
 * @param academy - The client for the academy.
 * @param instanceHost - Host of the instance in lower case.
 * @param guard - Receives every word the description uses.
 * @returns The description.
 */
export async function readAcademy(
  academy: AcademyClient,
  instanceHost: string,
  guard: Guard,
): Promise<Json> {
  const robotsAnswer = await academy.get({ path: '/robots.txt' });
  guard.allowFixed(robotsAnswer.status);
  // A page in place of the file, such as a challenge in HTML, would read as
  // a file without rules. Only plain text counts as robots.txt.
  const plainText = (robotsAnswer.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('text/plain');
  if (
    (robotsAnswer.status !== 200 && robotsAnswer.status !== 404) ||
    (robotsAnswer.status === 200 && !plainText)
  ) {
    return {
      robots: { status: robotsAnswer.status },
      gelesen: 'nein',
      grund: 'robots.txt nicht lesbar',
    };
  }
  const rules = parseRobots(
    robotsAnswer.status === 200 ? robotsAnswer.text : '',
    userAgent,
  );
  const allowed = academyPaths.every((path) => robotsAllow(rules, path));
  const delay = rules.crawlDelay;
  const robots: Json = {
    status: robotsAnswer.status,
    eigeneGruppe: rules.ownGroup ? 'ja' : 'nein',
    gruppeFuerAlle: rules.starGroup ? 'ja' : 'nein',
    pfade: Object.fromEntries(
      academyPaths.map((path) => [
        path,
        robotsAllow(rules, path) ? 'erlaubt' : 'verboten',
      ]),
    ),
    crawlDelay: delay === undefined ? 'fehlt' : count(guard, delay),
    sitemap: rules.sitemap ? 'ja' : 'nein',
  };
  if (!allowed) {
    return { robots, gelesen: 'nein', grund: 'robots.txt verbietet' };
  }
  if (delay !== undefined) {
    if (delay * 1000 > maxAcademyPauseMs) {
      return { robots, gelesen: 'nein', grund: 'Crawl-delay zu lang' };
    }
    academy.slowDown(delay * 1000);
  }

  const help = await academy.get({ path: '/de/help/' });
  guard.allowFixed(help.status);
  const languages = help.status === 200 ? hreflangCodes(help.text) : [];
  for (const language of languages) {
    guard.allowPublic(language);
  }

  const index = await academy.get({ path: '/de/wp-json/' });
  guard.allowFixed(index.status);
  const namespaces =
    isObject(index.body) && Array.isArray(index.body['namespaces'])
      ? (index.body['namespaces'] as unknown[])
      : [];
  const routes =
    isObject(index.body) && isObject(index.body['routes'])
      ? index.body['routes']
      : {};
  const interfaceDescription: Json = {
    status: index.status,
    namensraeume: Object.fromEntries(
      academyNamespaces.map((name) => [
        name,
        namespaces.includes(name) ? 'vorhanden' : 'fehlt',
      ]),
    ),
    routen: Object.fromEntries(
      academyRoutes.map((route) => [
        route,
        Object.hasOwn(routes, route) ? 'vorhanden' : 'fehlt',
      ]),
    ),
  };
  if (index.status !== 200 || !Object.hasOwn(routes, '/wp/v2/docs')) {
    return {
      robots,
      hilfe: { status: help.status, sprachen: languages },
      schnittstelle: interfaceDescription,
      gelesen: 'nein',
      grund: 'Schnittstelle ohne Hilfeseiten',
    };
  }

  const categoryEntries: JsonObject[] = [];
  const categories = await readList(
    academy,
    rules,
    '/de/wp-json/wp/v2/doc_category',
    100,
    'id,slug,parent',
    (entry) => categoryEntries.push(entry),
  );
  const baseEntries: JsonObject[] = [];
  const bases = await readList(
    academy,
    rules,
    '/de/wp-json/wp/v2/knowledge_base',
    100,
    'id,slug,parent',
    (entry) => baseEntries.push(entry),
  );
  const categoryTerms = termsOf(categoryEntries);
  const baseTerms = termsOf(baseEntries);

  const sections = new Map<string, Section>();
  const knowledgeBases = new Map<string, Section>();
  const years = new Map<string, number>();
  const features = { bilder: 0, videos: 0, tabellen: 0, code: 0 };
  const links = new Map<string, number>();
  const textHosts = new Map<string, number>();
  let published = 0;
  let protectedPages = 0;
  let htmlBytes = 0;
  let textBytes = 0;
  let oldest: string | undefined;
  let newest: string | undefined;
  const visit = (doc: JsonObject): void => {
    if (doc['status'] === 'publish') {
      published += 1;
    }
    const content = isObject(doc['content']) ? doc['content'] : {};
    if (content['protected'] === true) {
      protectedPages += 1;
    }
    const html =
      typeof content['rendered'] === 'string' ? content['rendered'] : '';
    const found = pageFeatures(html);
    const bytes = Buffer.byteLength(found.text, 'utf8');
    htmlBytes += Buffer.byteLength(html, 'utf8');
    textBytes += bytes;
    if (found.images) features.bilder += 1;
    if (found.videos) features.videos += 1;
    if (found.tables) features.tabellen += 1;
    if (found.code) features.code += 1;
    const linkSeen = new Set(
      found.links.map((link) => classifyLink(link, instanceHost)),
    );
    for (const name of linkSeen) {
      links.set(name, (links.get(name) ?? 0) + 1);
    }
    const hostCounts = emptyCounts();
    countHosts(found.text, instanceHost, hostCounts);
    for (const name of hostClasses) {
      if (hostCounts.hosts[name] > 0) {
        textHosts.set(name, (textHosts.get(name) ?? 0) + 1);
      }
    }
    const modified = doc['modified_gmt'];
    const month =
      typeof modified === 'string' ? yearMonthForm.exec(modified) : null;
    if (month !== null) {
      const yearMonth = `${month[1] ?? ''}-${month[2] ?? ''}`;
      const year = month[1] ?? '';
      years.set(year, (years.get(year) ?? 0) + 1);
      oldest = oldest === undefined || yearMonth < oldest ? yearMonth : oldest;
      newest = newest === undefined || yearMonth > newest ? yearMonth : newest;
    }
    const roots = new Set(
      idsOf(doc['doc_category']).map((id) => rootOf(categoryTerms, id)),
    );
    if (roots.size === 0) {
      addTo(sections, '', bytes);
    }
    for (const root of roots) {
      addTo(sections, categoryTerms.get(root)?.slug ?? '', bytes);
    }
    const baseRoots = new Set(
      idsOf(doc['knowledge_base']).map((base) => rootOf(baseTerms, base)),
    );
    if (baseRoots.size === 0) {
      addTo(knowledgeBases, '', bytes);
    }
    for (const root of baseRoots) {
      addTo(knowledgeBases, baseTerms.get(root)?.slug ?? '', bytes);
    }
  };
  // Only these fields: never the authors, who are people.
  const docs = await readList(
    academy,
    rules,
    '/de/wp-json/wp/v2/docs',
    50,
    'id,status,modified_gmt,content,doc_category,knowledge_base',
    visit,
  );
  if (categories.blocked || bases.blocked || docs.blocked) {
    return {
      robots,
      hilfe: { status: help.status, sprachen: languages },
      schnittstelle: interfaceDescription,
      gelesen: 'nein',
      grund: 'robots.txt verbietet',
    };
  }
  for (const word of [oldest, newest, ...years.keys()]) {
    if (word !== undefined) {
      guard.allowPublic(word);
    }
  }
  guard.allowFixed(formatSize(htmlBytes), formatSize(textBytes));

  const others: Record<string, Json> = {};
  for (const code of languages
    .filter((language) => /^[a-z]{2}$/.test(language) && language !== 'de')
    .slice(0, maxOtherLanguages)) {
    const path = `/${code}/wp-json/wp/v2/docs`;
    const query = [
      ['per_page', '1'],
      ['_fields', 'id'],
    ] as const;
    if (!robotsAllow(rules, withQuery(path, query))) {
      others[code] = 'verboten';
      continue;
    }
    const answer = await academy.get({ path, query });
    const reported = headerCount(answer, 'x-wp-total');
    others[code] =
      answer.status === 200 && reported !== undefined
        ? publicCount(guard, reported)
        : 'unbekannt';
  }

  return {
    robots,
    hilfe: { status: help.status, sprachen: languages },
    schnittstelle: interfaceDescription,
    gelesen: 'ja',
    seiten: {
      gemeldet:
        docs.total === undefined ? 'unbekannt' : publicCount(guard, docs.total),
      gelesen: count(guard, docs.read),
      veroeffentlicht: count(guard, published),
      geschuetzt: count(guard, protectedPages),
      groesse: { html: formatSize(htmlBytes), text: formatSize(textBytes) },
      geaendert:
        oldest === undefined || newest === undefined
          ? 'unbekannt'
          : {
              aeltestes: oldest,
              neuestes: newest,
              jeJahr: Object.fromEntries(
                [...years]
                  .sort(byName)
                  .map(([year, pages]) => [year, count(guard, pages)]),
              ),
            },
      merkmale: Object.fromEntries(
        Object.entries(features).map(([name, pages]) => [
          name,
          countClass(pages),
        ]),
      ),
      links: Object.fromEntries(
        linkClasses.map((name) => [name, countClass(links.get(name) ?? 0)]),
      ),
      hostsImText: Object.fromEntries(
        hostClasses.map((name) => [name, countClass(textHosts.get(name) ?? 0)]),
      ),
    },
    kategorien: count(guard, categoryTerms.size),
    abschnitte: namedSections(sections, 'abschnitt', guard),
    wissensbasen: namedSections(knowledgeBases, 'wissensbasis', guard),
    weitereSprachen: others,
  };
}

/**
 * Reads the academy like {@link readAcademy}, but a failed request there
 * ends only this part, with its fixed code, and the parts about the
 * instance still reach the output.
 *
 * @param academy - The client for the academy.
 * @param instanceHost - Host of the instance in lower case.
 * @param guard - Receives every word the description uses.
 * @returns The description, or the fixed code of the failure.
 */
export async function readAcademySafely(
  academy: AcademyClient,
  instanceHost: string,
  guard: Guard,
): Promise<Json> {
  try {
    return await readAcademy(academy, instanceHost, guard);
  } catch (error) {
    if (error instanceof SpikeError) {
      return { gelesen: 'nein', grund: 'Fehler', fehler: error.code };
    }
    throw error;
  }
}

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '10-docs-sources',
  state: 'read',
  academy: true,
  async run({ academy, client, guard, origin, state }): Promise<Json> {
    guard.allowFixed(...words);
    if (state === undefined || academy === undefined) {
      throw new Error('INTERN');
    }
    if (state.version !== null) {
      guard.allowVersion(state.version);
    }
    const document = state.specification;
    const categories = await readCategories(client, document);
    const definitions = await readDefinitions(
      client,
      document,
      categories.names,
      guard,
    );
    const instanceHost = new URL(origin).hostname.toLowerCase();
    return {
      probe: '10-docs-sources',
      churchtoolsVersion: state.version ?? 'unbekannt',
      testinstanz: categories.testInstance,
      openapi: describeDocument(
        state,
        instanceHost,
        categories.testInstance === 'ja',
        definitions.names,
        guard,
      ),
      rechte: { definitionen: definitions.output },
      academy: await readAcademySafely(academy, instanceHost, guard),
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
