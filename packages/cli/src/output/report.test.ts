import {
  type ConfigReport,
  type ConfigResult,
  loadConfig,
  maxReportedProblems,
  type SettingReport,
  type TokenFileSystem,
  tokenVariableName,
} from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { renderConfigReport } from './index.js';

type Environment = Record<string, string>;

const address = 'https://example.church.tools';
const tokenPath = '/path/to/token-file';

/** One good token file in memory, with a new token on every call. */
const goodFile = (): { files: TokenFileSystem; token: string } => {
  const token = makeCanary('token').value;
  const bytes = new TextEncoder().encode(`${token}\n`);
  const state = { position: 0 };
  const files: TokenFileSystem = {
    openSync: () => {
      state.position = 0;
      return 3;
    },
    fstatSync: () => ({
      isFile: () => true,
      uid: 1000,
      mode: 0o100600,
      size: bytes.length,
    }),
    readSync: (_fd, buffer, offset, length) => {
      const chunk = bytes.subarray(state.position, state.position + length);
      buffer.set(chunk, offset);
      state.position += chunk.length;
      return chunk.length;
    },
    closeSync: () => undefined,
    getuid: () => 1000,
    constants: { O_RDONLY: 0, O_NOFOLLOW: 1, O_NONBLOCK: 2, O_NOCTTY: 4 },
  };
  return { files, token };
};

const load = (environment: Environment): ConfigResult =>
  loadConfig({ environment, transport: 'stdio', tokenFiles: goodFile().files });

const render = (environment: Environment, showValues = false) => {
  const result = load(environment);
  return renderConfigReport(result.report, { valid: result.ok, showValues });
};

const minimal = (): Environment => ({
  ECCLIUM_CHURCHTOOLS_URL: address,
  ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
});

// The values start in column 21 after the indent: the longest label,
// «ChurchTools-Adresse», and two spaces.
const row = (label: string, rest: string): string =>
  `  ${label.padEnd(21)}${rest}`;

const valid =
  'Die Konfiguration ist gültig. ChurchTools wurde nicht angefragt. Ob das Token gilt, zeigt erst der Start.';
const invalid =
  'Mit dieser Konfiguration startet Ecclium nicht. ChurchTools wurde nicht angefragt. Beheben Sie die Probleme und prüfen Sie dann erneut mit ‹ecclium config check›.';
const hostNote =
  'Verborgen ist der Host, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl ihn.';

describe('renderConfigReport', () => {
  it('lists every setting once, in a fixed order, with its origin', () => {
    expect(render(minimal())).toEqual([
      'Prüfung der Konfiguration für den Betrieb über stdio',
      row(
        'ChurchTools-Adresse',
        'https://[verborgen] (aus ‹ECCLIUM_CHURCHTOOLS_URL›)',
      ),
      row(
        'Token',
        'verborgen (aus der Datei in ‹ECCLIUM_CHURCHTOOLS_TOKEN_FILE›, Eigentümer und Dateirechte geprüft)',
      ),
      row('Anfragen je Minute', '300 (Voreinstellung)'),
      row('Nur lesen', 'ja (Voreinstellung)'),
      row('Maskierung', '‹standard› (Voreinstellung)'),
      row('Suchtools', 'nein (Voreinstellung)'),
      row('Subjekt über stdio', '‹local-stdio› (Voreinstellung)'),
      row('Stufe des Logs', '‹info› (Voreinstellung)'),
      hostNote,
      valid,
    ]);
  });

  it('shows the requests per minute from the environment, and never a refused one', () => {
    expect(
      render({ ...minimal(), ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: '120' }),
    ).toContain(
      row(
        'Anfragen je Minute',
        '120 (aus ‹ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE›)',
      ),
    );
    const lines = render({
      ...minimal(),
      ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE: '987',
    });
    expect(lines).toContain(
      row(
        'Anfragen je Minute',
        'ungültig (aus ‹ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE›, siehe die Probleme unten)',
      ),
    );
    expect(lines.join('\n')).not.toContain('987');
  });

  it('reports a value equal to the default as set', () => {
    const lines = render({
      ...minimal(),
      ECCLIUM_READ_ONLY: 'true',
      ECCLIUM_REDACTION: 'standard',
      ECCLIUM_STDIO_SUBJECT: 'local-stdio',
    });
    expect(lines).toContain(row('Nur lesen', 'ja (aus ‹ECCLIUM_READ_ONLY›)'));
    expect(lines).toContain(
      row('Maskierung', '‹standard› (aus ‹ECCLIUM_REDACTION›)'),
    );
    expect(lines).toContain(
      row('Subjekt über stdio', '‹local-stdio› (aus ‹ECCLIUM_STDIO_SUBJECT›)'),
    );
  });

  it('shows the values of the table as they are', () => {
    const lines = render({
      ...minimal(),
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_SEARCH_TOOLS: 'true',
      ECCLIUM_LOG_LEVEL: 'debug',
    });
    expect(lines).toContain(row('Nur lesen', 'nein (aus ‹ECCLIUM_READ_ONLY›)'));
    expect(lines).toContain(
      row('Suchtools', 'ja (aus ‹ECCLIUM_SEARCH_TOOLS›)'),
    );
    expect(lines).toContain(
      row('Stufe des Logs', '‹debug› (aus ‹ECCLIUM_LOG_LEVEL›)'),
    );
  });

  it('reports the token from the environment with its warning', () => {
    const token = makeCanary('token').value;
    const lines = render({
      ECCLIUM_CHURCHTOOLS_URL: address,
      [tokenVariableName]: token,
    });
    expect(lines).toContain(
      row('Token', 'verborgen (aus ‹ECCLIUM_CHURCHTOOLS_TOKEN›)'),
    );
    expect(lines.slice(-3)).toEqual([
      'Beim Start meldet Ecclium:',
      expect.stringMatching(
        /^ {2}- Das Token steht in der Variable ‹ECCLIUM_CHURCHTOOLS_TOKEN›\. /,
      ),
      valid,
    ]);
    expect(lines.join('\n')).not.toContain(token);
  });

  it('lists every notice of the start', () => {
    const lines = render({
      ...minimal(),
      ECCLIUM_REDACTION: 'off',
      ECCLIUM_SEARCH_TOOLS: 'true',
    });
    const start = lines.indexOf('Beim Start meldet Ecclium:');
    expect(lines.slice(start + 1, -1)).toEqual([
      expect.stringMatching(/^ {2}- Die Maskierung ist ausgeschaltet\. /),
      expect.stringMatching(/^ {2}- Die Suchtools /),
    ]);
  });

  it('gives the same lines for two hosts and names neither', () => {
    const one = `one-${makeCanary('token').cores[0] ?? ''}`.toLowerCase();
    const two = `two-${makeCanary('token').cores[0] ?? ''}`.toLowerCase();
    const first = render({
      ...minimal(),
      ECCLIUM_CHURCHTOOLS_URL: `https://${one}.example.org`,
    });
    const second = render({
      ...minimal(),
      ECCLIUM_CHURCHTOOLS_URL: `https://${two}.example.org`,
    });
    expect(first).toEqual(second);
    expect(first.join('\n')).not.toContain(one);
    expect(first).toContain(hostNote);
  });

  it('keeps a port other than 443 visible behind the masked host', () => {
    expect(
      render({ ...minimal(), ECCLIUM_CHURCHTOOLS_URL: `${address}:8443` }),
    ).toContain(
      row(
        'ChurchTools-Adresse',
        'https://[verborgen]:8443 (aus ‹ECCLIUM_CHURCHTOOLS_URL›)',
      ),
    );
  });

  it('shows the checked origin and no note when asked to', () => {
    const lines = render(
      { ...minimal(), ECCLIUM_CHURCHTOOLS_URL: `${address}/` },
      true,
    );
    expect(lines).toContain(
      row(
        'ChurchTools-Adresse',
        'https://example.church.tools (aus ‹ECCLIUM_CHURCHTOOLS_URL›)',
      ),
    );
    expect(lines.join('\n')).not.toContain('Verborgen');
  });

  it('masks a subject other than the default unless asked to show it', () => {
    const environment = { ...minimal(), ECCLIUM_STDIO_SUBJECT: 'team-a' };
    const masked = render(environment);
    expect(masked).toContain(
      row('Subjekt über stdio', '[verborgen] (aus ‹ECCLIUM_STDIO_SUBJECT›)'),
    );
    expect(masked).toContain(
      'Verborgen sind der Host und das Subjekt, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.',
    );
    expect(masked.join('\n')).not.toContain('team-a');
    const shown = render(environment, true);
    expect(shown).toContain(
      row('Subjekt über stdio', '‹team-a› (aus ‹ECCLIUM_STDIO_SUBJECT›)'),
    );
  });

  it('names the subject alone when only the subject is masked', () => {
    const result = load({ ...minimal(), ECCLIUM_STDIO_SUBJECT: 'team-a' });
    const report: ConfigReport = {
      ...result.report,
      settings: result.report.settings.filter(
        (setting) => setting.key !== 'churchtoolsOrigin',
      ),
    };
    expect(
      renderConfigReport(report, { valid: false, showValues: false }),
    ).toContain(
      'Verborgen ist das Subjekt, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl es.',
    );
  });

  it('shows what is missing or invalid, all problems and no value', () => {
    const lines = render({
      ECCLIUM_CHURCHTOOLS_TOKEN_FILE: tokenPath,
      ECCLIUM_READ_ONLY: 'yes',
      ECCLIUM_REDONLY: 'true',
    });
    expect(lines).toContain(
      row(
        'ChurchTools-Adresse',
        'fehlt (‹ECCLIUM_CHURCHTOOLS_URL› ist nicht gesetzt)',
      ),
    );
    expect(lines).toContain(
      row(
        'Nur lesen',
        'ungültig (aus ‹ECCLIUM_READ_ONLY›, siehe die Probleme unten)',
      ),
    );
    const start = lines.indexOf('Die Konfiguration hat 3 Probleme:');
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 1)).toEqual([
      expect.stringMatching(/^ {2}- .*‹ECCLIUM_CHURCHTOOLS_URL›/),
      expect.stringMatching(/^ {2}- .*‹ECCLIUM_READ_ONLY›/),
      expect.stringMatching(/^ {2}- .*‹ECCLIUM_REDONLY›/),
      invalid,
    ]);
    expect(lines.join('\n')).not.toMatch(/yes|gültig\. /);
  });

  it('reports a missing token under the variable of the file', () => {
    expect(render({ ECCLIUM_CHURCHTOOLS_URL: address })).toContain(
      row(
        'Token',
        'fehlt (‹ECCLIUM_CHURCHTOOLS_TOKEN_FILE› ist nicht gesetzt)',
      ),
    );
  });

  it('says 1 Problem for one problem', () => {
    expect(render({ ECCLIUM_CHURCHTOOLS_URL: address })).toContain(
      'Die Konfiguration hat 1 Problem:',
    );
  });

  it.each([
    [maxReportedProblems + 1, '33 Probleme:', '  und 1 weiteres'],
    [40, '40 Probleme:', '  und 8 weitere'],
    [1033, "1'033 Probleme:", "  und 1'001 weitere"],
  ])('counts %i problems and names the first ones', (count, heading, rest) => {
    const environment = minimal();
    for (let index = 0; index < count; index += 1) {
      environment[`ECCLIUM_UNKNOWN_${String(index).padStart(4, '0')}`] = 'x';
    }
    const lines = render(environment);
    const start = lines.indexOf(`Die Konfiguration hat ${heading}`);
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 1, -2)).toHaveLength(maxReportedProblems);
    expect(lines.at(-2)).toBe(rest);
    expect(lines.at(-1)).toBe(invalid);
  });

  it('never holds the token or the placeholder of a secret', () => {
    const { files, token } = goodFile();
    const result = loadConfig({
      environment: minimal(),
      transport: 'stdio',
      tokenFiles: files,
    });
    const text = renderConfigReport(result.report, {
      valid: result.ok,
      showValues: true,
    }).join('\n');
    expect(result.ok).toBe(true);
    expect(text).not.toContain(token);
    expect(text).not.toContain('REDACTED');
    expect(text).not.toContain(tokenPath);
  });

  it('gives frozen lines', () => {
    expect(Object.isFrozen(render(minimal()))).toBe(true);
  });

  const broken = (change: (setting: SettingReport) => SettingReport) => {
    const report = load(minimal()).report;
    return {
      ...report,
      settings: report.settings.map((setting, index) =>
        index === 2 ? change(setting) : setting,
      ),
    } as ConfigReport;
  };

  it.each([
    [
      'an unknown setting',
      broken((setting) => ({ ...setting, key: 'toString' as 'readOnly' })),
    ],
    [
      'an unknown variable',
      broken((setting) => ({
        ...setting,
        variable: 'ECCLIUM_OTHER' as 'ECCLIUM_READ_ONLY',
      })),
    ],
    [
      'a value that shows nothing',
      broken((setting) => ({ ...setting, shown: { kind: 'none' } })),
    ],
    [
      'an unknown transport',
      {
        ...load(minimal()).report,
        transport: 'carrier',
      } as unknown as ConfigReport,
    ],
  ])('refuses a report with %s', (_, report) => {
    expect(() =>
      renderConfigReport(report, { valid: true, showValues: false }),
    ).toThrow(
      new TypeError('The report of the configuration is inconsistent.'),
    );
  });
});
