/**
 * The only way anything leaves a probe.
 *
 * Results go to stdout as JSON, after the guard has checked them. Short
 * notes in German go to stderr, and only fixed texts: the fixed hints, the
 * Node.js version and the SHA-256 of the script files, so the person who
 * runs a probe can compare them with the pull request. An error shows its
 * fixed code, never its message, cause or stack.
 *
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { SpikeError, hints, type ErrorCode } from './errors.mts';
import type { Guard, Json } from './guard.mts';

/** Where a probe writes. Replaceable in tests. */
export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Exit codes of the probes. */
export const exitCodes = {
  ok: 0,
  configuration: 2,
  withheld: 3,
  network: 4,
  internal: 70,
} as const;

const withheldNote =
  'Ausgabe zurückgehalten: An den genannten Stellen stünden womöglich Daten aus der Instanz. Nichts davon wurde ausgegeben.';

function scriptFiles(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(mts|md)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Lists the Node.js version and the SHA-256 of every script file.
 *
 * @param folder - Folder of the probes.
 * @returns Lines for stderr, with paths relative to the folder.
 */
export function integrityLines(folder: string): string[] {
  const lines = [`Node.js ${process.version}`, 'SHA-256 der Skripte:'];
  for (const file of scriptFiles(folder)) {
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    lines.push(`${hash}  ${relative(folder, file).split(sep).join('/')}`);
  }
  return lines;
}

/**
 * Writes the result of a probe, if the guard lets it pass.
 *
 * @param output - The result of the probe.
 * @param guard - The guard of this run.
 * @param io - Where to write.
 * @returns The exit code: 0 if written, 3 if withheld.
 */
export function writeResult(output: Json, guard: Guard, io: Io): number {
  const findings = guard.check(output);
  if (findings.length === 0) {
    io.stdout(`${JSON.stringify(output, null, 2)}\n`);
    return exitCodes.ok;
  }
  io.stdout(
    `${JSON.stringify({ zurueckgehalten: true, stellen: findings }, null, 2)}\n`,
  );
  io.stderr(`${withheldNote}\n`);
  return exitCodes.withheld;
}

function exitCodeFor(code: ErrorCode): number {
  switch (code) {
    case 'KONFIGURATION':
    case 'DATEI':
      return exitCodes.configuration;
    case 'INTERN':
      return exitCodes.internal;
    default:
      return exitCodes.network;
  }
}

/**
 * Reports an error with its fixed code and hint only.
 *
 * @param error - Whatever was thrown.
 * @param io - Where to write.
 * @returns The exit code for this error.
 */
export function writeError(error: unknown, io: Io): number {
  if (error instanceof SpikeError) {
    io.stderr(`Code: ${error.code}\n`);
    const hint =
      error.hint ??
      (exitCodeFor(error.code) === exitCodes.network
        ? error.code.startsWith('ANTWORT')
          ? 'antwort'
          : 'netz'
        : 'intern');
    io.stderr(`${hints[hint]}\n`);
    return exitCodeFor(error.code);
  }
  io.stderr(`Code: INTERN\n${hints.intern}\n`);
  return exitCodes.internal;
}

/**
 * Makes sure that an error outside the normal flow shows only its code.
 *
 * Node.js would otherwise print the message and stack of an uncaught
 * error, which can contain data from a response.
 *
 * @param io - Where to write.
 */
export function installCrashHandlers(io: Io): void {
  const crash = (): void => {
    io.stderr(`Code: INTERN\n${hints.intern}\n`);
    process.exit(exitCodes.internal);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}
