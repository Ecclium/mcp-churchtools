import { readFileSync } from 'node:fs';

// Reads the commands of steps from YAML files such as the workflows in
// .github/workflows/ and lefthook.yml, so that a test can check or run
// exactly what CI and the hooks run. The workspace has no YAML parser, and
// these files need none: a step starts with `- name:`, and its command is
// either a plain value on the line of `run:` or a literal block (`run: |`).
// Anything else fails loudly here instead of being read wrongly.

const indentation = (line: string): number =>
  line.length - line.trimStart().length;

/**
 * Reads the value of the `run:` key on the given line.
 *
 * @param lines - The lines of the file.
 * @param index - Index of the line with `run:`.
 * @param where - Names the place in error messages.
 * @returns The command, with the indentation of a literal block removed.
 * @throws {Error} If the value is neither a plain value on one line nor a
 *   literal block.
 */
function readRun(
  lines: readonly string[],
  index: number,
  where: string,
): string {
  const runLine = lines[index] ?? '';
  const key = indentation(runLine);
  const value = runLine.slice(runLine.indexOf('run:') + 'run:'.length).trim();
  const following = lines.slice(index + 1);
  const end = following.findIndex(
    (line) => line.trim() !== '' && indentation(line) <= key,
  );
  const block = end === -1 ? following : following.slice(0, end);
  if (value !== '|') {
    // A plain value may go on over more lines, which YAML folds into one.
    // Returning only the first line would run less than CI does.
    if (
      value === '' ||
      /^["'>|&*!{[]/.test(value) ||
      block.some((line) => line.trim() !== '')
    ) {
      throw new Error(
        `${where}: cannot read run: in line ${String(index + 1)}`,
      );
    }
    return value;
  }
  while (block.length > 0 && (block.at(-1) ?? '').trim() === '') {
    block.pop();
  }
  const margin = Math.min(
    ...block.filter((line) => line.trim() !== '').map(indentation),
  );
  return `${block.map((line) => line.slice(margin)).join('\n')}\n`;
}

/**
 * Returns the value of every `run:` key in a YAML text, in order.
 *
 * @param text - The YAML text, such as a workflow or lefthook.yml.
 * @param where - Names the file in error messages.
 * @returns The commands.
 * @throws {Error} If a value is neither a plain value on one line nor a
 *   literal block.
 */
export function runValues(text: string, where: string): string[] {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    if (!/^\s*(?:- )?run:/.test(line)) {
      return [];
    }
    // `defaults: run:` in a workflow holds settings such as `shell:`, not
    // a command.
    const next = lines
      .slice(index + 1)
      .find((following) => !/^\s*(#.*)?$/.test(following));
    if (
      /^\s*run:\s*$/.test(line) &&
      next !== undefined &&
      indentation(next) > indentation(line) &&
      /^\s*[\w-]+:(\s|$)/.test(next)
    ) {
      return [];
    }
    return [readRun(lines, index, where)];
  });
}

/**
 * Returns the command of a run step as the runner passes it to the shell.
 *
 * @param workflow - File name in .github/workflows/, such as `ci.yml`.
 * @param step - The `name:` of the step.
 * @returns The command, with the indentation of a literal block removed.
 * @throws {Error} If the step does not exist, exists more than once or has
 *   no command in one of the two supported forms.
 */
export function runCommand(workflow: string, step: string): string {
  const lines = readFileSync(
    new URL(`../../.github/workflows/${workflow}`, import.meta.url),
    'utf8',
  ).split('\n');
  const starts = lines.flatMap((line, index) =>
    line.trim() === `- name: ${step}` ? [index] : [],
  );
  const [start] = starts;
  if (start === undefined || starts.length > 1) {
    throw new Error(`${workflow}: ${String(starts.length)} steps «${step}»`);
  }
  // The step ends before the next line that is indented no further than
  // its dash, such as the next step or the next job.
  const dash = indentation(lines[start] ?? '');
  let end = start + 1;
  while (
    end < lines.length &&
    ((lines[end] ?? '').trim() === '' || indentation(lines[end] ?? '') > dash)
  ) {
    end += 1;
  }
  const runIndex = lines
    .slice(start + 1, end)
    .findIndex((line) => /^\s*run:/.test(line));
  if (runIndex === -1) {
    throw new Error(`${workflow}: step «${step}» has no run:`);
  }
  return readRun(lines.slice(0, end), start + 1 + runIndex, workflow);
}
