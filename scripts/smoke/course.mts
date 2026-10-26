/**
 * The course of the smoke test in one server process.
 *
 * One process speaks one era of the protocol: 2026 opens with
 * `server/discover` and sends the metadata of the client with every
 * request, 2025 opens with `initialize`, as the chat of Claude Desktop
 * does (ADR 0053). In each process the smoke test lists the tools, calls
 * `ct_whoami` and, with the switch, the two search tools and the four
 * reads by ID with the first person and the first group they found, then
 * the events of up to three spans of 31 days from a week before the day of
 * the run, and
 * with the first event found the event, its agenda and its assignments,
 * and the services, closes stdin and checks how the process ended.
 *
 * Every check yields a fixed word. Values from the answers never go into
 * the result: they go onto the block list of the guard and into the list
 * of texts that must not appear in log and audit.
 *
 * @packageDocumentation
 */
import { containsWord, type Guard, type Json } from '../spike/lib/guard.mts';
import { countClass } from '../spike/lib/structure.mts';
import type { Answer, Ended, Session } from './session.mts';

/** One era of the protocol. */
export type Era = '2026' | '2025';

/** One call of a tool and the outcome the audit must show for it. */
export interface Call {
  readonly tool: string;
  /** `ok`, or an error with this code. */
  readonly expect: 'ok' | 'validation' | 'not_found';
}

/** What the course needs for the search tools. */
export interface SearchPlan {
  /** The term from the environment. */
  readonly query: string;
  /** A made-up term that matches nothing. */
  readonly missTerm: string;
  /** The spans of days to look for an event in, in order. */
  readonly spans: readonly EventSpan[];
}

/** A span of days for ct_events_list. */
export interface EventSpan {
  /** The first day, as `JJJJ-MM-TT`. */
  readonly from: string;
  /** The last day, as `JJJJ-MM-TT`. */
  readonly to: string;
}

/**
 * The three spans of 31 days, one after the other, in which the course
 * looks for an event (ADR 0064). The first starts a week before the UTC day
 * of the run, so that an event of the last days still counts.
 *
 * @param now - The time of the run.
 * @returns The spans, the earliest first.
 */
export function eventSpans(now: Date): readonly EventSpan[] {
  const day = (offset: number): string =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + offset,
      ),
    )
      .toISOString()
      .slice(0, 10);
  return [0, 1, 2].map((index) => ({
    from: day(index * 31 - 7),
    to: day(index * 31 + 23),
  }));
}

/** The outcome of the course in one process. */
export interface EraOutcome {
  /** Fixed words for the result. */
  readonly report: { readonly [key: string]: Json };
  /** Fixed codes of the checks that failed. */
  readonly failures: readonly string[];
  /** Fixed codes of findings that do not fail the run. */
  readonly findings: readonly string[];
  /** The calls in their order, for the check of the audit file. */
  readonly calls: readonly Call[];
  /** Texts from the answers that must appear in no log or audit line. */
  readonly seen: readonly string[];
}

/** The exit codes of `ecclium stdio` (docs/betrieb/stdio.md). */
const exitCodesOfServer = ['0', '64', '70', '78', '130', '143'] as const;

/** The words of the result of one era, for the allow list of the guard. */
export const courseWords = [
  'aera',
  '2026',
  '2025',
  'start',
  'tools',
  'aufrufe',
  'tool',
  'ergebnis',
  'email',
  'rechte',
  'module',
  'treffer',
  'mehr',
  'hinweis',
  'umschlag',
  'anfragen',
  'stdout',
  'ende',
  'ok',
  'gescheitert',
  'wie erwartet',
  'abweichend',
  'abgewiesen',
  'nicht abgewiesen',
  'maskiert',
  'keine',
  'bekannt',
  'unbekannt',
  'ja',
  'nein',
  'nur JSON-RPC',
  'nur JSON',
  'fremde Zeilen',
  'stderr',
  'ct_whoami',
  'ct_persons_search',
  'ct_groups_search',
  'ct_persons_search ohne Treffer',
  'ct_persons_search nur Leerzeichen',
  'ct_persons_get',
  'ct_persons_get_groups',
  'ct_groups_get',
  'ct_groups_get_members',
  'ct_events_list',
  'ct_events_get',
  'ct_events_get_agenda',
  'ct_services_list',
  'ct_services_get_assignments',
  'verborgen',
  'code',
  'anderer',
  ...exitCodesOfServer,
] as const;

/** The codes of failed checks and of findings, for the allow list. */
export const courseCodes = [
  'start',
  'tools_list',
  'whoami',
  'personensuche',
  'gruppensuche',
  'suche_ohne_treffer',
  'suche_leerzeichen',
  'person',
  'gruppen_der_person',
  'gruppe',
  'mitglieder',
  'anfragen',
  'stdout',
  'stderr',
  'ende',
  'protokoll',
  'token',
  'sicherheitsstufe',
  'keine_personen_gefunden',
  'keine_gruppen_gefunden',
  'events',
  'event',
  'ablauf',
  'dienste',
  'einteilungen',
  'kein_event_gefunden',
  'kein_ablauf',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sameKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  JSON.stringify(Object.keys(value).sort()) ===
  JSON.stringify([...keys].sort());

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const isName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 255;

const isIdOrNull = (value: unknown): boolean => value === null || isId(value);

const isCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

// The status of a membership, a day without time, a date with time and
// the type of an item of an agenda, as the tools give them (ADR 0064).
const memberStatus = /^[a-z_]{1,32}$/;
const day = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/;
const dateTime =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;
const itemType = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

// The data envelope of the pipeline: a boundary of 16 random hex digits,
// the text without the closing marker, the same boundary again (ADR 0024).
const envelope =
  /^<<data-([0-9a-f]{16})>>((?:(?!<<\/data-\1>>)[\s\S])*)<<\/data-\1>>$/;

const clientMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'ecclium-smoke', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** One line of stderr or of the audit file that is a JSON object. */
export type JsonLine = Record<string, unknown>;

/**
 * Parses the lines that are JSON objects. Start notes and warnings of
 * Node.js on stderr are text and are skipped, as the docs advise.
 *
 * @param text - Lines of text.
 * @returns The JSON objects in their order.
 */
export function jsonLines(text: string): JsonLine[] {
  const lines: JsonLine[] = [];
  for (const line of text.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) lines.push(value);
    } catch {
      // Not JSON: a start note or a warning of Node.js.
    }
  }
  return lines;
}

// Fields of log and audit lines whose values come from a fixed vocabulary
// of the server, such as the level `info` or the mode `interactive`.
const vocabularyFields: ReadonlySet<string> = new Set([
  'level',
  'event',
  'type',
  'tenantId',
  'mode',
  'outcome',
  'tool',
  'errorCode',
  'code',
  'kind',
  'id',
  'redaction',
]);

const vocabulary = (value: unknown, words: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const item of value) vocabulary(item, words);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      words.add(key.toLowerCase());
      if (vocabularyFields.has(key) && typeof entry === 'string') {
        words.add(entry.toLowerCase());
      }
      vocabulary(entry, words);
    }
  }
};

/**
 * Tells whether a JSON value holds one of the texts anywhere, in a key or
 * a value, as a whole word and ignoring case.
 *
 * A text that is itself part of a key or of a fixed word of the lines,
 * such as a group named «Default» or the term «tool», cannot be told from
 * that word and is left out, so it does not raise a false alarm.
 *
 * @param value - Any parsed JSON.
 * @param texts - Texts that must not appear; shorter than 3 characters are skipped.
 * @returns Whether one of them appears.
 */
export function holdsAny(value: unknown, texts: readonly string[]): boolean {
  const words = new Set<string>();
  vocabulary(value, words);
  const parts = texts
    .filter((text) => text.length >= 3)
    .map((text) => text.toLowerCase())
    .filter((part) => ![...words].some((word) => containsWord(word, part)));
  const visit = (item: unknown): boolean => {
    if (typeof item === 'string' || typeof item === 'number') {
      const text = String(item).toLowerCase();
      return parts.some((part) => containsWord(text, part));
    }
    if (Array.isArray(item)) return item.some(visit);
    if (isRecord(item)) {
      return Object.entries(item).some(
        ([key, entry]) => visit(key) || visit(entry),
      );
    }
    return false;
  };
  return visit(value);
}

interface ToolResult {
  readonly isError: boolean;
  /** The structured data, only if the text copy says the same. */
  readonly data: Record<string, unknown> | undefined;
}

// A result carries its data twice, as text and structured (ADR 0024). A
// client may read either, so both must say the same.
const toolResult = (answer: Answer): ToolResult | undefined => {
  if (answer.kind !== 'result' || !isRecord(answer.result)) return undefined;
  const structured = answer.result['structuredContent'];
  const content = answer.result['content'];
  const first: unknown = Array.isArray(content) ? content[0] : undefined;
  const text = isRecord(first) ? first['text'] : undefined;
  const same =
    isRecord(structured) &&
    Array.isArray(content) &&
    content.length === 1 &&
    text === JSON.stringify(structured);
  return {
    isError: answer.result['isError'] === true,
    data: same ? structured : undefined,
  };
};

/** What the course must keep out of every output of the server. */
export interface Secrets {
  /** The token of the service account: nowhere on stdout or stderr. */
  readonly token: string;
  /** The search term: in no line of log or audit. */
  readonly query: string | undefined;
}

/**
 * Runs the course in one server process and checks it.
 *
 * @param era - The era the process speaks.
 * @param session - The started process.
 * @param search - The plan for the search tools, only with the switch.
 * @param guard - Takes every value of the answers onto its block list.
 * @param secrets - Token and search term.
 * @returns What the checks found.
 */
export async function runEra(
  era: Era,
  session: Session,
  search: SearchPlan | undefined,
  guard: Guard,
  secrets: Secrets,
): Promise<EraOutcome> {
  const failures = new Set<string>();
  const findings = new Set<string>();
  const calls: Call[] = [];
  const seen: string[] = [];
  const report: Record<string, Json> = { aera: era };
  const params = (body: Record<string, unknown>): Record<string, unknown> =>
    era === '2026' ? { ...body, _meta: clientMeta } : body;

  const seeValue = (value: unknown): void => {
    guard.blockAll(value);
    if (typeof value === 'string' && value !== '') seen.push(value);
  };

  const opened =
    era === '2026'
      ? await session.request('server/discover', params({}))
      : await session.request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'ecclium-smoke', version: '1' },
        });
  const started = opened.kind === 'result' && isRecord(opened.result);
  report['start'] = started ? 'ok' : 'gescheitert';
  if (!started) failures.add('start');
  if (started && era === '2025') session.notify('notifications/initialized');

  let whoamiCalls = 0;
  // Every call but ct_whoami and the refused blank term asks ChurchTools
  // exactly once.
  let readCalls = 0;
  if (started) {
    // tools/list: exactly the expected tools, all of them only reading.
    const expected =
      search === undefined
        ? ['ct_whoami']
        : [
            'ct_events_get',
            'ct_events_get_agenda',
            'ct_events_list',
            'ct_groups_get',
            'ct_groups_get_members',
            'ct_groups_search',
            'ct_persons_get',
            'ct_persons_get_groups',
            'ct_persons_search',
            'ct_services_get_assignments',
            'ct_services_list',
            'ct_whoami',
          ];
    const listed = await session.request('tools/list', params({}));
    const tools =
      listed.kind === 'result' && isRecord(listed.result)
        ? listed.result['tools']
        : undefined;
    const fits =
      Array.isArray(tools) &&
      JSON.stringify(
        tools.map((tool: unknown) => (isRecord(tool) ? tool['name'] : null)),
      ) === JSON.stringify(expected) &&
      tools.every((tool: unknown) => {
        const hints = isRecord(tool) ? tool['annotations'] : undefined;
        return (
          isRecord(hints) &&
          hints['readOnlyHint'] === true &&
          hints['destructiveHint'] === false
        );
      });
    report['tools'] = fits ? 'wie erwartet' : 'abweichend';
    if (!fits) failures.add('tools_list');

    const callTool = async (
      name: string,
      args: Record<string, unknown>,
      expect: Call['expect'],
    ): Promise<ToolResult | undefined> => {
      calls.push({ tool: name, expect });
      return toolResult(
        await session.request('tools/call', params({ name, arguments: args })),
      );
    };
    const results: Json[] = [];

    // ct_whoami: the account, its masked address and its set rights.
    whoamiCalls += 1;
    const whoami = await callTool('ct_whoami', {}, 'ok');
    const me = whoami?.isError === false ? whoami.data : undefined;
    const rights = me?.['rights'];
    const modules = isRecord(rights) ? rights['modules'] : undefined;
    const email = me?.['email'];
    const meFits =
      me !== undefined &&
      sameKeys(me, ['email', 'firstName', 'id', 'lastName', 'rights']) &&
      isId(me['id']) &&
      isName(me['firstName']) &&
      isName(me['lastName']) &&
      // The masked forms of the pipeline: the first character or `*`,
      // three stars and the domain, or `[masked]` (ADR 0024).
      (email === null ||
        (typeof email === 'string' &&
          /^(?:[A-Za-z0-9*]\*\*\*@[^@\s]+|\[masked\])$/.test(email))) &&
      isRecord(rights) &&
      ((rights['status'] === 'known' && Array.isArray(modules)) ||
        (rights['status'] === 'unknown' && modules === null));
    if (me !== undefined) {
      seeValue(me['firstName']);
      seeValue(me['lastName']);
      seeValue(email);
      guard.blockAll(me);
    }
    if (!meFits) failures.add('whoami');
    const levels =
      Array.isArray(modules) &&
      modules.some(
        (module: unknown) =>
          isRecord(module) &&
          Array.isArray(module['rights']) &&
          module['rights'].some(
            (right: unknown) =>
              isRecord(right) && right['right'] === 'security level person',
          ),
      );
    // An account with a security level of persons still passes: the tools
    // pass on only their fields. The finding says that it gets more than
    // it needs. A level of groups is no finding: ct_groups_get needs the
    // lowest, and the rights name the levels only by ID, so the course
    // cannot tell the lowest from a higher one (ADR 0060, ADR 0064).
    if (levels) findings.add('sicherheitsstufe');
    results.push({
      tool: 'ct_whoami',
      ergebnis: meFits ? 'ok' : 'gescheitert',
      email: !meFits ? 'unbekannt' : email === null ? 'keine' : 'maskiert',
      rechte:
        isRecord(rights) && rights['status'] === 'known'
          ? 'bekannt'
          : 'unbekannt',
      module: countClass(Array.isArray(modules) ? modules.length : 0),
    });

    if (search !== undefined) {
      // ct_persons_search with the term: only ID and names, at most 50.
      readCalls += 1;
      const persons = await callTool(
        'ct_persons_search',
        { query: search.query },
        'ok',
      );
      const personsData = persons?.isError === false ? persons.data : undefined;
      const personList = personsData?.['persons'];
      const personsFit =
        personsData !== undefined &&
        sameKeys(personsData, ['more', 'notice', 'persons']) &&
        Array.isArray(personList) &&
        personList.length <= 50 &&
        personList.every(
          (person: unknown) =>
            isRecord(person) &&
            sameKeys(person, ['firstName', 'id', 'lastName']) &&
            isId(person['id']) &&
            isName(person['firstName']) &&
            isName(person['lastName']),
        ) &&
        typeof personsData['more'] === 'boolean' &&
        (personsData['notice'] === null ||
          typeof personsData['notice'] === 'string') &&
        (personList.length > 0 || typeof personsData['notice'] === 'string');
      if (Array.isArray(personList)) {
        for (const person of personList) {
          if (isRecord(person)) {
            seeValue(person['firstName']);
            seeValue(person['lastName']);
          }
        }
      }
      guard.blockAll(persons?.data);
      if (!personsFit) failures.add('personensuche');
      const personCount = Array.isArray(personList) ? personList.length : 0;
      const firstPerson: unknown =
        personsFit && personCount > 0 && Array.isArray(personList)
          ? personList[0]
          : undefined;
      const personId = isRecord(firstPerson) ? firstPerson['id'] : undefined;
      if (personsFit && personCount === 0) {
        findings.add('keine_personen_gefunden');
      }
      results.push({
        tool: 'ct_persons_search',
        ergebnis: personsFit ? 'ok' : 'gescheitert',
        treffer: countClass(personCount),
        mehr: personsData?.['more'] === true ? 'ja' : 'nein',
      });

      // ct_groups_search with the term: ID and name, the name enveloped.
      readCalls += 1;
      const groups = await callTool(
        'ct_groups_search',
        { query: search.query },
        'ok',
      );
      const groupsData = groups?.isError === false ? groups.data : undefined;
      const groupList = groupsData?.['groups'];
      const groupsFit =
        groupsData !== undefined &&
        sameKeys(groupsData, ['groups', 'more', 'notice']) &&
        Array.isArray(groupList) &&
        groupList.length <= 50 &&
        groupList.every(
          (group: unknown) =>
            isRecord(group) &&
            sameKeys(group, ['id', 'name']) &&
            isId(group['id']) &&
            typeof group['name'] === 'string' &&
            envelope.test(group['name']),
        ) &&
        typeof groupsData['more'] === 'boolean' &&
        (groupsData['notice'] === null ||
          typeof groupsData['notice'] === 'string') &&
        (groupList.length > 0 || typeof groupsData['notice'] === 'string');
      if (Array.isArray(groupList)) {
        for (const group of groupList) {
          const name = isRecord(group) ? group['name'] : undefined;
          if (typeof name === 'string') {
            seeValue(envelope.exec(name)?.[2] ?? name);
          }
        }
      }
      guard.blockAll(groups?.data);
      if (!groupsFit) failures.add('gruppensuche');
      const groupCount = Array.isArray(groupList) ? groupList.length : 0;
      const firstGroup: unknown =
        groupsFit && groupCount > 0 && Array.isArray(groupList)
          ? groupList[0]
          : undefined;
      const groupId = isRecord(firstGroup) ? firstGroup['id'] : undefined;
      if (groupsFit && groupCount === 0) {
        findings.add('keine_gruppen_gefunden');
      }
      results.push({
        tool: 'ct_groups_search',
        ergebnis: groupsFit ? 'ok' : 'gescheitert',
        treffer: countClass(groupCount),
        mehr: groupsData?.['more'] === true ? 'ja' : 'nein',
        umschlag: groupsFit && groupCount > 0 ? 'ja' : 'keine',
      });

      // A term that matches nothing: an empty list with the note on the
      // right, since no match and a missing right look the same (ADR 0060).
      readCalls += 1;
      const miss = await callTool(
        'ct_persons_search',
        { query: search.missTerm },
        'ok',
      );
      const missData = miss?.isError === false ? miss.data : undefined;
      const missList = missData?.['persons'];
      const missFits =
        Array.isArray(missList) &&
        missList.length === 0 &&
        missData?.['more'] === false &&
        typeof missData['notice'] === 'string';
      guard.blockAll(miss?.data);
      if (!missFits) failures.add('suche_ohne_treffer');
      results.push({
        tool: 'ct_persons_search ohne Treffer',
        ergebnis: missFits ? 'ok' : 'gescheitert',
        hinweis: missFits ? 'ja' : 'nein',
      });

      // Only spaces: refused before any request to ChurchTools. The count
      // of requests below shows that none went out.
      const blank = await callTool(
        'ct_persons_search',
        { query: '   ' },
        'validation',
      );
      const refused = blank?.isError === true;
      if (!refused) failures.add('suche_leerzeichen');
      results.push({
        tool: 'ct_persons_search nur Leerzeichen',
        ergebnis: refused ? 'abgewiesen' : 'nicht abgewiesen',
      });

      // The text inside the envelope of an untrusted text, onto the lists.
      const seeEnveloped = (value: unknown): boolean => {
        if (typeof value !== 'string') return false;
        const inner = envelope.exec(value);
        seeValue(inner?.[2] ?? value);
        return inner !== null;
      };

      if (isId(personId)) {
        // ct_persons_get with the first person: ID, names, archived.
        readCalls += 1;
        const read = await callTool('ct_persons_get', { personId }, 'ok');
        const data = read?.isError === false ? read.data : undefined;
        const fits =
          data !== undefined &&
          sameKeys(data, ['firstName', 'id', 'isArchived', 'lastName']) &&
          data['id'] === personId &&
          isName(data['firstName']) &&
          isName(data['lastName']) &&
          typeof data['isArchived'] === 'boolean';
        if (data !== undefined) {
          seeValue(data['firstName']);
          seeValue(data['lastName']);
        }
        guard.blockAll(read?.data);
        if (!fits) failures.add('person');
        results.push({
          tool: 'ct_persons_get',
          ergebnis: fits ? 'ok' : 'gescheitert',
        });

        // ct_persons_get_groups: group, role and status, the name enveloped.
        readCalls += 1;
        const listed = await callTool(
          'ct_persons_get_groups',
          { personId },
          'ok',
        );
        const groupsOf = listed?.isError === false ? listed.data : undefined;
        const memberships = groupsOf?.['groups'];
        let enveloped = true;
        const groupsFit =
          groupsOf !== undefined &&
          sameKeys(groupsOf, ['groups', 'more', 'notice', 'personId']) &&
          groupsOf['personId'] === personId &&
          Array.isArray(memberships) &&
          memberships.length <= 50 &&
          memberships.every(
            (entry: unknown) =>
              isRecord(entry) &&
              sameKeys(entry, [
                'groupId',
                'groupMemberStatus',
                'groupName',
                'groupTypeRoleId',
              ]) &&
              isIdOrNull(entry['groupId']) &&
              isId(entry['groupTypeRoleId']) &&
              typeof entry['groupMemberStatus'] === 'string' &&
              memberStatus.test(entry['groupMemberStatus']),
          ) &&
          typeof groupsOf['more'] === 'boolean' &&
          (groupsOf['notice'] === null ||
            typeof groupsOf['notice'] === 'string') &&
          (memberships.length > 0 || typeof groupsOf['notice'] === 'string');
        if (Array.isArray(memberships)) {
          for (const entry of memberships) {
            const name = isRecord(entry) ? entry['groupName'] : undefined;
            if (!seeEnveloped(name)) enveloped = false;
          }
        }
        guard.blockAll(listed?.data);
        if (!groupsFit || !enveloped) failures.add('gruppen_der_person');
        const membershipCount = Array.isArray(memberships)
          ? memberships.length
          : 0;
        results.push({
          tool: 'ct_persons_get_groups',
          ergebnis: groupsFit && enveloped ? 'ok' : 'gescheitert',
          treffer: countClass(membershipCount),
          mehr: groupsOf?.['more'] === true ? 'ja' : 'nein',
        });
      }

      if (isId(groupId)) {
        // ct_groups_get with the first group: name and the six details,
        // the texts enveloped, or no details with the note on the level.
        readCalls += 1;
        const read = await callTool('ct_groups_get', { groupId }, 'ok');
        const data = read?.isError === false ? read.data : undefined;
        const detail = data?.['details'];
        const texts = [data?.['name']];
        const detailsFit =
          detail === null ||
          (isRecord(detail) &&
            sameKeys(detail, [
              'dateOfFoundation',
              'endDate',
              'maxMembers',
              'meetingTime',
              'note',
              'targetGroupId',
            ]) &&
            [detail['meetingTime'], detail['note']].every(
              (text) => text === null || typeof text === 'string',
            ) &&
            (detail['maxMembers'] === null || isCount(detail['maxMembers'])) &&
            isIdOrNull(detail['targetGroupId']) &&
            [detail['dateOfFoundation'], detail['endDate']].every(
              (date) =>
                date === null || (typeof date === 'string' && day.test(date)),
            ));
        if (isRecord(detail)) {
          for (const text of [detail['meetingTime'], detail['note']]) {
            if (text !== null) texts.push(text);
          }
        }
        const allEnveloped = texts.every((text) => seeEnveloped(text));
        const fits =
          data !== undefined &&
          sameKeys(data, ['details', 'id', 'name', 'notice']) &&
          data['id'] === groupId &&
          detailsFit &&
          allEnveloped &&
          (detail === null) === (typeof data['notice'] === 'string');
        guard.blockAll(read?.data);
        if (!fits) failures.add('gruppe');
        results.push({
          tool: 'ct_groups_get',
          ergebnis: fits ? 'ok' : 'gescheitert',
          hinweis: typeof data?.['notice'] === 'string' ? 'ja' : 'nein',
          umschlag: allEnveloped ? 'ja' : 'nein',
        });

        // ct_groups_get_members, page 1: ID, names, role and status.
        readCalls += 1;
        const listed = await callTool(
          'ct_groups_get_members',
          { groupId },
          'ok',
        );
        const page = listed?.isError === false ? listed.data : undefined;
        const members = page?.['members'];
        const membersFit =
          page !== undefined &&
          sameKeys(page, ['groupId', 'members', 'more', 'notice', 'page']) &&
          page['groupId'] === groupId &&
          page['page'] === 1 &&
          Array.isArray(members) &&
          members.length <= 50 &&
          members.every(
            (entry: unknown) =>
              isRecord(entry) &&
              sameKeys(entry, [
                'firstName',
                'groupMemberStatus',
                'groupTypeRoleId',
                'lastName',
                'personId',
              ]) &&
              isId(entry['personId']) &&
              isName(entry['firstName']) &&
              isName(entry['lastName']) &&
              isId(entry['groupTypeRoleId']) &&
              typeof entry['groupMemberStatus'] === 'string' &&
              memberStatus.test(entry['groupMemberStatus']),
          ) &&
          typeof page['more'] === 'boolean' &&
          (page['notice'] === null || typeof page['notice'] === 'string') &&
          (members.length > 0 || typeof page['notice'] === 'string');
        if (Array.isArray(members)) {
          for (const entry of members) {
            if (isRecord(entry)) {
              seeValue(entry['firstName']);
              seeValue(entry['lastName']);
            }
          }
        }
        guard.blockAll(listed?.data);
        if (!membersFit) failures.add('mitglieder');
        results.push({
          tool: 'ct_groups_get_members',
          ergebnis: membersFit ? 'ok' : 'gescheitert',
          treffer: countClass(Array.isArray(members) ? members.length : 0),
          mehr: page?.['more'] === true ? 'ja' : 'nein',
        });
      }

      // A text of ChurchTools that may be missing: null, or enveloped.
      const seeOptional = (value: unknown): boolean =>
        value === null || seeEnveloped(value);
      const noticeFits = (data: Record<string, unknown>): boolean =>
        typeof data['more'] === 'boolean' &&
        (data['notice'] === null || typeof data['notice'] === 'string');

      // ct_events_list over the spans until one holds an event: ID, name,
      // times, whether canceled and the calendar, the names enveloped.
      let eventId: unknown;
      let eventsFit = true;
      let eventCount = 0;
      for (const span of search.spans) {
        readCalls += 1;
        const listed = await callTool(
          'ct_events_list',
          { from: span.from, to: span.to },
          'ok',
        );
        const data = listed?.isError === false ? listed.data : undefined;
        const events = data?.['events'];
        let enveloped = true;
        if (Array.isArray(events)) {
          for (const entry of events) {
            if (!isRecord(entry)) continue;
            if (!seeEnveloped(entry['name'])) enveloped = false;
            if (!seeEnveloped(entry['calendarName'])) enveloped = false;
          }
        }
        const fits =
          data !== undefined &&
          sameKeys(data, ['events', 'from', 'more', 'notice', 'page', 'to']) &&
          data['from'] === span.from &&
          data['to'] === span.to &&
          data['page'] === 1 &&
          Array.isArray(events) &&
          events.length <= 25 &&
          events.every(
            (entry: unknown) =>
              isRecord(entry) &&
              sameKeys(entry, [
                'calendarId',
                'calendarName',
                'endDate',
                'id',
                'isCanceled',
                'name',
                'startDate',
              ]) &&
              isId(entry['id']) &&
              typeof entry['startDate'] === 'string' &&
              dateTime.test(entry['startDate']) &&
              typeof entry['endDate'] === 'string' &&
              dateTime.test(entry['endDate']) &&
              typeof entry['isCanceled'] === 'boolean' &&
              isIdOrNull(entry['calendarId']),
          ) &&
          enveloped &&
          noticeFits(data) &&
          (events.length > 0 || typeof data['notice'] === 'string');
        guard.blockAll(listed?.data);
        if (!fits) {
          eventsFit = false;
          break;
        }
        const first: unknown = Array.isArray(events) ? events[0] : undefined;
        if (isRecord(first)) {
          eventId = first['id'];
          eventCount = Array.isArray(events) ? events.length : 0;
          break;
        }
      }
      if (!eventsFit) failures.add('events');
      if (eventsFit && eventId === undefined) {
        findings.add('kein_event_gefunden');
      }
      results.push({
        tool: 'ct_events_list',
        ergebnis: eventsFit ? 'ok' : 'gescheitert',
        treffer: countClass(eventCount),
      });

      if (isId(eventId)) {
        // ct_events_get with the first event: the nine fields, the texts
        // enveloped or null.
        readCalls += 1;
        const read = await callTool('ct_events_get', { eventId }, 'ok');
        const data = read?.isError === false ? read.data : undefined;
        const textsFit =
          data !== undefined &&
          [data['name'], data['calendarName']].every((text) =>
            seeEnveloped(text),
          ) &&
          [data['note'], data['description']].every((text) =>
            seeOptional(text),
          );
        const eventFits =
          data !== undefined &&
          sameKeys(data, [
            'calendarId',
            'calendarName',
            'description',
            'endDate',
            'id',
            'isCanceled',
            'name',
            'note',
            'startDate',
          ]) &&
          data['id'] === eventId &&
          typeof data['startDate'] === 'string' &&
          dateTime.test(data['startDate']) &&
          typeof data['isCanceled'] === 'boolean' &&
          isIdOrNull(data['calendarId']) &&
          textsFit;
        guard.blockAll(read?.data);
        if (!eventFits) failures.add('event');
        results.push({
          tool: 'ct_events_get',
          ergebnis: eventFits ? 'ok' : 'gescheitert',
          umschlag: textsFit ? 'ja' : 'nein',
        });

        // ct_events_get_agenda: the first ten items, or not_found for an
        // event without agenda, which is a finding and no failure.
        readCalls += 1;
        const agenda = await callTool(
          'ct_events_get_agenda',
          { eventId },
          'ok',
        );
        if (agenda?.isError === true) {
          calls[calls.length - 1] = {
            tool: 'ct_events_get_agenda',
            expect: 'not_found',
          };
          findings.add('kein_ablauf');
          results.push({ tool: 'ct_events_get_agenda', ergebnis: 'keine' });
        } else {
          const plan = agenda?.data;
          const items = plan?.['items'];
          let itemsEnveloped = plan !== undefined && seeEnveloped(plan['name']);
          if (Array.isArray(items)) {
            for (const entry of items) {
              if (!isRecord(entry)) continue;
              if (!seeEnveloped(entry['title'])) itemsEnveloped = false;
              if (!seeOptional(entry['note'])) itemsEnveloped = false;
              const song = entry['song'];
              if (
                isRecord(song) &&
                !(
                  seeEnveloped(song['title']) &&
                  seeOptional(song['arrangement'])
                )
              ) {
                itemsEnveloped = false;
              }
            }
          }
          const agendaFits =
            plan !== undefined &&
            sameKeys(plan, [
              'eventId',
              'isFinal',
              'items',
              'more',
              'name',
              'notice',
              'page',
            ]) &&
            plan['eventId'] === eventId &&
            typeof plan['isFinal'] === 'boolean' &&
            Array.isArray(items) &&
            items.length <= 10 &&
            items.every(
              (entry: unknown) =>
                isRecord(entry) &&
                sameKeys(entry, [
                  'duration',
                  'isBeforeEvent',
                  'note',
                  'position',
                  'song',
                  'start',
                  'title',
                  'type',
                ]) &&
                typeof entry['position'] === 'number' &&
                typeof entry['type'] === 'string' &&
                itemType.test(entry['type']) &&
                (entry['start'] === null ||
                  (typeof entry['start'] === 'string' &&
                    dateTime.test(entry['start']))) &&
                (entry['duration'] === null || isCount(entry['duration'])) &&
                typeof entry['isBeforeEvent'] === 'boolean' &&
                (entry['song'] === null ||
                  (isRecord(entry['song']) &&
                    sameKeys(entry['song'], [
                      'arrangement',
                      'arrangementId',
                      'songId',
                      'title',
                    ]) &&
                    isId(entry['song']['songId']) &&
                    isIdOrNull(entry['song']['arrangementId']))),
            ) &&
            itemsEnveloped &&
            noticeFits(plan);
          guard.blockAll(agenda?.data);
          if (!agendaFits) failures.add('ablauf');
          results.push({
            tool: 'ct_events_get_agenda',
            ergebnis: agendaFits ? 'ok' : 'gescheitert',
            treffer: countClass(Array.isArray(items) ? items.length : 0),
            mehr: plan?.['more'] === true ? 'ja' : 'nein',
          });
        }

        // ct_services_get_assignments: service, states and the person, or
        // none where the service hides the names. It reads the event, the
        // services and their groups.
        readCalls += 3;
        const listed = await callTool(
          'ct_services_get_assignments',
          { eventId },
          'ok',
        );
        const page = listed?.isError === false ? listed.data : undefined;
        const assignments = page?.['assignments'];
        let namesEnveloped = true;
        let hidden = false;
        if (Array.isArray(assignments)) {
          for (const entry of assignments) {
            if (!isRecord(entry)) continue;
            if (!seeOptional(entry['serviceName'])) namesEnveloped = false;
            const person = entry['person'];
            if (isRecord(person)) {
              seeValue(person['firstName']);
              seeValue(person['lastName']);
            } else {
              hidden = true;
            }
          }
        }
        const assignmentsFit =
          page !== undefined &&
          sameKeys(page, [
            'assignments',
            'eventId',
            'more',
            'notice',
            'page',
          ]) &&
          page['eventId'] === eventId &&
          page['page'] === 1 &&
          Array.isArray(assignments) &&
          assignments.length <= 25 &&
          assignments.every(
            (entry: unknown) =>
              isRecord(entry) &&
              sameKeys(entry, [
                'agreed',
                'isAccepted',
                'person',
                'serviceId',
                'serviceName',
              ]) &&
              isId(entry['serviceId']) &&
              typeof entry['isAccepted'] === 'boolean' &&
              typeof entry['agreed'] === 'boolean' &&
              (entry['person'] === null ||
                (isRecord(entry['person']) &&
                  sameKeys(entry['person'], [
                    'firstName',
                    'lastName',
                    'personId',
                  ]) &&
                  isId(entry['person']['personId']) &&
                  isName(entry['person']['firstName']) &&
                  isName(entry['person']['lastName']))),
          ) &&
          namesEnveloped &&
          noticeFits(page) &&
          (assignments.length > 0 || typeof page['notice'] === 'string');
        guard.blockAll(listed?.data);
        if (!assignmentsFit) failures.add('einteilungen');
        results.push({
          tool: 'ct_services_get_assignments',
          ergebnis: assignmentsFit ? 'ok' : 'gescheitert',
          treffer: countClass(
            Array.isArray(assignments) ? assignments.length : 0,
          ),
          verborgen: hidden ? 'ja' : 'nein',
        });
      }

      // ct_services_list, page 1: every account reads the services, with
      // their group, the names enveloped. It reads services and groups.
      readCalls += 2;
      const servicesRead = await callTool('ct_services_list', {}, 'ok');
      const servicesData =
        servicesRead?.isError === false ? servicesRead.data : undefined;
      const services = servicesData?.['services'];
      let servicesEnveloped = true;
      if (Array.isArray(services)) {
        for (const entry of services) {
          if (!isRecord(entry)) continue;
          if (!seeEnveloped(entry['name'])) servicesEnveloped = false;
          if (!seeOptional(entry['serviceGroupName'])) {
            servicesEnveloped = false;
          }
        }
      }
      const servicesFit =
        servicesData !== undefined &&
        sameKeys(servicesData, ['more', 'notice', 'page', 'services']) &&
        servicesData['page'] === 1 &&
        Array.isArray(services) &&
        services.length <= 25 &&
        services.every(
          (entry: unknown) =>
            isRecord(entry) &&
            sameKeys(entry, [
              'hidesNames',
              'id',
              'name',
              'serviceGroupId',
              'serviceGroupName',
            ]) &&
            isId(entry['id']) &&
            isId(entry['serviceGroupId']) &&
            typeof entry['hidesNames'] === 'boolean',
        ) &&
        servicesEnveloped &&
        noticeFits(servicesData);
      guard.blockAll(servicesRead?.data);
      if (!servicesFit) failures.add('dienste');
      results.push({
        tool: 'ct_services_list',
        ergebnis: servicesFit ? 'ok' : 'gescheitert',
        treffer: countClass(Array.isArray(services) ? services.length : 0),
        mehr: servicesData?.['more'] === true ? 'ja' : 'nein',
      });
    }
    report['aufrufe'] = results;
  }

  const ended: Ended = await session.finish();
  const lines = jsonLines(session.stderr());
  const events = lines.filter((line) => typeof line['event'] === 'string');

  // ct_whoami asks ChurchTools twice, each search with a term, each read
  // by ID and each list of events once, the services twice and the
  // assignments three times.
  const requests = events.filter((line) => line['event'] === 'http_response');
  const requestsFit = requests.length === whoamiCalls * 2 + readCalls;
  report['anfragen'] = requestsFit ? 'wie erwartet' : 'abweichend';
  if (!requestsFit) failures.add('anfragen');

  const foreign = session.foreignLines();
  report['stdout'] = foreign === 0 ? 'nur JSON-RPC' : 'fremde Zeilen';
  if (foreign !== 0) failures.add('stdout');

  // Text on stderr may only come before the first JSON line: the start
  // notes, written before any call, so they cannot hold an answer. After
  // them the server writes only JSON (docs/betrieb/stdio.md), and a text
  // line there could carry a name the checks of JSON lines do not see.
  const raw = session.stderr().split('\n');
  const firstJson = raw.findIndex((line) => jsonLines(line).length === 1);
  const textAfter =
    firstJson !== -1 &&
    raw
      .slice(firstJson)
      .some((line) => line !== '' && jsonLines(line).length === 0);
  report['stderr'] = textAfter ? 'fremde Zeilen' : 'nur JSON';
  if (textAfter) failures.add('stderr');

  // The end of a connection: code 0, no audit line lost in the file, no
  // line lost on stderr, and stdio_closed as the last line (ADR 0054).
  const fileClosed = events.find(
    (line) => line['event'] === 'audit_file_closed',
  );
  const last = events.at(-1);
  const endFits =
    ended.code === 0 &&
    !ended.killed &&
    fileClosed?.['count'] === 0 &&
    last?.['event'] === 'stdio_closed' &&
    last['count'] === 0;
  report['ende'] = endFits ? 'ok' : 'gescheitert';
  const code = String(ended.code);
  report['code'] = (exitCodesOfServer as readonly string[]).includes(code)
    ? code
    : 'anderer';
  if (!endFits) failures.add('ende');

  // The answers on stdout carry names, and the search term can be part of
  // one. Log and audit carry neither, and the token appears nowhere.
  const banned = [secrets.token, ...seen];
  if (secrets.query !== undefined) banned.push(secrets.query);
  if (holdsAny(lines, banned)) failures.add('protokoll');
  if (
    session.stdout().includes(secrets.token) ||
    session.stderr().includes(secrets.token)
  ) {
    failures.add('token');
  }

  return {
    report,
    failures: [...failures],
    findings: [...findings],
    calls,
    seen,
  };
}
