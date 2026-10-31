import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadAuditConfig, maxReportedProblems } from './load.js';
import type { StateDirFileSystem } from './state-dir.js';
import {
  proxyVariableName,
  searchToolsVariableName,
  tokenVariableName,
} from './variables.js';

// The commands that read the audit files load only the folder of state and
// the retention (ADR 0028). Everything else of the start, the address, the
// token and the variables of Node.js, plays no part.

const base = mkdtempSync(join(tmpdir(), 'ecclium-audit-config-'));
const stateDir = join(base, 'state');
mkdirSync(stateDir, { mode: 0o700 });
chmodSync(stateDir, 0o700);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const load = (environment: Record<string, string | undefined>) =>
  loadAuditConfig({ environment });

describe('loadAuditConfig', () => {
  it('takes the folder of state and the retention with its default', () => {
    expect(load({ ECCLIUM_STATE_DIR: stateDir })).toEqual({
      ok: true,
      config: { stateDir, auditRetentionMonths: 12 },
    });
    const loaded = load({
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_AUDIT_RETENTION_MONTHS: '120',
    });
    expect(loaded).toEqual({
      ok: true,
      config: { stateDir, auditRetentionMonths: 120 },
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    if (loaded.ok) expect(Object.isFrozen(loaded.config)).toBe(true);
  });

  it('needs neither address nor token and never reads other values', () => {
    expect(
      load({
        ECCLIUM_STATE_DIR: stateDir,
        ECCLIUM_CHURCHTOOLS_URL: 'not an address',
        ECCLIUM_CHURCHTOOLS_TOKEN_FILE: join(base, 'no-such-token'),
        [tokenVariableName]: '',
        ECCLIUM_READ_ONLY: 'perhaps',
        ECCLIUM_TOOLSETS: 'persons',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        NODE_OPTIONS: '--tls-keylog=/path/to/keys',
        HOME: '/path/to/home',
        ECCLIUM_LOG_LEVEL: undefined,
      }).ok,
    ).toBe(true);
  });

  it('needs the folder of state', () => {
    expect(load({})).toEqual({
      ok: false,
      problems: [{ code: 'state_dir_required', variable: 'ECCLIUM_STATE_DIR' }],
      omittedProblems: 0,
    });
  });

  it('checks the folder of state as the start does', () => {
    expect(load({ ECCLIUM_STATE_DIR: 'relative' })).toMatchObject({
      ok: false,
      problems: [{ code: 'state_dir_relative', variable: 'ECCLIUM_STATE_DIR' }],
    });
    expect(load({ ECCLIUM_STATE_DIR: join(base, 'missing') })).toMatchObject({
      ok: false,
      problems: [{ code: 'state_dir_missing', variable: 'ECCLIUM_STATE_DIR' }],
    });
    expect(load({ ECCLIUM_STATE_DIR: '' })).toMatchObject({
      ok: false,
      problems: [{ code: 'empty_value', variable: 'ECCLIUM_STATE_DIR' }],
    });
    expect(load({ ECCLIUM_STATE_DIR: `/${'a'.repeat(5000)}` })).toMatchObject({
      ok: false,
      problems: [{ code: 'value_too_long', variable: 'ECCLIUM_STATE_DIR' }],
    });
  });

  it('uses the file functions it gets for the folder of state', () => {
    const stateDirFiles: StateDirFileSystem = {
      lstatSync: () => ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 1,
        mode: 0o40700,
      }),
      getuid: () => 2,
      constants: { O_NOFOLLOW: 1, O_DIRECTORY: 2, O_NOCTTY: 4 },
    };

    expect(
      loadAuditConfig({
        environment: { ECCLIUM_STATE_DIR: '/path/to/state' },
        stateDirFiles,
      }),
    ).toMatchObject({
      ok: false,
      problems: [{ code: 'state_dir_owner', variable: 'ECCLIUM_STATE_DIR' }],
    });
  });

  it('refuses a retention outside 1 to 120 months', () => {
    for (const value of ['0', '121', '1.5', 'abc', ' 12']) {
      expect(
        load({
          ECCLIUM_STATE_DIR: stateDir,
          ECCLIUM_AUDIT_RETENTION_MONTHS: value,
        }),
      ).toEqual({
        ok: false,
        problems: [
          {
            code: 'invalid_retention',
            variable: 'ECCLIUM_AUDIT_RETENTION_MONTHS',
          },
        ],
        omittedProblems: 0,
      });
    }
  });

  it('refuses the names the start refuses, in its order', () => {
    const loaded = load({
      ECCLIUM_STATE_DIR: stateDir,
      ECCLIUM_STATE_DIRR: 'x',
      Ecclium_State_Dir: 'x',
      [proxyVariableName]: 'x',
      [searchToolsVariableName]: 'x',
      ECCLIUM_EGRESS: 'x',
      'ECCLIUM_odd-name': 'x',
    });

    expect(loaded).toEqual({
      ok: false,
      problems: [
        { code: 'miscased_variable', variable: 'ECCLIUM_STATE_DIR' },
        { code: 'proxy_unsupported', variable: proxyVariableName },
        { code: 'unsupported_variable', variable: 'ECCLIUM_EGRESS' },
        { code: 'search_tools_replaced', variable: searchToolsVariableName },
        { code: 'unknown_variable', variable: 'ECCLIUM_STATE_DIRR' },
        { code: 'unknown_variable' },
      ],
      omittedProblems: 0,
    });
  });

  it('lists the first problems and counts the others', () => {
    const environment: Record<string, string> = {};
    for (let index = 0; index < maxReportedProblems + 3; index += 1) {
      environment[`ECCLIUM_UNKNOWN_${String(index).padStart(2, '0')}`] = 'x';
    }

    const loaded = load(environment);

    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.problems).toHaveLength(maxReportedProblems);
    // The missing folder comes first, in the order of the table.
    expect(loaded.problems[0]).toEqual({
      code: 'state_dir_required',
      variable: 'ECCLIUM_STATE_DIR',
    });
    expect(loaded.omittedProblems).toBe(4);
  });

  it('throws for sources, an environment or values of another kind', () => {
    const getter = Object.defineProperty({}, 'ECCLIUM_STATE_DIR', {
      enumerable: true,
      get: () => stateDir,
    });
    for (const sources of [
      null,
      [],
      { environment: null },
      { environment: new Map() },
      { environment: {}, stateDirFiles: 'files' },
      { environment: { ECCLIUM_STATE_DIR: 42 } },
      { environment: getter },
      Object.defineProperty({}, 'environment', { get: () => ({}) }),
    ]) {
      expect(() =>
        loadAuditConfig(sources as Parameters<typeof loadAuditConfig>[0]),
      ).toThrow(TypeError);
    }
  });
});
