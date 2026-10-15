import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

// The rule churchtools-token-assignment in .gitleaks.toml stops a token that
// is assigned to a variable or a setting (ADR 0014). The variables of this
// project carry the prefix ECCLIUM_ (ADR 0055), and the name of the token,
// ECCLIUM_CHURCHTOOLS_TOKEN, has no word boundary before CHURCHTOOLS. This
// test feeds single lines to the pinned gitleaks with the configuration of
// the workspace and reads the rule of each finding from the JSON report, so
// a finding of another rule cannot stand in for this one.
//
// It needs mise and gitleaks, as `mise exec -- pnpm check` and the CI jobs
// provide them.

const workspace = fileURLToPath(new URL('../../', import.meta.url));

const rule = 'churchtools-token-assignment';

// The built-in rule generic-api-key reports a value after any name with
// TOKEN once its entropy reaches 3.5 bits per character. Eight letters give
// at most three, so only the rule under test can report this value. It holds
// no vowel, so no marker of the global allowlist (CANARY, PLACEHOLDER,
// EXAMPLE) can appear in it and silence the rule, and it is new on every
// run.
const letters = 'bdfhkmrt';
const tokenValue = (): string =>
  Array.from({ length: 32 }, () =>
    letters.charAt(randomInt(letters.length)),
  ).join('');

// Every scan through stdin in this repository prints these two lines first,
// so that a start like the signature of a file format cannot make gitleaks
// skip the text as binary (see .gitleaks.toml).
const header = `\n${' '.repeat(40_000)}\n`;

const timeout = 60_000;

describe(`the rule ${rule} of gitleaks`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'ecclium-gitleaks-'));
  let runs = 0;

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The rules that report the line, from the JSON report of gitleaks. */
  const scan = (line: string): string[] => {
    runs += 1;
    const report = join(directory, `report-${String(runs)}.json`);
    const result = spawnSync(
      'mise',
      [
        'exec',
        '--',
        'gitleaks',
        'stdin',
        '--redact',
        '--no-banner',
        '--ignore-gitleaks-allow',
        '--config',
        join(workspace, '.gitleaks.toml'),
        '--report-format',
        'json',
        '--report-path',
        report,
      ],
      {
        cwd: workspace,
        input: `${header}${line}\n`,
        encoding: 'utf8',
        env: {
          ...process.env,
          MISE_TRUSTED_CONFIG_PATHS: workspace,
          NO_COLOR: '1',
        },
      },
    );
    const findings = JSON.parse(readFileSync(report, 'utf8')) as {
      RuleID: string;
    }[];
    // gitleaks exits with 1 on a finding and with 0 without one; any other
    // status means the scan itself failed.
    expect(result.status, result.stderr).toBe(findings.length > 0 ? 1 : 0);
    return findings.map((finding) => finding.RuleID);
  };

  it.each([
    ['the name with the prefix of this project', 'ECCLIUM_CHURCHTOOLS_TOKEN'],
    ['the name without a prefix', 'CHURCHTOOLS_TOKEN'],
    ['the short name', 'CT_TOKEN'],
  ])(
    'report a token assigned to %s',
    (_, name) => {
      expect(scan(`${name}=${tokenValue()}`)).toEqual([rule]);
    },
    timeout,
  );

  it(
    'let a path in the variable of the token file pass',
    () => {
      expect(
        scan('ECCLIUM_CHURCHTOOLS_TOKEN_FILE=/path/to/token-file'),
      ).toEqual([]);
    },
    timeout,
  );

  // The same value after a name that only ends like the one of the token:
  // the rule needs a word boundary or the prefix before CT, and no other rule
  // reports the value, which keeps the cases above meaningful.
  it(
    'let a token assigned to another name with CT pass',
    () => {
      expect(scan(`FOO_CT_TOKEN=${tokenValue()}`)).toEqual([]);
    },
    timeout,
  );
});
