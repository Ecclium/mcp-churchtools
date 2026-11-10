import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkKillSwitches,
  checkRunKillSwitches,
  globalKillSwitch,
  type KillSwitchFileSystem,
  routineKillSwitchOf,
  tenantKillSwitchOf,
} from './kill-switch.js';
import { maxClockSkewMs, serverTimeFits } from './server-clock.js';

const tenant = 'demo-tenant';

describe('the kill switches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ecclium-stop-'));
  });

  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('let writing on while no switch is there', () => {
    expect(checkKillSwitches(dir, tenant)).toBe('on');
  });

  it('stop every write with writes-off, whatever it holds', () => {
    writeFileSync(join(dir, globalKillSwitch), '');
    expect(checkKillSwitches(dir, tenant)).toBe('off');
    expect(checkKillSwitches(dir, 'other-tenant')).toBe('off');
  });

  it('stop the writes of one tenant only with writes-off-<tenant>', () => {
    writeFileSync(join(dir, tenantKillSwitchOf(tenant)), 'egal');
    expect(tenantKillSwitchOf(tenant)).toBe('writes-off-demo-tenant');
    expect(checkKillSwitches(dir, tenant)).toBe('off');
    expect(checkKillSwitches(dir, 'other-tenant')).toBe('on');
  });

  it('count a switch that is a folder or a link that points nowhere', () => {
    mkdirSync(join(dir, globalKillSwitch));
    expect(checkKillSwitches(dir, tenant)).toBe('off');
    rmSync(join(dir, globalKillSwitch), { recursive: true });
    symlinkSync(join(dir, 'nowhere'), join(dir, tenantKillSwitchOf(tenant)));
    expect(checkKillSwitches(dir, tenant)).toBe('off');
  });

  it('stop writing when the folder is missing, a file or a link', () => {
    expect(checkKillSwitches(join(dir, 'missing'), tenant)).toBe('unknown');
    writeFileSync(join(dir, 'file'), '');
    expect(checkKillSwitches(join(dir, 'file'), tenant)).toBe('unknown');
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(checkKillSwitches(join(dir, 'link'), tenant)).toBe('unknown');
  });

  it('stop writing when the folder cannot be searched', () => {
    chmodSync(dir, 0o000);
    expect(checkKillSwitches(dir, tenant)).toBe('unknown');
  });

  it.each(['relative/stop', '/tmp/../stop', '/tmp/stop/', ''])(
    'stop writing for the folder %j, which is no clean absolute path',
    (value) => {
      expect(checkKillSwitches(value, tenant)).toBe('unknown');
    },
  );

  it.each(['../demo', 'Demo', '', 'a/b'])(
    'stop writing for the tenant %j, which cannot name a file',
    (value) => {
      expect(checkKillSwitches(dir, value)).toBe('unknown');
    },
  );

  it('stop writing on any failure but a missing file, without a getter running', () => {
    let read = false;
    const failing = (code: unknown): KillSwitchFileSystem => ({
      lstatSync: (path: string) => {
        if (path === dir)
          return { isDirectory: () => true, isSymbolicLink: () => false };
        const error = new Error('with a path');
        Object.defineProperty(error, 'code', { value: code });
        throw error;
      },
    });
    expect(checkKillSwitches(dir, tenant, failing('ENOENT'))).toBe('on');
    expect(checkKillSwitches(dir, tenant, failing('EACCES'))).toBe('unknown');
    expect(checkKillSwitches(dir, tenant, failing(undefined))).toBe('unknown');
    const withGetter: KillSwitchFileSystem = {
      lstatSync: (path: string) => {
        if (path === dir)
          return { isDirectory: () => true, isSymbolicLink: () => false };
        const error = new Error('with a path');
        Object.defineProperty(error, 'code', {
          get: () => {
            read = true;
            return 'ENOENT';
          },
        });
        throw error;
      },
    };
    expect(checkKillSwitches(dir, tenant, withGetter)).toBe('unknown');
    const throwsText: KillSwitchFileSystem = {
      lstatSync: (path: string) => {
        if (path === dir)
          return { isDirectory: () => true, isSymbolicLink: () => false };
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a file system that throws no error
        throw 'ENOENT';
      },
    };
    expect(checkKillSwitches(dir, tenant, throwsText)).toBe('unknown');
    const throwsProxy: KillSwitchFileSystem = {
      lstatSync: (path: string) => {
        if (path === dir)
          return { isDirectory: () => true, isSymbolicLink: () => false };
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a proxy, whose traps the check must not run
        throw new Proxy({ code: 'ENOENT' }, {});
      },
    };
    expect(checkKillSwitches(dir, tenant, throwsProxy)).toBe('unknown');
    expect(read).toBe(false);
  });

  // The third kind stops the runs of one routine (ADR 0029).
  const routine = 'dienstplan-report';

  it('stop the runs of one routine only with writes-off-routine-<routine>', () => {
    expect(routineKillSwitchOf(routine)).toBe(
      'writes-off-routine-dienstplan-report',
    );
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('on');
    writeFileSync(join(dir, routineKillSwitchOf(routine)), '');
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('off');
    expect(checkRunKillSwitches(dir, tenant, 'wiki-hygiene')).toBe('on');
    // A write outside a run has no routine, so the file does not stop it.
    expect(checkKillSwitches(dir, tenant)).toBe('on');
  });

  it('stop a run with the switch of every write and with the one of its tenant', () => {
    writeFileSync(join(dir, tenantKillSwitchOf(tenant)), '');
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('off');
    expect(checkRunKillSwitches(dir, 'other-tenant', routine)).toBe('on');
    rmSync(join(dir, tenantKillSwitchOf(tenant)));
    writeFileSync(join(dir, globalKillSwitch), '');
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('off');
    expect(checkRunKillSwitches(dir, 'other-tenant', 'wiki-hygiene')).toBe(
      'off',
    );
  });

  it('stop both a tenant routine-<id> and the routine <id> with one file, and open neither', () => {
    writeFileSync(join(dir, routineKillSwitchOf('wiki')), '');
    expect(tenantKillSwitchOf('routine-wiki')).toBe(
      routineKillSwitchOf('wiki'),
    );
    expect(checkKillSwitches(dir, 'routine-wiki')).toBe('off');
    expect(checkRunKillSwitches(dir, tenant, 'wiki')).toBe('off');
    expect(checkRunKillSwitches(dir, 'routine-wiki', routine)).toBe('off');
  });

  it('count a switch of a routine that is a folder or a link that points nowhere', () => {
    mkdirSync(join(dir, routineKillSwitchOf(routine)));
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('off');
    rmSync(join(dir, routineKillSwitchOf(routine)), { recursive: true });
    symlinkSync(join(dir, 'nowhere'), join(dir, routineKillSwitchOf(routine)));
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('off');
  });

  it.each([
    [
      'a folder that is no clean absolute path',
      'relative/stop',
      tenant,
      routine,
    ],
    ['a tenant that cannot name a file', undefined, '../demo', routine],
    ['a routine that cannot name a file', undefined, tenant, '../demo'],
    ['a routine in capitals', undefined, tenant, 'Dienstplan'],
    ['an empty routine', undefined, tenant, ''],
    ['a routine with a slash', undefined, tenant, 'a/b'],
  ])('stop a run for %s', (_name, folder, tenantId, routineId) => {
    expect(checkRunKillSwitches(folder ?? dir, tenantId, routineId)).toBe(
      'unknown',
    );
  });

  it('stop a run when the folder is missing or cannot be searched', () => {
    expect(checkRunKillSwitches(join(dir, 'missing'), tenant, routine)).toBe(
      'unknown',
    );
    chmodSync(dir, 0o000);
    expect(checkRunKillSwitches(dir, tenant, routine)).toBe('unknown');
  });

  it('look for the three files of a run, and stop it when one cannot be read', () => {
    const looked: string[] = [];
    const fsOf = (failing?: string): KillSwitchFileSystem => ({
      lstatSync: (path: string) => {
        if (path === dir)
          return { isDirectory: () => true, isSymbolicLink: () => false };
        looked.push(path);
        const error = new Error('with a path');
        Object.defineProperty(error, 'code', {
          value: path === failing ? 'EACCES' : 'ENOENT',
        });
        throw error;
      },
    });
    expect(checkRunKillSwitches(dir, tenant, routine, fsOf())).toBe('on');
    expect(looked).toEqual([
      join(dir, globalKillSwitch),
      join(dir, tenantKillSwitchOf(tenant)),
      join(dir, routineKillSwitchOf(routine)),
    ]);
    expect(
      checkRunKillSwitches(
        dir,
        tenant,
        routine,
        fsOf(join(dir, routineKillSwitchOf(routine))),
      ),
    ).toBe('unknown');
  });
});

describe('the clock before a write', () => {
  const now = Date.UTC(2026, 10, 1, 8, 0, 0);

  it('fits within five minutes either way', () => {
    expect(maxClockSkewMs).toBe(300_000);
    for (const delta of [0, 1_000, -1_000, maxClockSkewMs, -maxClockSkewMs]) {
      expect(serverTimeFits(now, now + delta)).toBe(true);
    }
  });

  it('does not fit beyond five minutes', () => {
    expect(serverTimeFits(now, now + maxClockSkewMs + 1)).toBe(false);
    expect(serverTimeFits(now, now - maxClockSkewMs - 1)).toBe(false);
  });

  it('does not fit without a time of ChurchTools or with a broken clock', () => {
    expect(serverTimeFits(now, null)).toBe(false);
    expect(serverTimeFits(Number.NaN, now)).toBe(false);
    expect(serverTimeFits(now, Number.NaN)).toBe(false);
    expect(
      serverTimeFits(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
    ).toBe(false);
  });
});
