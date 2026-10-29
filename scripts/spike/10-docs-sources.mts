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
 * Usage: see README.md in this folder.
 *
 * @packageDocumentation
 */
import type { SpikeState } from './lib/env.mts';
import { identificationCategoryName } from './lib/gate.mts';
import type { Guard, Json } from './lib/guard.mts';
import type { Client } from './lib/http.mts';
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

const bytesPerMebibyte = 1024 * 1024;

/**
 * Gives the size of a part of the document as text, so that no exact
 * number of bytes reaches the output.
 *
 * @param value - A part of the document.
 * @returns Size in MiB with one decimal, below 1 MiB in whole KiB rounded up.
 */
export function sizeOf(value: unknown): string {
  const bytes =
    value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
  return bytes < bytesPerMebibyte
    ? `${String(Math.ceil(bytes / 1024))} KiB`
    : `${(bytes / bytesPerMebibyte).toFixed(1)} MiB`;
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

interface DefinitionsWalk {
  readonly strings: Set<string>;
  readonly names: Set<string>;
  lists: number;
}

// Collects every key and text of the answer, the texts and keys that have
// the form of a right with more than one word, and counts the lists of
// objects that each carry an ID and a name.
function walkDefinitions(body: unknown): DefinitionsWalk {
  const walk: DefinitionsWalk = {
    strings: new Set(),
    names: new Set(),
    lists: 0,
  };
  const stack: unknown[] = [body];
  for (let value = stack.pop(); value !== undefined; value = stack.pop()) {
    if (typeof value === 'string') {
      walk.strings.add(value);
      if (value.length <= 60 && rightName.test(value)) {
        walk.names.add(value);
      }
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
        if (key.length <= 60 && rightName.test(key)) {
          walk.names.add(key);
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

/** The probe, for tests and for {@link main}. */
export const probe: ProbeDefinition = {
  name: '10-docs-sources',
  state: 'read',
  async run({ client, guard, origin, state }): Promise<Json> {
    guard.allowFixed(...words);
    if (state === undefined) {
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
    };
  },
};

if (import.meta.main) {
  process.exitCode = await main(probe, import.meta.url);
}
