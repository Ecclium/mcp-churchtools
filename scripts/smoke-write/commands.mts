/**
 * The commands of the operator that the smoke test for writing runs
 * between its calls: `ecclium undo`, `ecclium queue list`,
 * `ecclium queue approve` and at the end `ecclium audit verify`.
 *
 * Each runs as its own process of the same build, with the same filtered
 * environment as the server, so it reaches the same folder of state, the
 * same day keys and the same snapshots (ADR 0031). The smoke test reads
 * only the exit code and, after an approval, the ID to take the write back
 * with; what a command prints holds text of ChurchTools and is never
 * printed by the smoke test, only kept to look for leaks and anchors.
 *
 * @packageDocumentation
 */
import { spawnSync } from 'node:child_process';

/** How the smoke test starts `ecclium` for a command other than stdio. */
export interface CommandStart {
  /** Usually Node.js itself. */
  readonly executable: string;
  /** Arguments before the entry, empty in a real run. */
  readonly preArgs: readonly string[];
  /** The entry of the command `ecclium`. */
  readonly entry: string;
}

/** What a command left. */
export interface CommandRun {
  /** The exit code, or `null` after a signal or the deadline. */
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The longest a command may take: an undo reads and writes twice. */
export const commandDeadline = 120_000;

/**
 * Runs one command of `ecclium` and waits for its end.
 *
 * @param start - How to start `ecclium`.
 * @param args - The command and its arguments, such as `['undo', id]`.
 * @param env - The whole environment of the child.
 * @param input - Text for stdin, such as the log for `audit verify --log -`.
 * @returns Exit code and output.
 */
export function runCommand(
  start: CommandStart,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  input = '',
): CommandRun {
  const result = spawnSync(
    start.executable,
    [...start.preArgs, start.entry, ...args],
    {
      env: { ...env },
      input,
      encoding: 'utf8',
      timeout: commandDeadline,
      maxBuffer: 4 * 1_048_576,
    },
  );
  return {
    status: result.error === undefined ? result.status : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

// The sentence of `ecclium queue approve` that names the ID of the undo,
// with the angle quotes of the command line around the command.
const undoSentence =
  /Zurücknehmen lässt sich der Schreibvorgang mit ‹ecclium undo ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})›\./u;

/**
 * Reads the ID of the undo from the output of `ecclium queue approve`.
 *
 * @param stdout - What the command printed.
 * @returns The ID, or `undefined` if the sentence is not there exactly once.
 */
export function undoIdOfApproval(stdout: string): string | undefined {
  const found = [...stdout.matchAll(new RegExp(undoSentence.source, 'gu'))];
  return found.length === 1 ? found[0]?.[1] : undefined;
}

// The line of `ecclium audit verify` when every file named by an anchor
// ends with the line of its anchor, and there is at least one.
const anchoredLine =
  /^ {2}Dateien mit einem Anker aus dem Log: ([1-9]\d*), davon passend \1,/mu;

/**
 * Whether `ecclium audit verify` found every chain whole and fitting the
 * anchors of the log it got.
 *
 * @param run - The run of `audit verify --log -`.
 * @returns Whether it ended with 0 and every anchor fits its file.
 */
export function chainsFit(run: CommandRun): boolean {
  return run.status === 0 && anchoredLine.test(run.stdout);
}
