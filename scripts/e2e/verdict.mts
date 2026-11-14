// The verdicts of the E2E job (ADR 0036) as pure functions, so that their
// tests run in the job check without Docker. scripts/e2e/run.mts gathers
// what the containers did and asks these functions whether it holds.
//
// The count of sections reads the lines of the marking with a pattern of
// its own, not with the code of the core: the job checks the core, so its
// verdict must not share a mistake with it.

/** The ID of the routine of the job. */
export const routineId = 'e2e-bericht';

// The line of the marking of a run of a routine (ADR 0032), up to the text
// of the operator.
const markingLine =
  /^Automatisch erstellt am \d{2}\.\d{2}\.\d{4} durch Ecclium, Routine ([a-z0-9][a-z0-9-]{0,62}), Lauf ([0-9A-Za-z][0-9A-Za-z-]{0,31}), Prüfcode k1:[A-Z2-7]{13}\. Rückfragen an \S/u;

/**
 * Counts the sections of a routine on a page, per period, by the lines of
 * their marking.
 *
 * @param text - The text of the page.
 * @param routine - The ID of the routine.
 * @returns The number of sections of each period the page holds.
 */
export function sectionsOf(
  text: string,
  routine: string,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const line of text.split('\n')) {
    const [, found, period] = markingLine.exec(line.trimEnd()) ?? [];
    if (found !== routine || period === undefined) continue;
    counts.set(period, (counts.get(period) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether every period of the routine has exactly one section, and at
 * least one period has one.
 *
 * @param text - The text of the page.
 * @param routine - The ID of the routine.
 * @returns A sentence for each failure, none when it holds.
 */
export function oneSectionPerPeriod(text: string, routine: string): string[] {
  const counts = sectionsOf(text, routine);
  if (counts.size === 0) return ['Die Seite hat keinen Abschnitt der Routine.'];
  return [...counts]
    .filter(([, count]) => count !== 1)
    .map(
      ([period, count]) =>
        `Die Periode ${period} hat ${String(count)} Abschnitte statt einem.`,
    );
}

/**
 * The line the fault follows in the built core: the start of
 * `judgeSections` in packages/core/dist/marker/sections.js, which tells a
 * write whether a page already holds its own section.
 */
export const faultAnchor = 'export function judgeSections(options) {';

/**
 * The fault built in after the anchor: no page ever holds an own section,
 * so a run adds a second one instead of replacing its own.
 */
export const faultLine = "    return Object.freeze({ kind: 'none' });";

/**
 * Builds the fault into the source of the built module, only when the
 * anchor stands there exactly once.
 *
 * @param source - The text of packages/core/dist/marker/sections.js.
 * @returns The changed text, or how often the anchor stood there.
 */
export function withFault(
  source: string,
):
  | { readonly ok: true; readonly source: string }
  | { readonly ok: false; readonly found: number } {
  const found = source.split(faultAnchor).length - 1;
  if (found !== 1) return { ok: false, found };
  return {
    ok: true,
    source: source.replace(faultAnchor, `${faultAnchor}\n${faultLine}`),
  };
}

// The day of an instant in a time zone, as YYYY-MM-DD.
const dayIn = (instant: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

/**
 * How long to wait so that no change of day falls into the next minutes:
 * the counters of a day count per UTC day (ADR 0063), the period of a run
 * by the day in the time zone of the runner, and a week changes only with
 * a day. A proof that spans such a change would compare two days.
 *
 * @param now - Milliseconds since the Unix epoch.
 * @param windowMs - How long the proof may take.
 * @param timeZone - The time zone of the runner.
 * @returns The milliseconds to wait, 0 when no change falls into the window.
 */
export function waitBeforeProof(
  now: number,
  windowMs: number,
  timeZone: string,
): number {
  const end = now + windowMs;
  const changes = (zone: string): boolean =>
    dayIn(now, zone) !== dayIn(end, zone);
  if (!changes('UTC') && !changes(timeZone)) return 0;
  // Step a minute at a time to the first instant after the change.
  let wait = 0;
  while (wait <= windowMs) {
    wait += 60_000;
    const at = now + wait;
    if (
      dayIn(at, 'UTC') === dayIn(at + windowMs, 'UTC') &&
      dayIn(at, timeZone) === dayIn(at + windowMs, timeZone)
    ) {
      return wait;
    }
  }
  return wait;
}

/** The outcome of one attempt of the probe of the network. */
export interface ProbeOutcome {
  readonly result: 'ok' | 'failed' | 'timeout';
  readonly code?: string;
}

/** What scripts/e2e/probe.mts saw from inside the network of the runner. */
export interface ProbeResult {
  /** The name of the decoy, resolved directly. */
  readonly decoyName: ProbeOutcome;
  /** The address of the decoy, connected directly. */
  readonly decoyAddress: ProbeOutcome;
  /** The proxy, connected directly: the one way out. */
  readonly proxy: ProbeOutcome;
  /** The status of CONNECT through the proxy, per target. */
  readonly connect: Readonly<Record<string, number | undefined>>;
  /** The handshake of TLS through each tunnel the proxy opened. */
  readonly tls: Readonly<Record<string, ProbeOutcome | undefined>>;
  /** The status of a plain GET through the proxy, without CONNECT. */
  readonly plainGet: number | undefined;
}

/**
 * Judges the probe of the network: no direct way to the decoy, by name or
 * by address, the proxy reachable, and through it the two stand-ins only.
 *
 * @param probe - What the probe saw.
 * @param allowed - The targets of the list, as `name:port`.
 * @param refused - The targets outside the list.
 * @returns A sentence for each failure, none when it holds.
 */
export function judgeProbe(
  probe: ProbeResult,
  allowed: readonly string[],
  refused: readonly string[],
): string[] {
  const failures: string[] = [];
  if (probe.decoyName.result === 'ok') {
    failures.push(
      'Der Name des Lockziels lässt sich im Netz des Runners auflösen.',
    );
  }
  if (probe.decoyAddress.result === 'ok') {
    failures.push('Das Lockziel ist über seine Adresse direkt erreichbar.');
  }
  if (probe.proxy.result !== 'ok') {
    failures.push('Der Proxy ist aus dem Netz des Runners nicht erreichbar.');
  }
  for (const target of allowed) {
    if (probe.connect[target] !== 200) {
      failures.push(
        `CONNECT zu ${target} gab ${String(probe.connect[target])} statt 200.`,
      );
    } else if (probe.tls[target]?.result !== 'ok') {
      const outcome = probe.tls[target];
      failures.push(
        `TLS zu ${target} durch den Tunnel: ${outcome?.code ?? outcome?.result ?? 'kein Ergebnis'}.`,
      );
    }
  }
  for (const target of refused) {
    if (probe.connect[target] !== 403) {
      failures.push(
        `CONNECT zu ${target} gab ${String(probe.connect[target])} statt 403.`,
      );
    }
  }
  if (probe.plainGet !== 403) {
    failures.push(
      `Ein GET ohne CONNECT durch den Proxy gab ${String(probe.plainGet)} statt 403.`,
    );
  }
  return failures;
}

/** The prefix of the line with the peaks of a container. */
export const peakPrefix = 'e2e-peak';

/** The highest memory and number of processes of a container. */
export interface Peak {
  /** Bytes, from memory.peak of its cgroup. */
  readonly memory?: number;
  /** Processes, from pids.peak of its cgroup. */
  readonly pids?: number;
}

/**
 * Reads the line with the peaks from the output of a run, as the wrapper
 * of the driver writes it last: `e2e-peak <bytes> <processes>`, with `-`
 * for a value the kernel does not give.
 *
 * @param output - What the container wrote on stdout.
 * @returns The peaks, or undefined without such a line.
 */
export function peakOf(output: string): Peak | undefined {
  const line = output
    .split('\n')
    .reverse()
    .find((candidate) => candidate.startsWith(`${peakPrefix} `));
  if (line === undefined) return undefined;
  const [, memory, pids] = line.trim().split(' ');
  const number = (value: string | undefined): number | undefined =>
    value !== undefined && /^\d+$/u.test(value) ? Number(value) : undefined;
  const peak: { memory?: number; pids?: number } = {};
  const bytes = number(memory);
  const processes = number(pids);
  if (bytes !== undefined) peak.memory = bytes;
  if (processes !== undefined) peak.pids = processes;
  return peak;
}

/**
 * Judges the peaks of the runs against the limits of the container. The
 * kernel enforces the limits itself: a run beyond the memory ends with
 * 137, one beyond the processes cannot start a thread. This verdict only
 * makes sure that the measure worked and that no run touched a limit.
 *
 * @param peaks - The peaks of every measured run, undefined for one that
 *   gave no line with them.
 * @param limits - The limits of the container.
 * @param limits.memory - Bytes.
 * @param limits.pids - Processes.
 * @returns A sentence for each failure, none when it holds.
 */
export function judgePeaks(
  peaks: readonly (Peak | undefined)[],
  limits: { readonly memory: number; readonly pids: number },
): string[] {
  const failures: string[] = [];
  if (peaks.length === 0) failures.push('Kein Lauf wurde gemessen.');
  if (peaks.some((peak) => peak === undefined)) {
    failures.push('Ein gemessener Lauf nannte keine Höchstwerte.');
  }
  const given = peaks.filter((peak): peak is Peak => peak !== undefined);
  if (given.some((peak) => peak.memory === undefined)) {
    failures.push('Ein gemessener Lauf nannte seinen höchsten Speicher nicht.');
  }
  // Older kernels have no pids.peak; then no run gives it, and the limit
  // alone holds. Some with and some without it would be a broken measure.
  const withPids = given.filter((peak) => peak.pids !== undefined).length;
  if (withPids !== 0 && withPids !== given.length) {
    failures.push('Nur ein Teil der Läufe nannte die Zahl der Prozesse.');
  }
  const memory = Math.max(0, ...given.map((peak) => peak.memory ?? 0));
  const pids = Math.max(0, ...given.map((peak) => peak.pids ?? 0));
  if (memory >= limits.memory) {
    failures.push('Ein Lauf hat die Grenze für den Speicher erreicht.');
  }
  if (pids >= limits.pids) {
    failures.push('Ein Lauf hat die Grenze für die Prozesse erreicht.');
  }
  return failures;
}

/**
 * The highest values of all runs, for the report.
 *
 * @param peaks - The peaks of every measured run.
 * @returns The highest memory in bytes and the most processes, 0 when no
 *   run gave one.
 */
export function highestPeak(peaks: readonly (Peak | undefined)[]): {
  readonly memory: number;
  readonly pids: number;
} {
  return {
    memory: Math.max(0, ...peaks.map((peak) => peak?.memory ?? 0)),
    pids: Math.max(0, ...peaks.map((peak) => peak?.pids ?? 0)),
  };
}

/** One request a stand-in answered. */
export interface Call {
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

/**
 * Counts the requests of one method whose path starts with a prefix.
 *
 * @param calls - What a stand-in reported.
 * @param method - The method, such as `PATCH`.
 * @param prefix - The start of the path.
 * @returns How many there were.
 */
export function countCalls(
  calls: readonly Call[],
  method: string,
  prefix: string,
): number {
  return calls.filter(
    (call) => call.method === method && call.path.startsWith(prefix),
  ).length;
}
