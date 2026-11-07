/**
 * The course of the smoke test for writing: what it writes, in which
 * order, and what it expects of each step.
 *
 * Every write goes through the built server of Ecclium, its pipeline and
 * its write guard; the smoke test only calls tools and answers questions,
 * as a client and a person would (ADR 0029). Three processes run one after
 * the other on one folder of state, one folder of day keys and one key of
 * the check code, so that a write of one process can be taken back after
 * it ended (ADR 0031):
 *
 * 1. 2026 with elicitation: a page refused with «Nein» and created with
 *    «Ja», a section, a conflict between the two rounds of a change, undo
 *    with a change in between, an appointment created, skipped as a repeat
 *    and taken back, a second one changed and the change taken back, one
 *    request for a booking and its undo.
 * 2. 2025 with elicitation: a section, confirmed through the question the
 *    server sends to the client.
 * 3. 2025 without elicitation: the echo with a wrong summary, a used token
 *    and the right summary, an appointment created by echo and taken back,
 *    a change of an appointment that waits in the queue and is approved on
 *    the command line, then every undo that is left.
 *
 * A new appointment that was changed is never deleted by undo; the second
 * appointment stays and 11-calendar-write removes it. A page is never
 * deleted by Ecclium; its text becomes the fixed sentence of a withdrawal,
 * and 07-wiki-cleanup removes it. Both are kept in their state files the
 * moment the smoke test knows their IDs.
 *
 * Every value from ChurchTools, every question and every ID goes onto the
 * block list; the result holds only fixed words.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';

import type { Json } from '../spike/lib/guard.mts';
import { guidPattern } from '../spike/lib/http.mts';
import type {
  CalendarStateFile,
  WriteStateFile,
} from '../spike/lib/write-state.mts';
import {
  isRecord,
  toolResult,
  unwrap,
  type ToolResult,
} from '../smoke/answers.mts';
import {
  startServer,
  type Answer,
  type Deadlines,
  type Session,
} from '../smoke/session.mts';
import {
  runCommand,
  undoIdOfApproval,
  type CommandRun,
  type CommandStart,
} from './commands.mts';
import {
  answerPending,
  legacyAnswers,
  messageOf,
  openConnection,
  paramsFor,
  pendingOf,
  type ClientKind,
  type LegacyAnswers,
  type Pending,
  type Reply,
} from './protocol.mts';

/** One audit line of a tool call, as the course expects it. */
export interface Expected {
  readonly tool: string;
  readonly outcome: 'ok' | 'error' | 'denied';
  readonly errorCode?: string;
  readonly writeState?: string;
  readonly confirmation?: string;
}

/** What the course needs from its caller. */
export interface CourseContext {
  /** How to start `ecclium`, for stdio and the other commands. */
  readonly start: CommandStart;
  /** The whole environment of the server and of every command. */
  readonly env: Readonly<Record<string, string>>;
  /** Write area, probe calendar and probe resource. */
  readonly area: {
    readonly category: number;
    readonly calendar: number;
    readonly resource: number;
  };
  /** The day the run writes on, `YYYY-MM-DD`. */
  readonly day: string;
  /** The title of the page, with the tag of the write state file. */
  readonly pageTitle: string;
  /** The start of every title of an appointment or booking of the run. */
  readonly entryPrefix: string;
  /** Keeps the GUID of the page for 07-wiki-cleanup. */
  readonly pages: WriteStateFile;
  /** Keeps the IDs of appointments and bookings for 11-calendar-write. */
  readonly entries: CalendarStateFile;
  readonly deadlines: Deadlines;
  /** Waits between two writes. */
  readonly wait: (milliseconds: number) => Promise<void>;
  /** Puts a value onto the block list and the list of leaks. */
  readonly see: (value: unknown) => void;
  /**
   * Reads the bookings of the probe resource on the day of the run in
   * every status, past the server: whether ChurchTools lists a request
   * without `status_ids[]`, as the tools of the server ask, no probe has
   * shown.
   */
  readonly bookings: () => Promise<
    | readonly {
        readonly id: number;
        readonly title: string;
        readonly statusId: unknown;
      }[]
    | undefined
  >;
}

/** One run of `ecclium undo`: the write it took back and its exit code. */
export interface UndoRun {
  readonly id: string;
  readonly status: number | null;
}

/** What one process of the server left. */
export interface SessionRecord {
  readonly expected: readonly Expected[];
  readonly stdout: string;
  readonly stderr: string;
  /** Whether it ended by itself with 0 after stdin closed. */
  readonly endedCleanly: boolean;
}

/** What the course found. */
export interface CourseOutcome {
  /** Each step by its fixed name, in order, with whether it went as expected. */
  readonly steps: readonly { readonly name: string; readonly ok: boolean }[];
  readonly sessions: readonly SessionRecord[];
  readonly commands: readonly CommandRun[];
  /** Each run of undo that looked for its snapshot, with its exit code. */
  readonly undoes: readonly UndoRun[];
  /** Fixed words for what the run found and does not fail it. */
  readonly findings: readonly string[];
  /** The ID of each entry of the queue that was approved. */
  readonly approvals: readonly string[];
  /** Whether the page and the changed appointment stay for the clean-up. */
  readonly left: { readonly page: boolean; readonly appointment: boolean };
}

/** The fixed words of the findings, for the allow list of the guard. */
export const findingWords = ['buchungsliste_ohne_anfrage'] as const;

/** The fixed names of the steps, for the allow list of the guard. */
export const stepNames = [
  'start_2026_rueckfrage',
  'tools_schreibend',
  'seite_anlegen_nein',
  'seite_anlegen',
  'abschnitt_anhaengen',
  'konflikt',
  'ruecknahme_nach_aenderung',
  'termin_anlegen',
  'termin_doppelt',
  'termin_ruecknahme',
  'termin_aendern',
  'termin_aendern_ruecknahme',
  'buchung_anfragen',
  'buchung_ruecknahme',
  'start_2025_rueckfrage',
  'abschnitt_rueckfrage_2025',
  'start_2025_ohne_rueckfrage',
  'echo_abgewiesen',
  'echo',
  'termin_echo',
  'warteschlange',
  'warteschlange_ruecknahme',
  'termin_bleibt',
  'seite_ruecknahme',
  'ende_der_prozesse',
] as const;

/** The tools that read, which the course calls to see what a write did. */
export const readTools = [
  'ct_appointments_get',
  'ct_appointments_list',
  'ct_bookings_list',
  'ct_wiki_page_get',
  'ct_wiki_pages_list',
] as const;

/** The tools that write, which the catalog must offer and mark as such. */
export const writeTools = [
  'ct_appointments_create',
  'ct_appointments_update',
  'ct_bookings_create',
  'ct_wiki_page_append_section',
  'ct_wiki_page_create',
  'ct_wiki_page_update',
  'ct_write_confirm',
] as const;

// The texts the run writes: plain sentences the content policy allows,
// synthetic and without names, links or contact data (ADR 0030).
const pageText = 'Diese Seite legt der Smoke-Test für das Schreiben an.\n';
const changedText =
  'Diese Seite hat der Smoke-Test für das Schreiben geändert.\n';
const sectionText = (number: number): string =>
  `## Abschnitt ${String(number)}\n\nSynthetischer Abschnitt ${String(number)} des Smoke-Tests.\n`;
const entryText = 'Synthetischer Eintrag des Smoke-Tests.';

// The sentence a page gets when undo takes its creation back.
const withdrawalNote =
  /^Diese Seite hat Ecclium am \d{2}\.\d{2}\.\d{4} angelegt und am \d{2}\.\d{2}\.\d{4} zurückgenommen\.\n?$/u;

// One second between two writes: each reads before and after, and many
// quick requests ran into the limits of ChurchTools before.
const pause = 1_000;

const hashOf = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** One process of the server and what the course expects of it. */
interface Process {
  readonly session: Session;
  readonly client: ClientKind;
  readonly expected: Expected[];
  readonly legacy?: LegacyAnswers;
}

/**
 * Runs the course. It never throws for what the server answers; each
 * answer that does not fit marks its step.
 *
 * @param context - Start, environment, targets, state files and the block list.
 * @returns What the course found.
 */
export async function runWriteCourse(
  context: CourseContext,
): Promise<CourseOutcome> {
  const steps: { name: string; ok: boolean }[] = [];
  const sessions: SessionRecord[] = [];
  const commands: CommandRun[] = [];
  const undoes: UndoRun[] = [];
  const findings: string[] = [];
  const approvals: string[] = [];
  const left = { page: false, appointment: false };
  const { area, day, see } = context;
  const at = (hour: number): string =>
    `${day}T${String(hour).padStart(2, '0')}:00:00Z`;

  const step = async (
    name: (typeof stepNames)[number],
    work: () => Promise<boolean>,
  ): Promise<boolean> => {
    // A step that throws went wrong like one that found something else.
    const ok = await work().catch(() => false);
    steps.push({ name, ok });
    return ok;
  };

  const start = (client: ClientKind, legacy?: LegacyAnswers): Process => ({
    session: startServer(
      {
        executable: context.start.executable,
        args: [...context.start.preArgs, context.start.entry, 'stdio'],
      },
      context.env,
      context.deadlines,
      legacy?.handler,
    ),
    client,
    expected: [],
    ...(legacy === undefined ? {} : { legacy }),
  });

  const finish = async (process: Process): Promise<boolean> => {
    const ended = await process.session.finish();
    const cleanly = ended.code === 0 && !ended.killed;
    sessions.push({
      expected: process.expected,
      stdout: process.session.stdout(),
      stderr: process.session.stderr(),
      endedCleanly: cleanly,
    });
    return cleanly;
  };

  // Every value of a result goes onto the block list before anything else
  // reads it.
  const resultOf = (answer: Answer | undefined): ToolResult | undefined => {
    if (answer === undefined) return undefined;
    if (answer.kind === 'result') see(answer.result);
    return toolResult(answer);
  };

  const call = async (
    process: Process,
    tool: string,
    args: Record<string, unknown>,
    expected: Omit<Expected, 'tool'>,
  ): Promise<ToolResult | undefined> => {
    process.expected.push({ tool, ...expected });
    return resultOf(
      await process.session.request(
        'tools/call',
        paramsFor(process.client, { name: tool, arguments: args }),
      ),
    );
  };

  // The first round of a write in the 2026 era: a question, no write.
  const ask = async (
    process: Process,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Pending | undefined> => {
    process.expected.push({ tool, outcome: 'ok', writeState: 'planned' });
    const answer = await process.session.request(
      'tools/call',
      paramsFor(process.client, { name: tool, arguments: args }),
    );
    if (answer.kind === 'result') see(answer.result);
    const pending = pendingOf(answer, tool, args);
    see(messageOf(pending?.params));
    return pending;
  };

  const confirm = async (
    process: Process,
    pending: Pending | undefined,
    reply: Reply,
    expected: Omit<Expected, 'tool'>,
  ): Promise<ToolResult | undefined> => {
    if (pending === undefined) return undefined;
    process.expected.push({ tool: pending.name, ...expected });
    return resultOf(await answerPending(process.session, pending, reply));
  };

  const verified = (
    result: ToolResult | undefined,
  ): Record<string, unknown> | undefined =>
    result !== undefined &&
    !result.isError &&
    result.data?.['state'] === 'verified'
      ? result.data
      : undefined;

  const undoIdOf = (
    data: Record<string, unknown> | undefined,
  ): string | undefined => {
    const id = data?.['undoId'];
    return typeof id === 'string' && uuid.test(id) ? id : undefined;
  };

  const versionOf = (
    data: Record<string, unknown> | undefined,
  ): number | undefined => {
    const version = data?.['version'];
    return typeof version === 'number' && Number.isSafeInteger(version)
      ? version
      : undefined;
  };

  const command = (args: readonly string[]): CommandRun => {
    const run = runCommand(context.start, args, context.env);
    commands.push(run);
    see(run.stdout);
    return run;
  };

  const undo = (id: string | undefined, overwrite = false): number | null => {
    if (id === undefined) return null;
    const { status } = command([
      'undo',
      id,
      ...(overwrite ? ['--overwrite'] : []),
    ]);
    undoes.push({ id, status });
    return status;
  };

  // --- Reads through the server, to see what the writes did. ---

  const readPage = async (
    process: Process,
    guid: string,
  ): Promise<
    { readonly version: number; readonly text: string } | undefined
  > => {
    const result = await call(
      process,
      'ct_wiki_page_get',
      { categoryId: area.category, guid },
      { outcome: 'ok' },
    );
    const text = unwrap(result?.data?.['text']);
    const version = versionOf(result?.data);
    return result?.data?.['parts'] === 1 &&
      text !== undefined &&
      version !== undefined
      ? { version, text }
      : undefined;
  };

  const findPage = async (
    process: Process,
    title: string,
  ): Promise<readonly string[] | undefined> => {
    const result = await call(
      process,
      'ct_wiki_pages_list',
      { categoryId: area.category },
      { outcome: 'ok' },
    );
    const pages = result?.data?.['pages'];
    if (!Array.isArray(pages) || result?.data?.['more'] === true) {
      return undefined;
    }
    return pages
      .filter(
        (page: unknown) => isRecord(page) && unwrap(page['title']) === title,
      )
      .map((page: unknown) =>
        isRecord(page) && typeof page['guid'] === 'string' ? page['guid'] : '',
      );
  };

  // Appointments through the tool of the server; bookings past it in every
  // status, so that a request counts even if the list of the tool leaves
  // it out (see `bookings` above).
  const listEntries = async (
    process: Process,
    kind: 'termin' | 'buchung',
  ): Promise<readonly Record<string, unknown>[] | undefined> => {
    if (kind === 'buchung') {
      const bookings = await context.bookings();
      see(bookings);
      return bookings?.map((entry) => ({ ...entry }));
    }
    const result = await call(
      process,
      'ct_appointments_list',
      { calendarIds: [area.calendar], from: day, to: day },
      { outcome: 'ok' },
    );
    const entries = result?.data?.['appointments'];
    if (!Array.isArray(entries) || result?.data?.['more'] === true) {
      return undefined;
    }
    return entries.filter(isRecord);
  };

  // The titles of the bookings as the tool of the server lists them.
  const listedBookings = async (
    process: Process,
  ): Promise<readonly string[] | undefined> => {
    const result = await call(
      process,
      'ct_bookings_list',
      { resourceIds: [area.resource], from: day, to: day },
      { outcome: 'ok' },
    );
    const entries = result?.data?.['bookings'];
    return Array.isArray(entries)
      ? entries.filter(isRecord).map((entry) => unwrap(entry['title']) ?? '')
      : undefined;
  };

  const entryIds = async (
    process: Process,
    kind: 'termin' | 'buchung',
    title: string,
  ): Promise<readonly number[] | undefined> => {
    const entries = await listEntries(process, kind);
    return entries
      ?.filter(
        (entry) =>
          (kind === 'buchung' ? entry['title'] : unwrap(entry['title'])) ===
          title,
      )
      .map((entry) => (isId(entry['id']) ? entry['id'] : 0));
  };

  // The one new appointment or booking with this title, kept in the state
  // file at once.
  const created = async (
    process: Process,
    kind: 'termin' | 'buchung',
    title: string,
  ): Promise<number | undefined> => {
    const ids = await entryIds(process, kind, title);
    const [id] = ids ?? [];
    if (ids?.length !== 1 || !isId(id)) return undefined;
    context.entries.created(kind, id);
    return id;
  };

  const gone = async (
    process: Process,
    kind: 'termin' | 'buchung',
    id: number,
  ): Promise<boolean> => {
    const entries = await listEntries(process, kind);
    const absent =
      entries !== undefined && !entries.some((entry) => entry['id'] === id);
    if (absent) context.entries.deleted(kind, id);
    return absent;
  };

  const readAppointment = async (
    process: Process,
    id: number,
  ): Promise<Record<string, unknown> | undefined> => {
    const result = await call(
      process,
      'ct_appointments_get',
      { calendarId: area.calendar, appointmentId: id },
      { outcome: 'ok' },
    );
    return result?.isError === false ? result.data : undefined;
  };

  // --- The values the steps share. ---

  let guid: string | undefined;
  let createdHash: string | undefined;
  let version: number | undefined;
  const undoIds: Record<
    | 'page'
    | 'section1'
    | 'section2'
    | 'section3'
    | 'section4'
    | 'appointment1'
    | 'appointment2'
    | 'change'
    | 'booking',
    string | undefined
  > = {
    page: undefined,
    section1: undefined,
    section2: undefined,
    section3: undefined,
    section4: undefined,
    appointment1: undefined,
    appointment2: undefined,
    change: undefined,
    booking: undefined,
  };
  let firstId: number | undefined;
  let bookingId: number | undefined;
  let changedId: number | undefined;
  const titles = {
    first: `${context.entryPrefix}termin-1`,
    second: `${context.entryPrefix}termin-2`,
    secondChanged: `${context.entryPrefix}termin-2-geaendert`,
    secondQueued: `${context.entryPrefix}termin-2-freigegeben`,
    third: `${context.entryPrefix}termin-3`,
    booking: `${context.entryPrefix}buchung`,
  };

  const appendSection = (number: number, base: number | undefined) =>
    base === undefined || guid === undefined
      ? undefined
      : {
          categoryId: area.category,
          guid,
          section: sectionText(number),
          baseVersion: base,
        };

  // ===== 1. The 2026 era with elicitation. =====
  const first = start({ era: '2026', elicitation: true });
  try {
    const opened = await step('start_2026_rueckfrage', () =>
      openConnection(first.session, first.client),
    );
    if (opened) {
      await step('tools_schreibend', async () => {
        const listed = await first.session.request(
          'tools/list',
          paramsFor(first.client, {}),
        );
        const tools =
          listed.kind === 'result' && isRecord(listed.result)
            ? listed.result['tools']
            : undefined;
        if (!Array.isArray(tools)) return false;
        const names = new Set<string>();
        const marked = tools.every((tool: unknown) => {
          if (!isRecord(tool) || typeof tool['name'] !== 'string') return false;
          names.add(tool['name']);
          const hints = tool['annotations'];
          const writes = (writeTools as readonly string[]).includes(
            tool['name'],
          );
          return isRecord(hints) && hints['readOnlyHint'] === !writes;
        });
        return marked && writeTools.every((name) => names.has(name));
      });

      await step('seite_anlegen_nein', async () => {
        const args = {
          categoryId: area.category,
          title: context.pageTitle,
          text: pageText,
        };
        const result = await confirm(
          first,
          await ask(first, 'ct_wiki_page_create', args),
          'nein',
          {
            outcome: 'denied',
            errorCode: 'confirmation_required',
            writeState: 'denied',
          },
        );
        const found = await findPage(first, context.pageTitle);
        return result?.isError === true && found?.length === 0;
      });
      await context.wait(pause);

      await step('seite_anlegen', async () => {
        const args = {
          categoryId: area.category,
          title: context.pageTitle,
          text: pageText,
        };
        const data = verified(
          await confirm(
            first,
            await ask(first, 'ct_wiki_page_create', args),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.page = undoIdOf(data);
        const found = await findPage(first, context.pageTitle);
        const [page] = found ?? [];
        // ChurchTools writes the GUID of a page in upper case, as its
        // OpenAPI document allows; the IDs of Ecclium are lower case.
        if (
          found?.length !== 1 ||
          page === undefined ||
          !guidPattern.test(page)
        ) {
          return false;
        }
        guid = page;
        context.pages.addPage(page, 'smoke');
        left.page = true;
        const read = await readPage(first, page);
        createdHash = read === undefined ? undefined : hashOf(read.text);
        version = read?.version;
        return (
          data !== undefined &&
          undoIds.page !== undefined &&
          read?.text.startsWith(pageText) === true
        );
      });
      await context.wait(pause);

      await step('abschnitt_anhaengen', async () => {
        const args = appendSection(1, version);
        if (args === undefined) return false;
        const data = verified(
          await confirm(
            first,
            await ask(first, 'ct_wiki_page_append_section', args),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.section1 = undoIdOf(data);
        const before = version;
        version = versionOf(data);
        return (
          before !== undefined &&
          version === before + 1 &&
          undoIds.section1 !== undefined
        );
      });
      await context.wait(pause);

      await step('konflikt', async () => {
        if (guid === undefined || version === undefined) return false;
        const read = await readPage(first, guid);
        if (read?.version !== version || !read.text.includes(pageText)) {
          return false;
        }
        // The first round of a change waits, a section goes in between,
        // and the second round must then find the page changed (T9).
        const change = await ask(first, 'ct_wiki_page_update', {
          categoryId: area.category,
          guid,
          text: read.text.replace(pageText, changedText),
          baseVersion: version,
        });
        const args = appendSection(2, version);
        if (change === undefined || args === undefined) return false;
        const between = verified(
          await confirm(
            first,
            await ask(first, 'ct_wiki_page_append_section', args),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.section2 = undoIdOf(between);
        const afterBetween = versionOf(between);
        await context.wait(pause);
        // The guard finds the change in its read right before the write
        // and sends nothing: refused with the code of a conflict.
        const result = await confirm(first, change, 'ja', {
          outcome: 'denied',
          errorCode: 'conflict',
          writeState: 'denied',
        });
        const after = await readPage(first, guid);
        version = after?.version;
        return (
          result?.isError === true &&
          afterBetween === read.version + 1 &&
          after?.version === afterBetween &&
          after.text.includes(pageText) &&
          !after.text.includes(changedText)
        );
      });
      await context.wait(pause);

      await step('ruecknahme_nach_aenderung', async () => {
        if (guid === undefined || version === undefined) return false;
        const current = version;
        // The first section has a later write after it: without
        // --overwrite undo writes nothing and ends with 65.
        const refused = undo(undoIds.section1);
        const unchanged = await readPage(first, guid);
        const later = undo(undoIds.section2);
        await context.wait(pause);
        // Its undo moved the version on, so the first is still refused,
        // and only --overwrite, the decision of the operator, writes.
        const stillRefused = undo(undoIds.section1);
        const overwritten = undo(undoIds.section1, true);
        const back = await readPage(first, guid);
        version = back?.version;
        return (
          refused === 65 &&
          unchanged?.version === current &&
          later === 0 &&
          stillRefused === 65 &&
          overwritten === 0 &&
          back?.version === current + 2 &&
          hashOf(back.text) === createdHash
        );
      });
      await context.wait(pause);

      await step('termin_anlegen', async () => {
        const args = {
          calendarId: area.calendar,
          title: titles.first,
          startDate: at(9),
          endDate: at(10),
          description: entryText,
        };
        const data = verified(
          await confirm(
            first,
            await ask(first, 'ct_appointments_create', args),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.appointment1 = undoIdOf(data);
        const id = await created(first, 'termin', titles.first);
        firstId = id;
        return data !== undefined && id !== undefined;
      });
      await context.wait(pause);

      await step('termin_doppelt', async () => {
        // The same title, start and end again: the core skips it before
        // it asks anything.
        const result = await call(
          first,
          'ct_appointments_create',
          {
            calendarId: area.calendar,
            title: titles.first,
            startDate: at(9),
            endDate: at(10),
            description: entryText,
          },
          { outcome: 'ok', writeState: 'skipped' },
        );
        const ids = await entryIds(first, 'termin', titles.first);
        return (
          result?.isError === false &&
          result.data?.['state'] === 'skipped' &&
          ids?.length === 1
        );
      });

      await step('termin_ruecknahme', async () => {
        const status = undo(undoIds.appointment1);
        return (
          status === 0 &&
          firstId !== undefined &&
          (await gone(first, 'termin', firstId))
        );
      });
      await context.wait(pause);

      await step('termin_aendern', async () => {
        const data = verified(
          await confirm(
            first,
            await ask(first, 'ct_appointments_create', {
              calendarId: area.calendar,
              title: titles.second,
              startDate: at(9),
              endDate: at(10),
              description: entryText,
            }),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.appointment2 = undoIdOf(data);
        changedId = await created(first, 'termin', titles.second);
        if (changedId === undefined || data === undefined) return false;
        left.appointment = true;
        const before = await readAppointment(first, changedId);
        if (before?.['version'] !== 0) return false;
        await context.wait(pause);
        // The account created it, so start and end may move (ADR 0029).
        // The core reads it with include[] before it plans.
        const change = verified(
          await confirm(
            first,
            await ask(first, 'ct_appointments_update', {
              calendarId: area.calendar,
              appointmentId: changedId,
              baseVersion: 0,
              title: titles.secondChanged,
              startDate: at(10),
              endDate: at(11),
            }),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.change = undoIdOf(change);
        const after = await readAppointment(first, changedId);
        return (
          change !== undefined &&
          unwrap(after?.['title']) === titles.secondChanged &&
          after?.['version'] === 1
        );
      });
      await context.wait(pause);

      await step('termin_aendern_ruecknahme', async () => {
        if (changedId === undefined) return false;
        const status = undo(undoIds.change);
        const after = await readAppointment(first, changedId);
        return (
          status === 0 &&
          unwrap(after?.['title']) === titles.second &&
          after?.['version'] === 2
        );
      });
      await context.wait(pause);

      await step('buchung_anfragen', async () => {
        const data = verified(
          await confirm(
            first,
            await ask(first, 'ct_bookings_create', {
              resourceId: area.resource,
              title: titles.booking,
              startDate: at(9),
              endDate: at(10),
              description: entryText,
            }),
            'ja',
            {
              outcome: 'ok',
              writeState: 'verified',
              confirmation: 'elicitation',
            },
          ),
        );
        undoIds.booking = undoIdOf(data);
        bookingId = await created(first, 'buchung', titles.booking);
        const entries = await listEntries(first, 'buchung');
        const requested = entries?.find((entry) => entry['id'] === bookingId);
        // Whether the tool of the server lists the request too: the repeat
        // check and the undo of a request read the same list.
        const listed = await listedBookings(first);
        if (listed?.includes(titles.booking) !== true) {
          findings.push('buchungsliste_ohne_anfrage');
        }
        // A request, never approved by the account itself (F45).
        return data !== undefined && requested?.['statusId'] === 1;
      });
      await context.wait(pause);

      await step('buchung_ruecknahme', async () => {
        const status = undo(undoIds.booking);
        return (
          status === 0 &&
          bookingId !== undefined &&
          (await gone(first, 'buchung', bookingId))
        );
      });
    }
  } finally {
    await finish(first);
  }
  await context.wait(pause);

  // ===== 2. The 2025 era with elicitation: the shim asks the client. =====
  const answers = legacyAnswers((text) => {
    see(text);
  });
  const second = start({ era: '2025', elicitation: true }, answers);
  try {
    const opened = await step('start_2025_rueckfrage', () =>
      openConnection(second.session, second.client),
    );
    if (opened) {
      await step('abschnitt_rueckfrage_2025', async () => {
        if (guid === undefined) return false;
        const read = await readPage(second, guid);
        const args = appendSection(3, read?.version);
        if (args === undefined) return false;
        answers.prepare('ja');
        // The shim of the SDK runs the call twice, the question and the
        // write, and each has its line (ADR 0053).
        second.expected.push({
          tool: 'ct_wiki_page_append_section',
          outcome: 'ok',
          writeState: 'planned',
        });
        const data = verified(
          await call(second, 'ct_wiki_page_append_section', args, {
            outcome: 'ok',
            writeState: 'verified',
            confirmation: 'elicitation',
          }),
        );
        undoIds.section3 = undoIdOf(data);
        const asked = answers.asked();
        return (
          data !== undefined &&
          asked.length === 1 &&
          asked[0]?.fits === true &&
          undoIds.section3 !== undefined
        );
      });
    }
  } finally {
    await finish(second);
  }
  await context.wait(pause);

  // ===== 3. The 2025 era without elicitation: echo and queue. =====
  const third = start({ era: '2025', elicitation: false });
  try {
    const opened = await step('start_2025_ohne_rueckfrage', () =>
      openConnection(third.session, third.client),
    );
    if (opened) {
      const planned = async (
        tool: string,
        args: Record<string, unknown>,
      ): Promise<
        { readonly token: string; readonly summary: string } | undefined
      > => {
        const result = await call(third, tool, args, {
          outcome: 'ok',
          writeState: 'planned',
        });
        const confirmBlock = result?.data?.['confirm'];
        return result?.data?.['state'] === 'planned' &&
          isRecord(confirmBlock) &&
          typeof confirmBlock['token'] === 'string' &&
          typeof confirmBlock['summary'] === 'string'
          ? { token: confirmBlock['token'], summary: confirmBlock['summary'] }
          : undefined;
      };
      const echo = (
        token: string,
        summary: string,
        expected: Omit<Expected, 'tool'>,
      ) => call(third, 'ct_write_confirm', { token, summary }, expected);
      const refusedEcho = {
        outcome: 'denied',
        errorCode: 'confirmation_required',
        writeState: 'denied',
      } as const;

      await step('echo_abgewiesen', async () => {
        if (guid === undefined) return false;
        const read = await readPage(third, guid);
        const args = appendSection(4, read?.version);
        if (args === undefined) return false;
        const plan = await planned('ct_wiki_page_append_section', args);
        if (plan === undefined) return false;
        // A wrong summary uses the token up, so the right one comes too
        // late (ADR 0029).
        const wrong = await echo(
          plan.token,
          'Eine andere Zusammenfassung.',
          refusedEcho,
        );
        const late = await echo(plan.token, plan.summary, refusedEcho);
        const after = await readPage(third, guid);
        return (
          wrong?.isError === true &&
          late?.isError === true &&
          after?.version === read?.version
        );
      });
      await context.wait(pause);

      await step('echo', async () => {
        if (guid === undefined) return false;
        const read = await readPage(third, guid);
        const args = appendSection(4, read?.version);
        if (args === undefined) return false;
        const plan = await planned('ct_wiki_page_append_section', args);
        if (plan === undefined) return false;
        const data = verified(
          await echo(plan.token, plan.summary, {
            outcome: 'ok',
            writeState: 'verified',
            confirmation: 'echo',
          }),
        );
        undoIds.section4 = undoIdOf(data);
        return data !== undefined && undoIds.section4 !== undefined;
      });
      await context.wait(pause);

      await step('termin_echo', async () => {
        const plan = await planned('ct_appointments_create', {
          calendarId: area.calendar,
          title: titles.third,
          startDate: at(9),
          endDate: at(10),
          description: entryText,
        });
        if (plan === undefined) return false;
        const data = verified(
          await echo(plan.token, plan.summary, {
            outcome: 'ok',
            writeState: 'verified',
            confirmation: 'echo',
          }),
        );
        const id = await created(third, 'termin', titles.third);
        await context.wait(pause);
        const status = undo(undoIdOf(data));
        return (
          data !== undefined &&
          id !== undefined &&
          status === 0 &&
          (await gone(third, 'termin', id))
        );
      });
      await context.wait(pause);

      let approvedUndo: string | undefined;
      await step('warteschlange', async () => {
        if (changedId === undefined) return false;
        const before = await readAppointment(third, changedId);
        const base = before?.['version'];
        if (typeof base !== 'number') return false;
        // A change of an appointment may mail its creator, so the echo
        // never confirms it; without a question it waits for the operator.
        const result = await call(
          third,
          'ct_appointments_update',
          {
            calendarId: area.calendar,
            appointmentId: changedId,
            baseVersion: base,
            title: titles.secondQueued,
            startDate: at(10),
            endDate: at(11),
          },
          { outcome: 'ok', writeState: 'queued' },
        );
        const queueId = result?.data?.['queueId'];
        if (
          result?.data?.['state'] !== 'queued' ||
          typeof queueId !== 'string' ||
          !uuid.test(queueId)
        ) {
          return false;
        }
        const listed = command(['queue', 'list']);
        approvals.push(queueId);
        const approved = command(['queue', 'approve', queueId]);
        approvedUndo = undoIdOfApproval(approved.stdout);
        const after = await readAppointment(third, changedId);
        return (
          listed.status === 0 &&
          approved.status === 0 &&
          approvedUndo !== undefined &&
          unwrap(after?.['title']) === titles.secondQueued &&
          after?.['version'] === base + 1
        );
      });
      await context.wait(pause);

      await step('warteschlange_ruecknahme', async () => {
        if (changedId === undefined) return false;
        const status = undo(approvedUndo);
        const after = await readAppointment(third, changedId);
        return status === 0 && unwrap(after?.['title']) === titles.second;
      });
      await context.wait(pause);

      await step('termin_bleibt', async () => {
        if (changedId === undefined) return false;
        // Changed since its creation: undo never deletes it, not even with
        // --overwrite (ADR 0031). 11-calendar-write removes it.
        const status = undo(undoIds.appointment2, true);
        const ids = await entryIds(third, 'termin', titles.second);
        return status === 65 && ids?.length === 1;
      });
      await context.wait(pause);

      await step('seite_ruecknahme', async () => {
        if (guid === undefined) return false;
        const last = undo(undoIds.section4);
        await context.wait(pause);
        const shim = undo(undoIds.section3, true);
        await context.wait(pause);
        const page = undo(undoIds.page, true);
        const read = await readPage(third, guid);
        return (
          last === 0 &&
          shim === 0 &&
          page === 0 &&
          read !== undefined &&
          withdrawalNote.test(read.text)
        );
      });
    }
  } finally {
    await finish(third);
  }

  steps.push({
    name: 'ende_der_prozesse',
    ok:
      sessions.length === 3 && sessions.every((record) => record.endedCleanly),
  });
  return { steps, sessions, commands, undoes, approvals, left, findings };
}

/**
 * The texts the course writes into ChurchTools. No line of log or audit
 * may hold one of them: both name objects only by their IDs (ADR 0028).
 *
 * @param pageTitle - The title of the page of the run.
 * @param entryPrefix - The start of the titles of its appointments and bookings.
 * @returns The texts, each one line.
 */
export function writtenTexts(
  pageTitle: string,
  entryPrefix: string,
): readonly string[] {
  return [
    pageTitle,
    entryPrefix,
    pageText.trim(),
    changedText.trim(),
    ...[1, 2, 3, 4].map(
      (number) => `Synthetischer Abschnitt ${String(number)} des Smoke-Tests.`,
    ),
    entryText,
  ];
}

/**
 * The result of the course as fixed words, for the output.
 *
 * @param outcome - What the course found.
 * @returns One entry per step with its name and whether it went as expected.
 */
export function reportOf(outcome: CourseOutcome): Json {
  return outcome.steps.map((entry) => ({
    schritt: entry.name,
    ergebnis: entry.ok ? 'wie erwartet' : 'abweichend',
  }));
}
