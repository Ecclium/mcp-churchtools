import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepository, type Repository } from '../support/git.mts';
import { runCommand, runValues } from '../support/workflows.mts';

// The scans in CI read file names, the title of a pull request and commit
// messages through `gitleaks stdin` (ADR 0014). This test takes the command
// of each such step from its workflow and runs it in a temporary repository
// with bash in the mode the runner uses (-eo pipefail), so it checks what CI
// runs, not a copy. Every run that must fail has a counterpart that passes,
// so a test cannot pass merely because a step fails for another reason.
//
// It needs mise, gitleaks and Git, as `mise exec -- pnpm check` and the CI
// jobs provide them.

const workspace = fileURLToPath(new URL('../../', import.meta.url));

const read = (file: string): string =>
  readFileSync(join(workspace, file), 'utf8');

// The scans read the rules from .gitleaks.toml, and the mise files select
// the version of gitleaks, as in the hook test.
const configFiles = [
  '.gitleaks.toml',
  ...spawnSync('git', ['ls-files', '--', 'mise*.toml', 'mise*.lock'], {
    cwd: workspace,
    encoding: 'utf8',
  })
    .stdout.split('\n')
    .filter((name) => /^mise(\.[^./]+)?\.(toml|lock)$/.test(name)),
];

/** A subdomain of church.tools that is new on every run. */
const canaryHost = (): string =>
  `${randomBytes(6).toString('hex')}.church.tools`;

// gitleaks skips piped text as a binary file when its first bytes look like
// the signature of a file format. A name or a message that starts with this
// one does, which the two lines each scan prints first must neutralise (see
// .gitleaks.toml).
const binaryStart = '%PDF-1.7';

/** The local scans of `pnpm ci:secret-scan`, which pnpm runs with sh. */
const localScript = (
  JSON.parse(read('package.json')) as { scripts: Record<string, string> }
).scripts['ci:secret-scan'];

const timeout = 60_000;

describe('the scans of names, titles and messages in CI', () => {
  const repositories: Repository[] = [];

  /** A repository whose first commit holds the configuration of the scans. */
  const setUp = (): Repository => {
    const repository = createRepository();
    repositories.push(repository);
    for (const file of configFiles) {
      copyFileSync(join(workspace, file), join(repository.path, file));
    }
    repository.git(['add', '--', ...configFiles]);
    repository.git(['commit', '--quiet', '--message', 'chore: add the scans']);
    return repository;
  };

  const commit = (
    repository: Repository,
    file: string,
    message: string,
  ): void => {
    writeFileSync(join(repository.path, file), 'Nothing to report.\n');
    repository.git(['add', '--', file]);
    repository.git(['commit', '--quiet', '--message', message]);
  };

  // In a pull request the job checks out the test merge: HEAD^1 is the base
  // and HEAD^2 the head of the pull request.
  const testMerge = (
    repository: Repository,
    messages: readonly string[],
  ): void => {
    repository.git(['switch', '--quiet', '--create', 'feature']);
    messages.forEach((message, index) => {
      commit(repository, `change-${String(index)}.md`, message);
    });
    repository.git(['switch', '--quiet', 'main']);
    repository.git(['merge', '--quiet', '--no-ff', '--no-edit', 'feature']);
  };

  /** Runs a command with the tools from mise, in the given shell. */
  const shell = (
    repository: Repository,
    command: string,
    {
      runner = true,
      extra = {},
    }: { runner?: boolean; extra?: NodeJS.ProcessEnv } = {},
  ): { status: number | null; output: string } => {
    const result = repository.run(
      'mise',
      [
        'exec',
        '--',
        ...(runner
          ? ['bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c']
          : ['sh', '-c']),
        command,
      ],
      { MISE_TRUSTED_CONFIG_PATHS: repository.path, NO_COLOR: '1', ...extra },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  };

  /** Runs a step of a workflow as the runner does. */
  const run = (
    repository: Repository,
    workflow: string,
    step: string,
    extra: NodeJS.ProcessEnv = {},
  ): { status: number | null; output: string } =>
    shell(repository, runCommand(workflow, step), { extra });

  afterEach(() => {
    for (const repository of repositories.splice(0)) {
      repository.remove();
    }
  });

  it(
    'find a name behind a first name that starts like a binary file',
    () => {
      const step = 'Scan the names of all files, now and in the history';
      const host = canaryHost();
      const repository = setUp();
      commit(repository, `${binaryStart}-notes.md`, 'docs: add notes');
      commit(repository, `export-${host}.md`, 'docs: add an export');

      const result = run(repository, 'ci.yml', step);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('leaks found: 1');
      expect(result.output).not.toContain(host);

      const clean = setUp();
      commit(clean, `${binaryStart}-notes.md`, 'docs: add notes');
      commit(clean, 'export.md', 'docs: add an export');
      const counterpart = run(clean, 'ci.yml', step);
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  it(
    'find a title that starts like a binary file',
    () => {
      const step = 'Scan the title for secrets';
      const host = canaryHost();
      const repository = setUp();

      const result = run(repository, 'pr-meta.yml', step, {
        TITLE: `${binaryStart} fix: notes from ${host}`,
      });
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('leaks found: 1');
      expect(result.output).not.toContain(host);

      const counterpart = run(repository, 'pr-meta.yml', step, {
        TITLE: `${binaryStart} fix: notes from example.church.tools`,
      });
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  it(
    'find a message of a pull request behind one that starts like a binary file',
    () => {
      const step = 'Scan the commit messages for secrets';
      const host = canaryHost();
      const repository = setUp();
      testMerge(repository, [
        `fix: one\n\nFrom ${host}.`,
        `${binaryStart} fix: two`,
      ]);

      const result = run(repository, 'pr-meta.yml', step);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain('leaks found: 1');
      expect(result.output).not.toContain(host);

      const clean = setUp();
      testMerge(clean, [
        'fix: one\n\nFrom example.church.tools.',
        `${binaryStart} fix: two`,
      ]);
      const counterpart = run(clean, 'pr-meta.yml', step);
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  // On main every commit is the squash commit of a pull request, and whoever
  // merges can change its message. In a pull request the job sees the test
  // merge, whose second parent leads to the commits of the pull request.
  it(
    'find a message on main and one behind the second parent of a merge',
    () => {
      const step =
        'Scan the messages of every commit that leads to the tested one';
      const host = canaryHost();

      const squashed = setUp();
      commit(squashed, 'one.md', `fix: one (#1)\n\nFrom ${host}.`);
      commit(squashed, 'two.md', `${binaryStart} fix: two (#2)`);
      const onMain = run(squashed, 'ci.yml', step);
      expect(onMain.status, onMain.output).toBe(1);
      expect(onMain.output).toContain('leaks found: 1');
      expect(onMain.output).not.toContain(host);

      const merged = setUp();
      testMerge(merged, [`fix: one\n\nFrom ${host}.`]);
      const inMerge = run(merged, 'ci.yml', step);
      expect(inMerge.status, inMerge.output).toBe(1);
      expect(inMerge.output).toContain('leaks found: 1');

      const clean = setUp();
      commit(clean, 'one.md', 'fix: one (#1)\n\nFrom example.church.tools.');
      commit(clean, 'two.md', `${binaryStart} fix: two (#2)`);
      testMerge(clean, ['fix: three\n\nFrom example.church.tools.']);
      const counterpart = run(clean, 'ci.yml', step);
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output).toContain('no leaks found');
    },
    timeout,
  );

  // `pnpm ci:local` runs these scans on a developer machine, with sh as pnpm
  // does.
  it(
    'find the same in the local scans of pnpm ci:secret-scan',
    () => {
      expect(localScript).toBeDefined();
      const script = localScript ?? '';
      const host = canaryHost();

      const inName = setUp();
      commit(inName, `${binaryStart}-notes.md`, 'docs: add notes');
      commit(inName, `export-${host}.md`, 'docs: add an export');
      const nameResult = shell(inName, script, { runner: false });
      expect(nameResult.status, nameResult.output).toBe(1);
      expect(nameResult.output).toContain('leaks found: 1');
      expect(nameResult.output).not.toContain(host);

      const inMessage = setUp();
      commit(inMessage, 'one.md', `fix: one (#1)\n\nFrom ${host}.`);
      commit(inMessage, 'two.md', `${binaryStart} fix: two (#2)`);
      const messageResult = shell(inMessage, script, { runner: false });
      expect(messageResult.status, messageResult.output).toBe(1);
      expect(messageResult.output).toContain('leaks found: 1');
      expect(messageResult.output).not.toContain(host);

      const clean = setUp();
      commit(clean, `${binaryStart}-notes.md`, `${binaryStart} fix: two (#2)`);
      const counterpart = shell(clean, script, { runner: false });
      expect(counterpart.status, counterpart.output).toBe(0);
      expect(counterpart.output.split('no leaks found').length - 1).toBe(3);
    },
    timeout,
  );

  /** Commits a binary file, made binary by its NUL bytes. */
  const commitBinary = (
    repository: Repository,
    file: string,
    message: string,
  ): void => {
    mkdirSync(dirname(join(repository.path, file)), { recursive: true });
    writeFileSync(
      join(repository.path, file),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01, 0x02]),
    );
    repository.git(['add', '--', file]);
    repository.git(['commit', '--quiet', '--message', message]);
  };

  // gitleaks skips binary files, so an export or a database with member
  // data would pass every scan. CI refuses a binary file outside brand/ in
  // the whole history, by its content and whatever .gitattributes says.
  it(
    'refuse a binary file outside brand/, also one removed later',
    () => {
      const step = 'Refuse binary files outside brand/';
      const repository = setUp();
      writeFileSync(join(repository.path, '.gitattributes'), '*.xlsx diff\n');
      repository.git(['add', '--', '.gitattributes']);
      commitBinary(repository, 'data/members.xlsx', 'docs: add an export');
      repository.git(['rm', '--quiet', '--', 'data/members.xlsx']);
      repository.git(['commit', '--quiet', '--message', 'docs: remove it']);

      const result = run(repository, 'ci.yml', step);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        'Binärdatei ausserhalb von brand/: data/members.xlsx',
      );
      const local = shell(repository, localScript ?? '', { runner: false });
      expect(local.status, local.output).toBe(1);
      expect(local.output).toContain(
        'Binärdatei ausserhalb von brand/: data/members.xlsx',
      );

      const clean = setUp();
      commitBinary(clean, 'brand/png/logo.png', 'docs: add the logo');
      const counterpart = run(clean, 'ci.yml', step);
      expect(counterpart.status, counterpart.output).toBe(0);
      const localCounterpart = shell(clean, localScript ?? '', {
        runner: false,
      });
      expect(localCounterpart.status, localCounterpart.output).toBe(0);
    },
    timeout,
  );

  // The runs above cover each scan once. This check finds every scan through
  // stdin in the tracked files, including scans added later, and requires
  // the two lines as the start of the very pipeline that feeds gitleaks.
  it('let every scan through stdin read the two lines first', () => {
    // Matches the text printf '\n%40000s\n with a backslash before each n.
    const header = String.raw`printf '\\n%40000s\\n`;
    const forms = [
      // A group in a run: value of a workflow or of lefthook.yml.
      new RegExp(
        String.raw`^\{ ${header}' ''\n(?:[^\n]*\n)+\} \| (?:mise exec -- )?gitleaks stdin [^|;&\n]*\n$`,
      ),
      // A single value, such as the title, printed after the two lines.
      new RegExp(
        String.raw`^${header}%s\\n' '' "\$[A-Z_]+" \| gitleaks stdin [^|;&\n]*$`,
      ),
      // A group in a script of package.json.
      new RegExp(
        String.raw`^\{ ${header}' ''; .*; \} \| gitleaks stdin [^|;&]*$`,
      ),
    ];
    const code = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !/^\s*(#|\/\/|\*)/.test(line))
        .join('\n');
    const count = (text: string): number =>
      text.split('gitleaks stdin').length - 1;

    // New files count before they are committed, ignored ones never.
    const tracked = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: workspace, encoding: 'utf8' },
    )
      .stdout.split('\n')
      .filter(
        (file) =>
          file !== '' &&
          !file.startsWith('docs/') &&
          !file.startsWith('tests/') &&
          !file.endsWith('.md'),
      );
    const commands: [string, string][] = [];
    for (const file of tracked) {
      const text = read(file);
      if (count(code(text)) === 0) {
        continue;
      }
      let found: string[];
      if (file === 'package.json') {
        const { scripts } = JSON.parse(text) as {
          scripts: Record<string, string>;
        };
        found = Object.values(scripts).flatMap((script) =>
          script.split(' && '),
        );
      } else if (/\.ya?ml$/.test(file)) {
        found = runValues(text, file);
      } else {
        found = [];
      }
      // Every scan in the file must be one that this check reads.
      expect(count(found.join('\n')), file).toBe(count(code(text)));
      commands.push(
        ...found
          .filter((command) => count(command) > 0)
          .map((command): [string, string] => [file, command]),
      );
    }
    expect(commands.length).toBeGreaterThanOrEqual(7);
    for (const [file, command] of commands) {
      expect(count(command), file).toBe(1);
      expect(
        forms.some((form) => form.test(command)),
        `${file}: ${command}`,
      ).toBe(true);
    }
  });
});
