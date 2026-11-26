import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { createBearerToken } from '../../packages/core/src/bearer/token.ts';

// The rule ecclium-mcp-bearer-token in .gitleaks.toml finds a static bearer
// token of the server over HTTP by its prefix and form, without context
// (ADR 0074). This test feeds single lines to the pinned gitleaks with the
// configuration of the workspace and reads the rules of the findings from
// the JSON report. No token stands in this file: each comes into being at
// run time, so that the rule never finds one in the repository.
//
// It needs mise and gitleaks, as `mise exec -- pnpm check` and the CI jobs
// provide them.

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const configuration = join(workspace, '.gitleaks.toml');

const rule = 'ecclium-mcp-bearer-token';

// Every scan through stdin in this repository prints these two lines first,
// so that a start like the signature of a file format cannot make gitleaks
// skip the text as binary (see .gitleaks.toml).
const header = `\n${' '.repeat(40_000)}\n`;

const timeout = 60_000;

describe(`the rule ${rule} of gitleaks`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'ecclium-gitleaks-bearer-'));
  let runs = 0;

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The rules that report the line, from the JSON report of gitleaks. */
  const scan = (line: string, config = configuration): string[] => {
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
        config,
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

  it(
    'reports a token alone on its line, and only this rule does',
    () => {
      expect(scan(createBearerToken())).toEqual([rule]);
    },
    timeout,
  );

  it.each([
    ['in a header', (token: string) => `Authorization: Bearer ${token}`],
    ['in a setting of YAML', (token: string) => `token: "${token}"`],
    ['in a variable', (token: string) => `MCP_TOKEN=${token}`],
    ['glued to a name', (token: string) => `TOKEN_${token}`],
    ['in a list of JSON', (token: string) => `["${token}"]`],
  ])(
    'reports a token %s',
    (_, line) => {
      expect(scan(line(createBearerToken()))).toContain(rule);
    },
    timeout,
  );

  it(
    'lets a string of another length or another prefix pass',
    () => {
      const token = createBearerToken();
      const tail = token.slice('ecclium_mcp_'.length);
      for (const line of [
        token.slice(0, -1),
        `${token}x`,
        `ecclium_mcq_${tail}`,
        'ecclium_mcp_',
      ]) {
        expect(scan(line), line.length.toString()).not.toContain(rule);
      }
    },
    timeout,
  );

  // The counter-check: without the rule no other rule of the configuration
  // reports a token alone on its line, so the finding above is this rule's.
  it(
    'is needed: without it a token alone passes',
    () => {
      const text = readFileSync(configuration, 'utf8');
      const start = text.indexOf(`[[rules]]\nid = "${rule}"`);
      const end = text.indexOf('[[rules]]', start + 1);
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const without = join(directory, 'without-rule.toml');
      writeFileSync(without, text.slice(0, start) + text.slice(end));
      expect(scan(createBearerToken(), without)).toEqual([]);
    },
    timeout,
  );
});
