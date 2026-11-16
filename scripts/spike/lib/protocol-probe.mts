/**
 * What the probe of the protocol version records, and how.
 *
 * The probe stands in front of the MCP SDK and notes for every request which
 * protocol headers and which version in the body a client sends, before the
 * SDK answers. Every recorded value is a fixed word of this module or a
 * value in a fixed form, such as a version `2025-11-25`; anything else
 * becomes «anderer Wert». Addresses, the host, paths, other headers,
 * parameters and contents are never recorded (ADR 0073).
 *
 * These are pure functions without a socket, so the tests can feed them
 * hostile requests directly.
 *
 * @packageDocumentation
 */
import { Buffer } from 'node:buffer';

import type { Guard, Json } from './guard.mts';

/** The `_meta` key that puts a request into the era of 2026-07-28. */
export const protocolVersionMetaKey = 'io.modelcontextprotocol/protocolVersion';

/** The `_meta` key that names the client in the era of 2026-07-28. */
export const clientInfoMetaKey = 'io.modelcontextprotocol/clientInfo';

/**
 * U+FEFF, the byte order mark, built from its code so that no editor drops
 * or hides it in the source.
 */
export const byteOrderMark = String.fromCharCode(0xfeff);

/**
 * Versions the SDK 2.3.1 serves, as its sources list them: five of the era
 * 2025 and one of the era 2026.
 */
export const supportedVersions = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;

/** The one version of the era 2026 the SDK 2.3.1 serves. */
export const modernVersion = '2026-07-28';

/** Methods recorded by name. Any other method is «andere Methode». */
export const knownMethods = [
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'ping',
  'server/discover',
  'tools/list',
  'tools/call',
  'prompts/list',
  'prompts/get',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'subscriptions/listen',
  'logging/setLevel',
  'completion/complete',
] as const;

/** Public addresses of the clients of the probe, recorded as they are. */
export const knownOrigins = [
  'https://claude.ai',
  'https://chatgpt.com',
  'https://chat.openai.com',
] as const;

/** Labels of the paths the probe hands out, one per client. */
export const pathLabels = ['k1', 'k2', 'k3'] as const;

/** One of the labels of the paths. */
export type PathLabel = (typeof pathLabels)[number];

// Well-known documents a client may look for before it connects, by the
// segment after `/.well-known/`.
const wellKnownNames = [
  'oauth-protected-resource',
  'oauth-authorization-server',
  'openid-configuration',
] as const;

// The field of the body that the header Mcp-Name repeats, for the methods
// the SDK 2.3.1 checks it on (besides the methods of tasks, which the probe
// does not offer).
function nameField(method: string | undefined): string | undefined {
  switch (method) {
    case 'tools/call':
    case 'prompts/get':
      return 'name';
    case 'resources/read':
      return 'uri';
    default:
      return undefined;
  }
}

const versionForm = /^\d{4}-\d{2}-\d{2}$/;
// A name without dots, so it cannot be a host name; a client chooses it, so
// it is short.
const clientNameForm = /^[A-Za-z0-9][A-Za-z0-9_ -]{0,47}$/;
// A version of at most three numbers with an optional suffix, so a client
// cannot put a word of its choice or an IPv4 address there.
const clientVersionForm =
  /^\d{1,9}(?:\.\d{1,9}){0,2}(?:[-+][0-9A-Za-z.]{1,16})?$/;
const base64Prefix = '=?base64?';
const base64Suffix = '?=';
const base64Canonical =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Fixed words of the output, keys and values. */
export const outputWords = [
  // keys
  'probe',
  'datum',
  'modus',
  'sdk',
  'ende',
  'anfragen',
  'zurueckgehalten',
  'stellen',
  'pfade',
  'formen',
  'clients',
  'anzahl',
  'nr',
  'sekunde',
  'pfad',
  'zu',
  'httpMethode',
  'nachricht',
  'methode',
  'kopfzeile',
  'koerper',
  'umschlag',
  'mcpMethod',
  'mcpName',
  'origin',
  'accept',
  'authorization',
  'sitzung',
  'client',
  'name',
  'version',
  'streng',
  'angeglichen',
  'status',
  'fehler',
  'ausgehandelt',
  'angeboten',
  'von',
  'antwort',
  'SSE',
  'JSON',
  'fremd',
  'wellKnown',
  'ohneAufzeichnung',
  'kopfzeilenZuGross',
  'ungueltigeAnfrage',
  'frist',
  'expect',
  'verbindungenAbgewiesen',
  // values
  '14-protocol-version',
  'nachsichtig',
  'Frist',
  'Obergrenze',
  'Signal',
  ...pathLabels,
  ...wellKnownNames,
  'well-known',
  'POST',
  'GET',
  'DELETE',
  'andere',
  'Anfrage',
  'Benachrichtigung',
  'Antwort',
  'Stapel',
  'ungültig',
  'leer',
  'zu gross',
  ...knownMethods,
  'andere Methode',
  'keine',
  'fehlt',
  'anderer Wert',
  'ja',
  'nein',
  'gleich',
  'gleich (Base64)',
  'anders',
  'nicht verlangt',
  'vorhanden',
  ...knownOrigins,
  'JSON und SSE',
  'nur JSON',
  'nur SSE',
  'SDK',
  'Attrappe',
  'Zeitlimit',
  ...supportedVersions,
] as const;

/** Where a request went, as far as the probe tells paths apart. */
export interface PathClass {
  /** A label of a client, «fremd», or the name of a well-known document. */
  readonly pfad: string;
  /** For a well-known document, the client whose path it names. */
  readonly zu?: PathLabel;
  /** Whether the request goes on to the SDK. */
  readonly mcp: boolean;
}

/**
 * Tells a path apart without keeping it.
 *
 * @param path - The path of the request, without query.
 * @param paths - The random paths of the clients, in the order of the labels.
 * @returns The class of the path.
 */
export function classifyPath(
  path: string,
  paths: readonly string[],
): PathClass {
  const trimmed =
    path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const index = paths.indexOf(trimmed);
  if (index !== -1) {
    return { pfad: pathLabels[index] ?? 'fremd', mcp: true };
  }
  const segments = trimmed.split('/');
  if (segments[1] === '.well-known') {
    const name = segments[2] ?? '';
    const known = (wellKnownNames as readonly string[]).includes(name)
      ? name
      : 'well-known';
    const rest = `/${segments.slice(3).join('/')}`;
    const owner = paths.indexOf(rest);
    const zu = pathLabels[owner];
    return zu === undefined
      ? { pfad: known, mcp: false }
      : { pfad: known, zu, mcp: false };
  }
  return { pfad: 'fremd', mcp: false };
}

/** What a request shows, before the SDK answers. */
export interface Observation {
  readonly pfad: string;
  readonly zu?: PathLabel;
  readonly httpMethode: string;
  readonly nachricht: string;
  readonly methode: string;
  readonly kopfzeile: string;
  readonly koerper: string;
  readonly umschlag: 'ja' | 'nein';
  readonly mcpMethod: string;
  readonly mcpName: string;
  readonly origin: string;
  readonly accept: string;
  readonly authorization: 'ja' | 'nein';
  readonly sitzung: 'ja' | 'nein';
  readonly client?: { readonly name: string; readonly version: string };
}

/** The parts of a request the probe looks at. */
export interface ProbeRequest {
  /** HTTP method. */
  readonly method: string;
  /** Path without query. */
  readonly path: string;
  /** All headers, as received. */
  readonly headers: Headers;
  /** The body as text. */
  readonly body: string | undefined;
  /** Whether the body went over the limit; it is then not kept. */
  readonly tooLarge?: boolean;
}

/** A body, parsed only as far as the probe needs it. */
export interface ParsedBody {
  /** The kind of message. */
  readonly nachricht: string;
  /** The message, if it is one object. */
  readonly message?: Readonly<Record<string, unknown>>;
}

/**
 * Parses a body without trusting it.
 *
 * @param body - The body as text.
 * @param tooLarge - Whether the body went over the limit.
 * @returns The kind of message and, for a single object, the object.
 */
export function parseBody(
  body: string | undefined,
  tooLarge = false,
): ParsedBody {
  if (tooLarge) {
    return { nachricht: 'zu gross' };
  }
  if (body === undefined || body.trim() === '') {
    return { nachricht: 'leer' };
  }
  let parsed: unknown;
  try {
    // The SDK decodes the body with a TextDecoder, which drops a leading
    // byte order mark; read it the same way, or a request it serves would
    // count as invalid here.
    parsed = JSON.parse(body.startsWith(byteOrderMark) ? body.slice(1) : body);
  } catch {
    // Also a body nested too deep for the parser.
    return { nachricht: 'ungültig' };
  }
  if (Array.isArray(parsed)) {
    return { nachricht: 'Stapel' };
  }
  if (!isRecord(parsed)) {
    return { nachricht: 'ungültig' };
  }
  const hasMethod = typeof parsed['method'] === 'string';
  const hasId =
    typeof parsed['id'] === 'string' || typeof parsed['id'] === 'number';
  const nachricht = hasMethod
    ? hasId
      ? 'Anfrage'
      : 'Benachrichtigung'
    : 'result' in parsed || 'error' in parsed
      ? 'Antwort'
      : 'ungültig';
  return { nachricht, message: parsed };
}

/**
 * Records what a request shows: headers of the protocol, the version in the
 * body and the client, each as a fixed word or in a fixed form.
 *
 * @param request - The request.
 * @param path - The class of its path.
 * @returns The observation.
 */
export function observe(request: ProbeRequest, path: PathClass): Observation {
  const { nachricht, message } = parseBody(
    request.body,
    request.tooLarge === true,
  );
  const method =
    typeof message?.['method'] === 'string' ? message['method'] : undefined;
  const params = isRecord(message?.['params']) ? message['params'] : undefined;
  const meta = isRecord(params?.['_meta']) ? params['_meta'] : undefined;
  const envelope = meta !== undefined && protocolVersionMetaKey in meta;
  const bodyVersion = envelope
    ? meta[protocolVersionMetaKey]
    : method === 'initialize'
      ? params?.['protocolVersion']
      : undefined;
  const clientInfo = envelope
    ? meta[clientInfoMetaKey]
    : method === 'initialize'
      ? params?.['clientInfo']
      : undefined;
  // The name of a client is text it chooses. Only a request on the path of
  // a client keeps it, not one from whoever finds the address.
  const client = path.mcp ? describeClient(clientInfo) : undefined;
  const base: Observation = {
    pfad: path.pfad,
    httpMethode: ['POST', 'GET', 'DELETE'].includes(request.method)
      ? request.method
      : 'andere',
    nachricht,
    methode:
      method === undefined
        ? 'keine'
        : (knownMethods as readonly string[]).includes(method)
          ? method
          : 'andere Methode',
    kopfzeile: versionWord(
      request.headers.get('mcp-protocol-version') ?? undefined,
    ),
    koerper: versionWord(bodyVersion),
    umschlag: envelope ? 'ja' : 'nein',
    mcpMethod: compareHeader(request.headers.get('mcp-method'), method),
    mcpName: nameHeader(request.headers.get('mcp-name'), method, params),
    origin: originWord(request.headers.get('origin')),
    accept: acceptWord(request.headers.get('accept')),
    authorization: request.headers.has('authorization') ? 'ja' : 'nein',
    sitzung: request.headers.has('mcp-session-id') ? 'ja' : 'nein',
  };
  return {
    ...base,
    ...(path.zu === undefined ? {} : { zu: path.zu }),
    ...(client === undefined ? {} : { client }),
  };
}

/**
 * The value of a version header or field, as a word.
 *
 * @param value - The value as sent.
 * @returns The version in the form `JJJJ-MM-TT`, «fehlt» or «anderer Wert».
 */
export function versionWord(value: unknown): string {
  if (value === undefined || value === null) {
    return 'fehlt';
  }
  return typeof value === 'string' && versionForm.test(value)
    ? value
    : 'anderer Wert';
}

function describeClient(
  value: unknown,
): { readonly name: string; readonly version: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const name = value['name'];
  const version = value['version'];
  return {
    name:
      typeof name === 'string' && clientNameForm.test(name)
        ? name
        : 'anderer Wert',
    version:
      typeof version === 'string' && clientVersionForm.test(version)
        ? version
        : 'anderer Wert',
  };
}

function compareHeader(
  header: string | null,
  value: string | undefined,
): string {
  if (header === null) {
    return 'fehlt';
  }
  return value !== undefined && stripSpace(header) === value
    ? 'gleich'
    : 'anders';
}

function nameHeader(
  header: string | null,
  method: string | undefined,
  params: Readonly<Record<string, unknown>> | undefined,
): string {
  // The same steps as validateStandardRequestHeaders of the SDK 2.3.1: a
  // header is needed only when the body carries the field as text, a
  // header in Base64 is decoded first, and a header without a field in the
  // body passes if it decodes.
  const field = nameField(method);
  if (field === undefined) {
    return header === null ? 'nicht verlangt' : 'vorhanden';
  }
  const expected = params?.[field];
  const bodyValue = typeof expected === 'string' ? expected : undefined;
  if (header === null) {
    return bodyValue === undefined ? 'nicht verlangt' : 'fehlt';
  }
  const value = stripSpace(header);
  const encoded =
    value.startsWith(base64Prefix) && value.endsWith(base64Suffix);
  const decoded = encoded ? decodeBase64(value) : value;
  if (decoded === undefined) {
    return 'ungültig';
  }
  if (bodyValue === undefined) {
    return 'vorhanden';
  }
  if (decoded !== bodyValue) {
    return 'anders';
  }
  return encoded ? 'gleich (Base64)' : 'gleich';
}

function decodeBase64(value: string): string | undefined {
  const text = value.slice(base64Prefix.length, -base64Suffix.length);
  if (!base64Canonical.test(text)) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(text, 'base64'),
    );
  } catch {
    return undefined;
  }
}

function originWord(value: string | null): string {
  if (value === null) {
    return 'fehlt';
  }
  return (knownOrigins as readonly string[]).includes(value)
    ? value
    : 'anderer Wert';
}

function acceptWord(value: string | null): string {
  if (value === null) {
    return 'fehlt';
  }
  const lower = value.toLowerCase();
  const json = lower.includes('application/json');
  const sse = lower.includes('text/event-stream');
  return json && sse
    ? 'JSON und SSE'
    : json
      ? 'nur JSON'
      : sse
        ? 'nur SSE'
        : 'andere';
}

// Spaces and tabs at both ends, as HTTP allows around a header value. A
// loop, not a regular expression, which would take quadratic time on a
// long run of spaces inside the value.
function stripSpace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) {
    start += 1;
  }
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) {
    end -= 1;
  }
  return value.slice(start, end);
}

/** What an answer shows. */
export interface Verdict {
  /** HTTP status. */
  readonly status: number;
  /** Who answered: the SDK or the probe itself. */
  readonly von: 'SDK' | 'Attrappe';
  /** How the SDK answered: a stream of server-sent events, JSON or nothing. */
  readonly antwort?: 'SSE' | 'JSON' | 'leer';
  /** JSON-RPC error code, if the answer is an error. */
  readonly fehler?: number;
  /** The version the answer to `initialize` names. */
  readonly ausgehandelt?: string;
  /** Versions an answer offers, from `server/discover` or an error. */
  readonly angeboten?: readonly string[];
}

/**
 * Reads what an answer says about the protocol: status, error code and
 * versions. A stream of server-sent events counts by its first message.
 *
 * @param status - HTTP status.
 * @param contentType - Content type of the answer.
 * @param body - Body of the answer.
 * @returns The verdict of the SDK.
 */
export function readVerdict(
  status: number,
  contentType: string | null,
  body: string,
): Verdict {
  const message = firstMessage(contentType, body);
  const error = isRecord(message?.['error']) ? message['error'] : undefined;
  const result = isRecord(message?.['result']) ? message['result'] : undefined;
  const code = error?.['code'];
  const data = isRecord(error?.['data']) ? error['data'] : undefined;
  const offered = versionList(
    result?.['supportedVersions'] ?? data?.['supported'],
  );
  const negotiated = result?.['protocolVersion'];
  return {
    status,
    von: 'SDK',
    ...(typeof code === 'number' &&
    Number.isInteger(code) &&
    Math.abs(code) < 100_000
      ? { fehler: code }
      : {}),
    ...(negotiated === undefined
      ? {}
      : { ausgehandelt: versionWord(negotiated) }),
    ...(offered === undefined ? {} : { angeboten: offered }),
  };
}

function firstMessage(
  contentType: string | null,
  body: string,
): Readonly<Record<string, unknown>> | undefined {
  const texts = (contentType ?? '').toLowerCase().includes('text/event-stream')
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length))
    : [body];
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON: the next line may be.
    }
  }
  return undefined;
}

function versionList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.slice(0, 10).map((item) => versionWord(item));
}

/**
 * Tells whether the prepared rule of ADR 0073 applies: a request other than
 * `initialize` claims the version 2026-07-28 in its envelope, the header
 * names another supported version, and the SDK refused exactly that with
 * 400 and -32020. `initialize` with a header of 2026 is another refusal of
 * the SDK, which the rule does not cover.
 *
 * @param observation - What the request showed.
 * @param strict - The answer of the SDK to the request as sent.
 * @returns The version of the body, if the header is to follow it.
 */
export function adjustment(
  observation: Observation,
  strict: Verdict,
): string | undefined {
  const supported = supportedVersions as readonly string[];
  if (
    observation.umschlag === 'ja' &&
    observation.methode !== 'initialize' &&
    observation.koerper === modernVersion &&
    supported.includes(observation.kopfzeile) &&
    observation.kopfzeile !== modernVersion &&
    strict.status === 400 &&
    strict.fehler === -32020
  ) {
    return observation.koerper;
  }
  return undefined;
}

/** One recorded request with the answers to it. */
export interface Entry {
  readonly nr: number;
  readonly sekunde: number;
  readonly observation: Observation;
  readonly streng: Verdict;
  readonly angeglichen?: Verdict;
}

/**
 * The output line of one entry.
 *
 * @param entry - The entry.
 * @returns The JSON of the line.
 */
export function entryJson(entry: Entry): Json {
  return { nr: entry.nr, sekunde: entry.sekunde, ...formJson(entry) };
}

// An entry without its number and second: what makes two requests alike.
function formJson(entry: Entry): Record<string, Json> {
  return {
    ...observationJson(entry.observation),
    streng: verdictJson(entry.streng),
    ...(entry.angeglichen === undefined
      ? {}
      : { angeglichen: verdictJson(entry.angeglichen) }),
  };
}

function observationJson(observation: Observation): Record<string, Json> {
  const { client, ...rest } = observation;
  return {
    ...rest,
    ...(client === undefined ? {} : { client: { ...client } }),
  };
}

function verdictJson(verdict: Verdict): Json {
  const { angeboten, ...rest } = verdict;
  return {
    ...rest,
    ...(angeboten === undefined ? {} : { angeboten: [...angeboten] }),
  };
}

/** How a run ended. */
export type Ending = 'Frist' | 'Obergrenze' | 'Signal';

/** Facts about the run for the summary. */
export interface RunFacts {
  readonly datum: string;
  readonly modus: 'nachsichtig' | 'streng';
  readonly sdk: string;
  readonly ende: Ending;
  /** Every recorded request, held-back lines included. */
  readonly anfragen: number;
  readonly zurueckgehalten: number;
  /** Requests Node.js answered itself, by kind, with their count. */
  readonly ohneAufzeichnung: Readonly<Record<string, number>>;
}

/**
 * Sums up a run per path: how many requests, and each distinct form of a
 * request with its answers, with a count.
 *
 * @param entries - All recorded entries.
 * @param facts - Facts about the run.
 * @returns The summary.
 */
export function summarize(entries: readonly Entry[], facts: RunFacts): Json {
  interface Group {
    count: number;
    readonly forms: Map<
      string,
      { readonly form: Record<string, Json>; count: number }
    >;
  }
  // By the class of the path; for a well-known document the form names the
  // client in `zu`.
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const key = entry.observation.pfad;
    const group: Group = groups.get(key) ?? { count: 0, forms: new Map() };
    group.count += 1;
    const form = formJson(entry);
    const formKey = JSON.stringify(form);
    const known = group.forms.get(formKey);
    if (known === undefined) {
      group.forms.set(formKey, { form, count: 1 });
    } else {
      known.count += 1;
    }
    groups.set(key, group);
  }
  const pfade: Record<string, Json> = {};
  for (const [key, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    pfade[key] = {
      anfragen: group.count,
      formen: [...group.forms.values()].map(({ form, count }) => ({
        ...form,
        anzahl: count,
      })),
    };
  }
  return {
    probe: '14-protocol-version',
    datum: facts.datum,
    modus: facts.modus,
    sdk: facts.sdk,
    ende: facts.ende,
    anfragen: facts.anfragen,
    zurueckgehalten: facts.zurueckgehalten,
    ohneAufzeichnung: { ...facts.ohneAufzeichnung },
    pfade,
  };
}

/**
 * Replaces each value in a fixed form that the block list of the request
 * stops by «anderer Wert»: the versions, the name and version of the client,
 * the negotiated and the offered versions. A client name equal to a part of
 * the host, or a version made of a number from a forwarded address, then
 * costs only that value, not the line.
 *
 * @param guard - The guard of the request.
 * @param entry - The entry as recorded.
 * @returns The entry with every stopped value replaced.
 */
export function sanitizeEntry(guard: Guard, entry: Entry): Entry {
  const keep = (value: string): string =>
    guard.passesBlockList(value) ? value : 'anderer Wert';
  const keepVerdict = (verdict: Verdict): Verdict => ({
    ...verdict,
    ...(verdict.ausgehandelt === undefined
      ? {}
      : { ausgehandelt: keep(verdict.ausgehandelt) }),
    ...(verdict.angeboten === undefined
      ? {}
      : { angeboten: verdict.angeboten.map(keep) }),
  });
  const { observation } = entry;
  return {
    ...entry,
    observation: {
      ...observation,
      kopfzeile: keep(observation.kopfzeile),
      koerper: keep(observation.koerper),
      ...(observation.client === undefined
        ? {}
        : {
            client: {
              name: keep(observation.client.name),
              version: keep(observation.client.version),
            },
          }),
    },
    streng: keepVerdict(entry.streng),
    ...(entry.angeglichen === undefined
      ? {}
      : { angeglichen: keepVerdict(entry.angeglichen) }),
  };
}

/**
 * Allows the values of one entry that are in a fixed form rather than fixed
 * words: numbers the probe or the SDK produced, versions and client names.
 * Versions and names are checked against the block list as well.
 *
 * @param guard - The guard of the run.
 * @param entry - The entry.
 */
export function allowEntry(guard: Guard, entry: Entry): void {
  guard.allowFixed(entry.nr, entry.sekunde);
  const { observation } = entry;
  for (const word of [observation.kopfzeile, observation.koerper]) {
    if (versionForm.test(word)) {
      guard.allowChecked(word);
    }
  }
  if (observation.client !== undefined) {
    guard.allowChecked(observation.client.name);
    guard.allowChecked(observation.client.version);
  }
  for (const verdict of [entry.streng, entry.angeglichen]) {
    if (verdict === undefined) {
      continue;
    }
    guard.allowFixed(verdict.status);
    if (verdict.fehler !== undefined) {
      guard.allowFixed(verdict.fehler);
    }
    for (const word of [verdict.ausgehandelt, ...(verdict.angeboten ?? [])]) {
      if (word !== undefined && versionForm.test(word)) {
        guard.allowChecked(word);
      }
    }
  }
}

/** Header names whose values can identify a client, the host or a person. */
export const identifyingHeaders = [
  'host',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-real-ip',
  'forwarded',
  'cf-connecting-ip',
  'true-client-ip',
  'cookie',
  'authorization',
  'referer',
] as const;

/**
 * Puts what could identify the host, a client or a person on the block
 * list: the values of identifying headers, an unknown origin and the
 * address of the socket.
 *
 * @param guard - The guard of the run.
 * @param request - The request.
 * @param address - Address of the socket.
 */
export function blockRequest(
  guard: Guard,
  request: ProbeRequest,
  address: string | undefined,
): void {
  for (const name of identifyingHeaders) {
    const value = request.headers.get(name);
    if (value === null) {
      continue;
    }
    guard.block(value.trim());
    if (name === 'host' || name === 'x-forwarded-host') {
      // The name and each of its labels, as the other probes block the
      // host of an instance.
      const host = value.trim().replace(/:\d+$/, '');
      guard.block(host);
      for (const label of host.split('.')) {
        guard.block(label);
      }
    }
    // Lists such as X-Forwarded-For and pairs such as Forwarded or Cookie:
    // each address or value counts on its own. The scheme words are left
    // out, they would block the fixed origins of the clients.
    for (const piece of value.split(/[,;]/)) {
      const part = stripQuotes(piece.slice(piece.indexOf('=') + 1).trim());
      if (part !== '' && !['http', 'https'].includes(part.toLowerCase())) {
        guard.block(part);
      }
    }
  }
  const origin = request.headers.get('origin');
  if (
    origin !== null &&
    !(knownOrigins as readonly string[]).includes(origin)
  ) {
    guard.block(origin);
  }
  if (address !== undefined) {
    guard.block(address);
  }
}

// A double quote at either end, as Forwarded may quote an address. Plain
// string checks, so no anchor of a regular expression applies to only one
// side of an alternative.
function stripQuotes(value: string): string {
  const start = value.startsWith('"') ? 1 : 0;
  const end = value.length > start && value.endsWith('"') ? -1 : undefined;
  return value.slice(start, end);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
