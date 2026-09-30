import { readFileSync } from 'node:fs';

// Reads the command of a step from a workflow in .github/workflows/, so that
// a test can run exactly what CI runs. The workspace has no YAML parser, and
// the workflows need none: a step starts with `- name:`, and its command is
// either a plain value after `run:` or a literal block (`run: |`). Anything
// else fails loudly here instead of being read wrongly.

const indentation = (line: string): number =>
  line.length - line.trimStart().length;

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
  const body = lines.slice(start + 1, end);
  const runIndex = body.findIndex((line) => /^\s*run:/.test(line));
  if (runIndex === -1) {
    throw new Error(`${workflow}: step «${step}» has no run:`);
  }
  const runLine = body[runIndex] ?? '';
  const value = runLine.slice(runLine.indexOf('run:') + 'run:'.length).trim();
  if (value !== '|') {
    if (value === '' || /^["'>|&*!{[]/.test(value)) {
      throw new Error(`${workflow}: cannot read run: of step «${step}»`);
    }
    return value;
  }
  const key = indentation(runLine);
  const block: string[] = [];
  for (const line of body.slice(runIndex + 1)) {
    if (line.trim() !== '' && indentation(line) <= key) {
      break;
    }
    block.push(line);
  }
  while (block.length > 0 && (block.at(-1) ?? '').trim() === '') {
    block.pop();
  }
  const margin = Math.min(
    ...block.filter((line) => line.trim() !== '').map(indentation),
  );
  return `${block.map((line) => line.slice(margin)).join('\n')}\n`;
}
