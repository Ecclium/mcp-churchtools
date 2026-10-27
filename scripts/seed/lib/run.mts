/**
 * The course of one command of the seed: what it read, what it wrote, and
 * when it stops.
 *
 * Every request goes through here. A refused write (a status outside 2xx)
 * is noted with its status, and the seed goes on with what does not depend
 * on it. A network error, a timeout or an answer the client cannot read
 * stops the run: after such an error nobody knows whether the instance
 * wrote, so no further request goes out. Nothing is ever sent twice.
 *
 * The report holds only labels of the data set, fixed words and status
 * codes. The course of the seed passes it through the same check as the
 * output of the probes.
 *
 * @packageDocumentation
 */
import { SpikeError, type ErrorCode } from '../../spike/lib/errors.mts';
import type { Guard, Json } from '../../spike/lib/guard.mts';
import type {
  Client,
  ProbeResponse,
  SeedClient,
  SeedRequest,
} from '../../spike/lib/http.mts';
import { isObject, type JsonObject } from '../../spike/lib/spec.mts';

/** The sections of the report, one per kind of object. */
export const sections = [
  'struktur',
  'personen',
  'gruppen',
  'mitglieder',
  'lieder',
  'arrangements',
  'termine',
  'events',
  'einteilungen',
  'ablauf',
  'buchungen',
  'seiten',
  'pruefungen',
] as const;

/** One section of the report. */
export type Section = (typeof sections)[number];

/** The fixed words the report uses as values. */
export const outcomes = [
  'angelegt',
  'vorhanden',
  'fehlt',
  'mehrfach',
  'geloescht',
  'nicht mehr vorhanden',
  'uebersprungen',
  'antwort unerwartet',
  'ohne Recht',
  'sendet Mails',
  'entfernt',
  'ja',
  'nein',
  'sichtbar',
  'sichtbar und bearbeitbar',
] as const;

/** One fixed word of the report. */
export type Outcome = (typeof outcomes)[number];

/** The keys of the report besides sections and labels. */
export const reportKeys = [
  'seed',
  'abgelehnt',
  'abbruch',
  'churchtoolsVersion',
  'unbekannt',
] as const;

/** How long the seed waits before each write, in milliseconds. */
export const writePause = 1100;

/** What a run needs from outside. */
export interface RunOptions {
  readonly client: Client;
  readonly writer: SeedClient | undefined;
  readonly guard: Guard;
  readonly wait: (milliseconds: number) => Promise<void>;
}

/** The state of one command of the seed. */
export class SeedRun {
  /** What happened, by section and label. */
  readonly report = new Map<Section, Map<string, Json>>();

  /** The code that stopped the run, if one did. */
  stopped: ErrorCode | undefined;

  private readonly options: RunOptions;

  /**
   * Starts an empty run.
   *
   * @param options - Clients, guard and the way to wait.
   */
  constructor(options: RunOptions) {
    this.options = options;
  }

  /**
   * Notes the outcome for one object.
   *
   * @param section - The section of the report.
   * @param label - The label of the object in the data set.
   * @param outcome - A fixed word, or the status of a refusal.
   */
  note(section: Section, label: string, outcome: Outcome | number): void {
    let entries = this.report.get(section);
    if (entries === undefined) {
      entries = new Map();
      this.report.set(section, entries);
    }
    if (typeof outcome === 'number') {
      this.options.guard.allowFixed(outcome);
      entries.set(label, { abgelehnt: outcome });
    } else {
      entries.set(label, outcome);
    }
  }

  private stop(error: unknown): void {
    if (!(error instanceof SpikeError) || error.code === 'INTERN') {
      throw error;
    }
    this.stopped = error.code;
  }

  /**
   * Reads one list or object with GET. After a stop it reads nothing.
   *
   * @param path - Filled path of the operation.
   * @param query - Query parameters, all declared by the instance.
   * @returns The answer, or `undefined` once the run has stopped.
   */
  async read(
    path: string,
    query: readonly (readonly [string, string])[] = [],
  ): Promise<ProbeResponse | undefined> {
    if (this.stopped !== undefined) {
      return undefined;
    }
    try {
      return await this.options.client.get({ path, query });
    } catch (error) {
      this.stop(error);
      return undefined;
    }
  }

  /**
   * Sends one write once, after a short pause. Notes a refusal with its
   * status. After a stop, or without a client that writes, it notes the
   * object as skipped and sends nothing.
   *
   * @param section - The section of the report.
   * @param label - The label of the object.
   * @param request - Operation, IDs and body.
   * @param gone - For a delete: whether 404 means that the object is already gone, as after deleting the event of an appointment.
   * @returns The answer if the instance accepted it, otherwise `undefined`.
   */
  async write(
    section: Section,
    label: string,
    request: SeedRequest,
    gone = false,
  ): Promise<ProbeResponse | undefined> {
    const { writer } = this.options;
    if (this.stopped !== undefined || writer === undefined) {
      this.note(section, label, 'uebersprungen');
      return undefined;
    }
    await this.options.wait(writePause);
    let response: ProbeResponse;
    try {
      response = await writer.send(request);
    } catch (error) {
      this.stop(error);
      this.note(section, label, 'uebersprungen');
      return undefined;
    }
    if (gone && response.status === 404) {
      this.note(section, label, 'nicht mehr vorhanden');
      return undefined;
    }
    if (response.status < 200 || response.status > 299) {
      this.note(section, label, response.status);
      return undefined;
    }
    return response;
  }

  /**
   * Builds the output of the run.
   *
   * @param command - The command that ran.
   * @param version - The ChurchTools version as major and minor number.
   * @returns The report, with the stop code if there is one.
   */
  output(command: string, version: string | null): Json {
    const result: Record<string, Json> = {
      seed: command,
      churchtoolsVersion: version ?? 'unbekannt',
    };
    for (const section of sections) {
      const entries = this.report.get(section);
      if (entries !== undefined) {
        result[section] = Object.fromEntries(entries);
      }
    }
    if (this.stopped !== undefined) {
      result['abbruch'] = this.stopped;
    }
    return result;
  }
}

/**
 * Takes the `data` of an answer if it is an object.
 *
 * @param response - An answer of the instance.
 * @returns The object, or `undefined`.
 */
export function dataObject(
  response: ProbeResponse | undefined,
): JsonObject | undefined {
  const data = isObject(response?.body) ? response.body['data'] : undefined;
  return isObject(data) ? data : undefined;
}
