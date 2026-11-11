import {
  type ConfigReport,
  type ConfigResult,
  defaultPolicy,
  loadConfig,
  maxReportedProblems,
  type Policy,
  policyHashOf,
  type SettingReport,
  type StateDirFileSystem,
  type TokenFileSystem,
  tokenVariableName,
} from '@ecclium/mcp-churchtools-core';
import { makeCanary } from '@ecclium/mcp-churchtools-testkit';
import { describe, expect, it } from 'vitest';

import { warningText } from '../messages/index.js';
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

/** A folder of state in memory, of the user with 0700, or with 0755. */
const folder = (mode = 0o40700): StateDirFileSystem => ({
  lstatSync: (path) => {
    if (path.endsWith('/audit')) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return {
      isDirectory: () => true,
      isSymbolicLink: () => false,
      uid: 1000,
      mode,
    };
  },
  getuid: () => 1000,
  constants: { O_NOFOLLOW: 1, O_DIRECTORY: 2, O_NOCTTY: 4 },
});

const load = (environment: Environment, folders = folder()): ConfigResult =>
  loadConfig({
    environment,
    transport: 'stdio',
    tokenFiles: goodFile().files,
    stateDirFiles: folders,
  });

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
  'Die Konfiguration ist gültig. ChurchTools wurde nicht angefragt. Ob ChurchTools das Token annimmt, zeigt erst ein Aufruf von ‹ct_whoami›.';
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
      row(
        'Pseudonym-Schlüssel',
        'kein Schlüssel (‹ECCLIUM_PSEUDONYM_KEY_FILE› ist nicht gesetzt)',
      ),
      row(
        'Früherer Schlüssel',
        'kein Wechsel (‹ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE› ist nicht gesetzt)',
      ),
      row('Toolsets', 'keine (Voreinstellung)'),
      row(
        'Zustandsordner',
        'keine Audit-Datei (‹ECCLIUM_STATE_DIR› ist nicht gesetzt)',
      ),
      row(
        'Schlüsselordner',
        'keine Tagesschlüssel (‹ECCLIUM_KEYS_DIR› ist nicht gesetzt)',
      ),
      row('Snapshots', '‹on› (Voreinstellung)'),
      row('Bestätigung', '‹echo-allowed› (Voreinstellung)'),
      row('Zeitzone der Texte', 'UTC (‹ECCLIUM_TIME_ZONE› ist nicht gesetzt)'),
      row('Frist in Monaten', '12 (Voreinstellung)'),
      row('Richtlinie', 'keine Datei (Voreinstellung)'),
      row(
        'Prüfcode-Schlüssel',
        'kein Schlüssel (‹ECCLIUM_MARKER_KEY_FILE› ist nicht gesetzt)',
      ),
      row(
        'Ordner der Routinen',
        'keine Routinen (‹ECCLIUM_ROUTINES_DIR› ist nicht gesetzt)',
      ),
      row(
        'Modellanbieter',
        'keine Anbieter (‹ECCLIUM_PROVIDERS_FILE› ist nicht gesetzt)',
      ),
      row(
        'Token des Runners',
        'kein Ordner (‹ECCLIUM_RUNNER_TOKENS_DIR› ist nicht gesetzt)',
      ),
      row(
        'Ordner der Entwürfe',
        'keine Entwürfe als Datei (‹ECCLIUM_DRAFTS_DIR› ist nicht gesetzt)',
      ),
      row(
        'Datei der Meldungen',
        'keine Meldungen als Datei (‹ECCLIUM_NOTIFY_FILE› ist nicht gesetzt)',
      ),
      row(
        'Metrikdatei',
        'keine Metrikdatei (‹ECCLIUM_RUNNER_METRICS_FILE› ist nicht gesetzt)',
      ),
      row('Subjekt über stdio', '‹local-stdio› (Voreinstellung)'),
      row('Stufe des Logs', '‹info› (Voreinstellung)'),
      hostNote,
      valid,
    ]);
  });

  it('masks the folder of state unless asked to show it', () => {
    const environment = {
      ...minimal(),
      ECCLIUM_STATE_DIR: '/path/to/state',
    };
    const masked = render(environment);
    expect(masked).toContain(
      row('Zustandsordner', '[verborgen] (aus ‹ECCLIUM_STATE_DIR›)'),
    );
    expect(masked).toContain(
      'Verborgen sind der Host und der Zustandsordner, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.',
    );
    expect(masked.join('\n')).not.toContain('/path/to/state');
    expect(render(environment, true)).toContain(
      row('Zustandsordner', '‹/path/to/state› (aus ‹ECCLIUM_STATE_DIR›)'),
    );
  });

  // The folder of the day keys can hold the name of a user as well
  // (ADR 0031).
  it('masks the folder of keys unless asked to show it, and names it in the note', () => {
    const environment = {
      ...minimal(),
      ECCLIUM_STATE_DIR: '/path/to/state',
      ECCLIUM_KEYS_DIR: '/path/to/keys',
    };
    const masked = render(environment);
    expect(masked).toContain(
      row('Schlüsselordner', '[verborgen] (aus ‹ECCLIUM_KEYS_DIR›)'),
    );
    expect(masked).toContain(
      'Verborgen sind der Host, der Zustandsordner und der Schlüsselordner, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl alle.',
    );
    expect(masked.join('\n')).not.toContain('/path/to/keys');
    expect(render(environment, true)).toContain(
      row('Schlüsselordner', '‹/path/to/keys› (aus ‹ECCLIUM_KEYS_DIR›)'),
    );
  });

  it('names the folder of keys alone when only it is masked', () => {
    const result = load({ ...minimal(), ECCLIUM_KEYS_DIR: '/path/to/keys' });
    const report: ConfigReport = {
      ...result.report,
      settings: result.report.settings.filter(
        (setting) => setting.key !== 'churchtoolsOrigin',
      ),
    };
    expect(
      renderConfigReport(report, { valid: true, showValues: false }),
    ).toContain(
      'Verborgen ist der Schlüsselordner, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl ihn.',
    );
  });

  it('shows the folder of keys as missing when the server writes without it', () => {
    const lines = render({
      ...minimal(),
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_STATE_DIR: '/path/to/state',
    });
    expect(lines).toContain(
      row('Schlüsselordner', 'fehlt (‹ECCLIUM_KEYS_DIR› ist nicht gesetzt)'),
    );
    expect(lines).toContain('Die Konfiguration hat 1 Problem:');
    expect(lines.at(-1)).toBe(invalid);
  });

  it('names host, subject and folder of state when all three are masked', () => {
    expect(
      render({
        ...minimal(),
        ECCLIUM_STDIO_SUBJECT: 'team-a',
        ECCLIUM_STATE_DIR: '/path/to/state',
      }),
    ).toContain(
      'Verborgen sind der Host, das Subjekt und der Zustandsordner, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl alle.',
    );
  });

  it('names the folder of state alone when only it is masked', () => {
    const result = load({ ...minimal(), ECCLIUM_STATE_DIR: '/path/to/state' });
    const report: ConfigReport = {
      ...result.report,
      settings: result.report.settings.filter(
        (setting) => setting.key !== 'churchtoolsOrigin',
      ),
    };
    expect(
      renderConfigReport(report, { valid: true, showValues: false }),
    ).toContain(
      'Verborgen ist der Zustandsordner, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl ihn.',
    );
  });

  it('says only «gesetzt» for a folder of state outside printable ASCII', () => {
    const lines = render(
      { ...minimal(), ECCLIUM_STATE_DIR: '/pfad/zum/ordner-ä' },
      true,
    );
    expect(lines).toContain(
      row('Zustandsordner', 'gesetzt (aus ‹ECCLIUM_STATE_DIR›)'),
    );
    expect(lines.join('\n')).not.toContain('ordner-');
  });

  it('shows a refused folder of state as invalid, with its problem', () => {
    const lines = renderConfigReport(
      load(
        { ...minimal(), ECCLIUM_STATE_DIR: '/path/to/state' },
        folder(0o40755),
      ).report,
      { valid: false, showValues: true },
    );
    expect(lines).toContain(
      row(
        'Zustandsordner',
        'ungültig (aus ‹ECCLIUM_STATE_DIR›, siehe die Probleme unten)',
      ),
    );
    expect(lines.join('\n')).toContain('«chmod 700»');
    expect(lines.join('\n')).not.toContain('/path/to/state');
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
      ECCLIUM_STATE_DIR: '/path/to/state',
      ECCLIUM_KEYS_DIR: '/path/to/keys',
      ECCLIUM_TOOLSETS: 'songs,calendars',
      ECCLIUM_LOG_LEVEL: 'debug',
    });
    expect(lines.at(-1)).toBe(valid);
    expect(lines).toContain(row('Nur lesen', 'nein (aus ‹ECCLIUM_READ_ONLY›)'));
    expect(lines).toContain(
      row('Toolsets', '‹calendars›, ‹songs› (aus ‹ECCLIUM_TOOLSETS›)'),
    );
    expect(lines).toContain(
      row('Stufe des Logs', '‹debug› (aus ‹ECCLIUM_LOG_LEVEL›)'),
    );
  });

  // Turned off, no write can be taken back, which the notices of the start
  // say (ADR 0031).
  it('shows snapshots that are off, with the warning of the start', () => {
    const lines = render({
      ...minimal(),
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_STATE_DIR: '/path/to/state',
      ECCLIUM_KEYS_DIR: '/path/to/keys',
      ECCLIUM_SNAPSHOTS: 'off',
    });
    expect(lines).toContain(
      row('Snapshots', '‹off› (aus ‹ECCLIUM_SNAPSHOTS›)'),
    );
    expect(lines.slice(-4)).toEqual([
      'Beim Start meldet Ecclium:',
      `  - ${warningText('writes_enabled')}`,
      `  - ${warningText('snapshots_off')}`,
      valid,
    ]);
  });

  // Over HTTP the default never takes the echo, and the echo set on
  // purpose comes with the warning of the start (ADR 0029).
  it('shows the confirmation over http, with the warning for the echo', () => {
    const overHttp = (environment: Environment) => {
      const result = loadConfig({
        environment,
        transport: 'http',
        tokenFiles: goodFile().files,
      });
      return renderConfigReport(result.report, {
        valid: result.ok,
        showValues: false,
      });
    };
    const byDefault = overHttp(minimal());
    expect(byDefault[0]).toBe(
      'Prüfung der Konfiguration für den Betrieb über HTTP',
    );
    expect(byDefault).toContain(
      row('Bestätigung', '‹elicitation-or-queue› (Voreinstellung)'),
    );
    expect(byDefault).not.toContain('Beim Start meldet Ecclium:');
    expect(byDefault.at(-1)).toBe(valid);
    const echo = overHttp({
      ...minimal(),
      ECCLIUM_WRITE_CONFIRMATION: 'echo-allowed',
    });
    expect(echo).toContain(
      row('Bestätigung', '‹echo-allowed› (aus ‹ECCLIUM_WRITE_CONFIRMATION›)'),
    );
    expect(echo.slice(-3)).toEqual([
      'Beim Start meldet Ecclium:',
      `  - ${warningText('echo_over_http')}`,
      valid,
    ]);
  });

  // The runner has a heading of its own and names each setting it needs
  // and lacks, its own account among them (ADR 0033, ADR 0034).
  it('renders the report of the runner with its heading and what it lacks', () => {
    const result = loadConfig({
      environment: { ECCLIUM_CHURCHTOOLS_URL: address },
      transport: 'runner',
      tokenFiles: goodFile().files,
      stateDirFiles: folder(),
    });
    const lines = renderConfigReport(result.report, {
      valid: result.ok,
      showValues: false,
    });
    expect(lines[0]).toBe(
      'Prüfung der Konfiguration für den Betrieb des Runners',
    );
    expect(lines).toContain(
      row('Zustandsordner', 'fehlt (‹ECCLIUM_STATE_DIR› ist nicht gesetzt)'),
    );
    expect(lines).toContain(
      row('Token', 'fehlt (‹ECCLIUM_RUNNER_TOKENS_DIR› ist nicht gesetzt)'),
    );
    expect(lines).toContain('Die Konfiguration hat 5 Probleme:');
    expect(lines.at(-1)).toBe(invalid);
  });

  // A zone names no person and no instance, so it is shown without
  // --show-values; a refused one is never shown.
  it('shows the zone of the texts, and never a refused one', () => {
    expect(
      render({ ...minimal(), ECCLIUM_TIME_ZONE: 'Europe/Zurich' }),
    ).toContain(
      row('Zeitzone der Texte', '‹Europe/Zurich› (aus ‹ECCLIUM_TIME_ZONE›)'),
    );
    const refused = render({ ...minimal(), ECCLIUM_TIME_ZONE: 'Mars/Base' });
    expect(refused).toContain(
      row(
        'Zeitzone der Texte',
        'ungültig (aus ‹ECCLIUM_TIME_ZONE›, siehe die Probleme unten)',
      ),
    );
    expect(refused.join('\n')).not.toContain('Mars/Base');
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
      ECCLIUM_TOOLSETS: 'persons',
    });
    const start = lines.indexOf('Beim Start meldet Ecclium:');
    expect(lines.slice(start + 1, -1)).toEqual([
      expect.stringMatching(/^ {2}- Die Maskierung ist ausgeschaltet\. /),
      expect.stringMatching(
        /^ {2}- Das Toolset ‹persons› ist eingeschaltet\. /,
      ),
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

  it('shows a key file for pseudonyms as hidden, with its variable', () => {
    const report = load(minimal()).report;
    const lines = renderConfigReport(
      {
        ...report,
        settings: report.settings.map((setting) =>
          setting.key === 'pseudonymKey' ||
          setting.key === 'pseudonymKeyPrevious'
            ? { ...setting, origin: 'file', shown: { kind: 'hidden' } }
            : setting,
        ),
      },
      { valid: true, showValues: true },
    );
    expect(lines).toContain(
      row(
        'Pseudonym-Schlüssel',
        'verborgen (aus der Datei in ‹ECCLIUM_PSEUDONYM_KEY_FILE›, Eigentümer und Dateirechte geprüft)',
      ),
    );
    expect(lines).toContain(
      row(
        'Früherer Schlüssel',
        'verborgen (aus der Datei in ‹ECCLIUM_PSEUDONYM_KEY_PREVIOUS_FILE›, Eigentümer und Dateirechte geprüft)',
      ),
    );
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
      'a setting other than the folder of state that is unset',
      broken((setting) => ({ ...setting, origin: 'unset' })),
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

describe('renderConfigReport and the policy', () => {
  const report = load(minimal()).report;
  const summary = (policy: Policy): readonly string[] =>
    renderConfigReport(report, { valid: true, showValues: false, policy });
  const entry = {
    target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
    tools: ['ct_wiki_page_create'],
    maxPerDay: 4,
  } as const;
  const routine = {
    routine: 'dienstplan-report',
    credential: 'bericht',
    modelRedaction: 'strict',
    target: entry.target,
    tools: ['ct_wiki_page_append_section'],
    maxPerRun: 2,
    maxPerDay: 4,
  } as const;
  const withBudget = (
    readBudgetPerDay: number,
    targets: Policy['interactive']['targets'] = [entry],
  ): Policy => ({
    ...defaultPolicy,
    interactive: { readBudgetPerDay, targets },
  });

  it('summarises the default policy with its hash and the finding of an empty interactive part', () => {
    const lines = summary(defaultPolicy);
    const start = lines.indexOf(
      `Richtlinie im Format ‹policy.v1›, Hash ${policyHashOf(defaultPolicy)}:`,
    );
    expect(start).toBe(lines.indexOf(hostNote) + 1);
    expect(lines.slice(start + 1)).toEqual([
      row('Interaktiv', 'keine Einträge'),
      row('Für Routinen', 'keine Einträge, sie gelten erst mit dem Runner'),
      row('Lesebudget', '200 Aufrufe je Akteur und UTC-Tag'),
      '  Befund: Der interaktive Teil hat keine Einträge. Bestätigte Schreibvorgänge dürfen dann auf jedes Ziel, das das Dienstkonto schreiben darf, ausser bei Gruppen und Diensten. Empfohlen sind Einträge für die Ziele, auf die Ecclium schreiben soll.',
      valid,
    ]);
  });

  it('counts the entries of both parts and names no target', () => {
    const lines = summary({
      ...withBudget(150),
      unattended: [routine, { ...routine, routine: 'wiki-hygiene' }],
    });
    expect(lines).toContain(row('Interaktiv', '1 Eintrag'));
    expect(lines).toContain(
      row('Für Routinen', '2 Einträge, sie gelten erst mit dem Runner'),
    );
    expect(lines).toContain(
      row('Lesebudget', '150 Aufrufe je Akteur und UTC-Tag'),
    );
    expect(lines.filter((line) => line.includes('Befund'))).toEqual([]);
    expect(lines.join('\n')).not.toMatch(/Berichte|dienstplan|wiki-hygiene/u);
    expect(summary(withBudget(200, [entry, entry, entry]))).toContain(
      row('Interaktiv', '3 Einträge'),
    );
  });

  it('reports a read budget of 0 and one above the default as findings', () => {
    expect(summary(withBudget(0))).toContain(
      '  Befund: Das Lesebudget ist 0. Tools mit besonders schützenswerten Daten und Tools, die Personen nennen, laufen dann nicht.',
    );
    expect(summary(withBudget(1000))).toContain(
      '  Befund: Das Lesebudget liegt über der Voreinstellung von 200 Aufrufen. Der KI-Assistent kann dann mehr Personendaten lesen, bevor die Grenze greift.',
    );
    expect(summary(withBudget(1000))).toContain(
      row('Lesebudget', "1'000 Aufrufe je Akteur und UTC-Tag"),
    );
  });

  it('masks the path of the file of the policy unless asked to show it', () => {
    const withFile: ConfigReport = {
      ...report,
      settings: report.settings.map((setting) =>
        setting.key === 'policy'
          ? {
              ...setting,
              origin: 'file',
              shown: { kind: 'path', value: '/path/to/policy.yaml' },
            }
          : setting,
      ),
    };
    const masked = renderConfigReport(withFile, {
      valid: true,
      showValues: false,
    });
    expect(masked).toContain(
      row(
        'Richtlinie',
        '[verborgen] (aus der Datei in ‹ECCLIUM_POLICY_FILE›, Eigentümer und Dateirechte geprüft)',
      ),
    );
    expect(masked).toContain(
      'Verborgen sind der Host und der Pfad der Richtlinie, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.',
    );
    expect(
      renderConfigReport(withFile, { valid: true, showValues: true }),
    ).toContain(
      row(
        'Richtlinie',
        '‹/path/to/policy.yaml› (aus der Datei in ‹ECCLIUM_POLICY_FILE›, Eigentümer und Dateirechte geprüft)',
      ),
    );
  });

  it('masks the folder of the routines unless asked to show it', () => {
    const withFolder: ConfigReport = {
      ...report,
      settings: report.settings.map((setting) =>
        setting.key === 'routinesDir'
          ? {
              ...setting,
              origin: 'environment',
              shown: { kind: 'path', value: '/path/to/routines' },
            }
          : setting,
      ),
    };
    const masked = renderConfigReport(withFolder, {
      valid: true,
      showValues: false,
    });
    expect(masked).toContain(
      row('Ordner der Routinen', '[verborgen] (aus ‹ECCLIUM_ROUTINES_DIR›)'),
    );
    expect(masked.find((line) => line.startsWith('Verborgen'))).toBe(
      'Verborgen sind der Host und der Ordner der Routinen, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.',
    );
    expect(
      renderConfigReport(withFolder, { valid: true, showValues: true }),
    ).toContain(
      row(
        'Ordner der Routinen',
        '‹/path/to/routines› (aus ‹ECCLIUM_ROUTINES_DIR›)',
      ),
    );
  });
  it('masks the folder of the tokens of the runner unless asked to show it', () => {
    const withFolder: ConfigReport = {
      ...report,
      settings: report.settings.map((setting) =>
        setting.key === 'runnerTokensDir'
          ? {
              ...setting,
              origin: 'environment',
              shown: { kind: 'path', value: '/path/to/tokens' },
            }
          : setting,
      ),
    };
    const masked = renderConfigReport(withFolder, {
      valid: true,
      showValues: false,
    });
    expect(masked).toContain(
      row('Token des Runners', '[verborgen] (aus ‹ECCLIUM_RUNNER_TOKENS_DIR›)'),
    );
    expect(masked.find((line) => line.startsWith('Verborgen'))).toBe(
      'Verborgen sind der Host und der Ordner der Token des Runners, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.',
    );
    expect(
      renderConfigReport(withFolder, { valid: true, showValues: true }),
    ).toContain(
      row(
        'Token des Runners',
        '‹/path/to/tokens› (aus ‹ECCLIUM_RUNNER_TOKENS_DIR›)',
      ),
    );
  });

  // These paths can hold the name of a user, like the other paths (ADR 0033).
  it.each([
    [
      'draftsDir',
      'ECCLIUM_DRAFTS_DIR',
      'Ordner der Entwürfe',
      '/path/to/drafts',
      'der Ordner der Entwürfe',
    ],
    [
      'notifyFile',
      'ECCLIUM_NOTIFY_FILE',
      'Datei der Meldungen',
      '/path/to/notify.jsonl',
      'der Pfad der Datei der Meldungen',
    ],
    [
      'metricsFile',
      'ECCLIUM_RUNNER_METRICS_FILE',
      'Metrikdatei',
      '/path/to/metrics/runner.prom',
      'der Pfad der Metrikdatei',
    ],
  ] as const)(
    'masks %s unless asked to show it',
    (key, variable, label, path, hidden) => {
      const withPath: ConfigReport = {
        ...report,
        settings: report.settings.map((setting) =>
          setting.key === key
            ? {
                ...setting,
                origin: 'environment',
                shown: { kind: 'path', value: path },
              }
            : setting,
        ),
      };
      const masked = renderConfigReport(withPath, {
        valid: true,
        showValues: false,
      });
      expect(masked).toContain(row(label, `[verborgen] (aus ‹${variable}›)`));
      expect(masked.find((line) => line.startsWith('Verborgen'))).toBe(
        `Verborgen sind der Host und ${hidden}, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.`,
      );
      expect(masked.join('\n')).not.toContain(path);
      expect(
        renderConfigReport(withPath, { valid: true, showValues: true }),
      ).toContain(row(label, `‹${path}› (aus ‹${variable}›)`));
    },
  );

  it('masks the path of the file of the providers and lists each provider, the host only on request', () => {
    const withFile: ConfigReport = {
      ...report,
      settings: report.settings.map((setting) =>
        setting.key === 'providers'
          ? {
              ...setting,
              origin: 'file',
              shown: { kind: 'path', value: '/path/to/providers.yaml' },
            }
          : setting,
      ),
    };
    const providers = [
      {
        alias: 'default',
        info: {
          vendor: 'example',
          model: 'example-maker/example-model-1',
          hostingCountry: 'CH',
          endpointHost: 'model.example.org',
        },
        endpoint: 'https://model.example.org/v1/chat/completions',
        structuredOutput: true,
        apiKeyFile: '/path/to/model-key',
      },
      {
        alias: 'extern',
        info: {
          vendor: 'example',
          model: 'example-model-2',
          hostingCountry: 'US',
          endpointHost: 'model.example.com',
          transferBasis: 'standard_contractual_clauses',
        },
        endpoint: 'https://model.example.com/v1/chat/completions',
        structuredOutput: false,
        apiKeyFile: '/path/to/other-key',
      },
    ];
    const masked = renderConfigReport(withFile, {
      valid: true,
      showValues: false,
      providers,
    });
    expect(masked).toContain(
      row(
        'Modellanbieter',
        '[verborgen] (aus der Datei in ‹ECCLIUM_PROVIDERS_FILE›, Eigentümer und Dateirechte geprüft)',
      ),
    );
    expect(masked.find((line) => line.startsWith('Verborgen'))).toBe(
      'Verborgen sind der Host und der Pfad der Datei der Anbieter, damit Sie die Ausgabe ohne Bearbeitung weitergeben können. Mit ‹--show-values› zeigt der Befehl beide.',
    );
    expect(masked).toContain(
      'Anbieter von Sprachmodellen im Format ‹providers.v1›:',
    );
    expect(masked).toContain(
      row(
        'default',
        'example, Modell ‹example-maker/example-model-1›, Land CH',
      ),
    );
    expect(masked).toContain(
      row(
        'extern',
        'example, Modell ‹example-model-2›, Land US, Grundlage ‹standard_contractual_clauses›',
      ),
    );
    expect(masked.join('\n')).not.toContain('model.example');
    expect(masked.join('\n')).not.toContain('/path/to/model-key');
    const shown = renderConfigReport(withFile, {
      valid: true,
      showValues: true,
      providers,
    });
    expect(shown).toContain(
      row(
        'default',
        'example, Modell ‹example-maker/example-model-1›, Land CH, Endpunkt ‹model.example.org›',
      ),
    );
    expect(shown.join('\n')).not.toContain('/path/to/model-key');
  });
});
