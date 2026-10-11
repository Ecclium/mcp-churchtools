import { describe as group, expect, it } from 'vitest';

import {
  blockedCode,
  describe,
  judge,
  type Observations,
  type Outcome,
} from '../../scripts/ci/check-network.mts';
import { blockedCode as guardCode } from '../support/no-network.mts';

// The probe of the network of the check jobs (ADR 0052). Its verdict is a
// pure function; these tests feed it observations and need no network.

const ok: Outcome = { result: 'ok', ms: 3 };
const failed = (code: string): Outcome => ({ result: 'failed', code, ms: 1 });
const timeout: Outcome = { result: 'timeout', ms: 5000 };

const online: Observations = {
  interfaces: ['eth0', 'lo'],
  loopback4: ok,
  loopback6: ok,
  lookup: ok,
  outbound: ok,
};

const offline: Observations = {
  interfaces: ['lo'],
  loopback4: ok,
  loopback6: ok,
  lookup: failed('EAI_AGAIN'),
  outbound: failed('ENETUNREACH'),
};

group('the network probe', () => {
  it('accepts a job that reaches the outside before the namespace', () => {
    expect(judge('online', online)).toEqual([]);
  });

  it('accepts a namespace with loopback only', () => {
    expect(judge('offline', offline)).toEqual([]);
  });

  it.each([
    [
      'another interface',
      { interfaces: ['eth0', 'lo'] },
      'andere Schnittstellen als lo',
    ],
    ['no interface at all', { interfaces: [] }, 'andere Schnittstellen als lo'],
    ['loopback over IPv4 down', { loopback4: failed('ECONNREFUSED') }, 'IPv4'],
    [
      'loopback over IPv6 missing',
      { loopback6: failed('EADDRNOTAVAIL') },
      'IPv6',
    ],
    ['a name that resolves', { lookup: ok }, 'Namensauflösung'],
    ['a connection that stands', { outbound: ok }, 'Verbindung nach aussen'],
    ['a name resolution that hangs', { lookup: timeout }, 'Namensauflösung'],
    [
      'a connection that hangs',
      { outbound: timeout },
      'Verbindung nach aussen',
    ],
    [
      'the guard of the tests',
      { outbound: failed(blockedCode) },
      'Sperre der Tests',
    ],
  ])('refuses a namespace with %s', (_name, change, problem) => {
    const problems = judge('offline', { ...offline, ...change });
    expect(problems.join(' | ')).toContain(problem);
  });

  it.each([
    ['only loopback', { interfaces: ['lo'] }, 'keine Schnittstelle ausser lo'],
    ['no name resolution', { lookup: failed('EAI_AGAIN') }, 'Namensauflösung'],
    [
      'no connection out',
      { outbound: timeout },
      'keine Verbindung nach aussen',
    ],
    [
      'the guard of the tests',
      { lookup: failed(blockedCode) },
      'Sperre der Tests',
    ],
  ])('refuses a job before the namespace with %s', (_name, change, problem) => {
    const problems = judge('online', { ...online, ...change });
    expect(problems.join(' | ')).toContain(problem);
  });

  it('knows the error code of the guard of the tests', () => {
    expect(blockedCode).toBe(guardCode);
  });

  it('prints one line with the verdict and every outcome, without addresses', () => {
    const line = describe('offline', offline, []);
    expect(line).toBe(
      'Netzprobe offline: in Ordnung; Schnittstellen lo; Loopback IPv4 ok, 3 ms; ' +
        'Loopback IPv6 ok, 3 ms; Namensauflösung gescheitert EAI_AGAIN, 1 ms; ' +
        'Verbindung nach aussen gescheitert ENETUNREACH, 1 ms',
    );
    expect(describe('online', { ...online, interfaces: [] }, ['x'])).toContain(
      'Fehler: x; Schnittstellen keine',
    );
  });
});
