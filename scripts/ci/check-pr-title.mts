/**
 * Checks the title of a pull request.
 *
 * Pull requests are merged by squash, and the title becomes the first line
 * of the commit on main. It therefore follows Conventional Commits 1.0.0
 * with one of the types this project uses, so that the history can later
 * yield release notes and version numbers.
 *
 * Usage: `node scripts/ci/check-pr-title.mts "<title>"`. In CI the title
 * comes from an environment variable and is never written into the script
 * itself, because a title is text from outside.
 *
 * @packageDocumentation
 */

/** The commit types this project uses. */
export const commitTypes: readonly string[] = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
];

// Control characters, including line breaks, every invisible format
// character (Unicode category Cf: direction marks and overrides, zero-width
// characters, tag characters) and variation selectors. In a title they could
// hide text in what the commit on main will say.
const hiddenCharacters =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u{fe00}-\u{fe0f}\u{e0100}-\u{e01ef}]/u;

const header = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?!?: (?<subject>.*)$/;

const scopePattern = /^[a-z0-9][a-z0-9._/-]*$/;

/**
 * Checks a title against Conventional Commits and the types of the project.
 *
 * @param title - Title of the pull request.
 * @returns What is wrong with the title, in German; empty if nothing is.
 */
export function checkTitle(title: string): string[] {
  if (hiddenCharacters.test(title)) {
    return [
      'Der Titel enthält Steuerzeichen oder unsichtbare Zeichen, etwa einen Zeilenumbruch.',
    ];
  }
  if (title !== title.trim()) {
    return ['Der Titel beginnt oder endet mit Leerraum.'];
  }
  const parts = header.exec(title)?.groups;
  if (parts === undefined) {
    return [
      'Der Titel folgt nicht Conventional Commits. Erwartet ist «Typ: Beschreibung» oder «Typ(Bereich): Beschreibung», etwa «fix: reject tokens without prefix».',
    ];
  }
  const { type = '', scope, subject = '' } = parts;
  const problems: string[] = [];
  if (!commitTypes.includes(type)) {
    problems.push(
      `Der Typ «${type}» ist nicht vorgesehen. Erlaubt sind: ${commitTypes.join(', ')}.`,
    );
  }
  if (scope !== undefined && !scopePattern.test(scope)) {
    problems.push(
      'Der Bereich in Klammern besteht aus Kleinbuchstaben, Ziffern und . _ / -.',
    );
  }
  if (subject.trim() === '') {
    problems.push('Nach dem Doppelpunkt fehlt die Beschreibung.');
  } else if (subject !== subject.trimStart()) {
    problems.push('Nach dem Doppelpunkt steht genau ein Leerzeichen.');
  }
  return problems;
}

function main(): number {
  const [title, ...rest] = process.argv.slice(2);
  if (title === undefined || rest.length > 0) {
    console.error('Aufruf: node scripts/ci/check-pr-title.mts "<Titel>"');
    return 2;
  }
  const problems = checkTitle(title);
  for (const problem of problems) {
    console.error(problem);
  }
  console.log(
    problems.length === 0
      ? 'Titel geprüft: Er folgt Conventional Commits.'
      : 'Titel geprüft: Er muss angepasst werden.',
  );
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main();
}
