import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SpikeError, hints } from '../../scripts/spike/lib/errors.mts';
import { Guard } from '../../scripts/spike/lib/guard.mts';
import {
  exitCodes,
  integrityLines,
  writeError,
  writeResult,
} from '../../scripts/spike/lib/output.mts';
import {
  runProbe,
  type ProbeDefinition,
} from '../../scripts/spike/lib/probe.mts';
import type { FetchFunction } from '../../scripts/spike/lib/http.mts';
import {
  capture,
  forbiddenTexts,
  leaks,
  makeCanaries,
  origin,
  privateFiles,
} from './support.mts';

const spikeFolder = fileURLToPath(
  new URL('../../scripts/spike/', import.meta.url),
);

const noNetwork: FetchFunction = () => {
  throw new Error('network access in a test');
};

describe('writeResult', () => {
  it('writes an allowed result as JSON', () => {
    const guard = new Guard();
    guard.allowFixed('status', 'vorhanden');
    const { io, stdout, stderr } = capture();
    expect(writeResult({ status: 'vorhanden' }, guard, io)).toBe(exitCodes.ok);
    expect(JSON.parse(stdout())).toEqual({ status: 'vorhanden' });
    expect(stderr()).toBe('');
  });

  it('withholds a result with unknown words and names only positions', () => {
    const canaries = makeCanaries();
    const guard = new Guard();
    guard.allowFixed('status');
    const { io, stdout, stderr } = capture();
    expect(
      writeResult(
        { status: canaries.personName, [canaries.groupName]: 1 },
        guard,
        io,
      ),
    ).toBe(exitCodes.withheld);
    expect(JSON.parse(stdout())).toEqual({
      zurueckgehalten: true,
      stellen: ['/status', '/#1'],
    });
    const all = (stdout() + stderr()).toLowerCase();
    expect(all).not.toContain(canaries.personName.toLowerCase());
    expect(all).not.toContain(canaries.groupName.toLowerCase());
  });
});

describe('writeError', () => {
  it('shows the fixed code and hint of a spike error', () => {
    const { io, stderr } = capture();
    expect(
      writeError(new SpikeError('KONFIGURATION', 'basisUrlFehlt'), io),
    ).toBe(exitCodes.configuration);
    expect(stderr()).toBe(`Code: KONFIGURATION\n${hints.basisUrlFehlt}\n`);
  });

  it('never shows the message of another error', () => {
    const canaries = makeCanaries();
    const { io, stdout, stderr } = capture();
    const error = new Error(
      `${canaries.personName} ${origin} ${canaries.token}`,
      {
        cause: canaries.personEmail,
      },
    );
    expect(writeError(error, io)).toBe(exitCodes.internal);
    expect(stderr()).toBe(`Code: INTERN\n${hints.intern}\n`);
    expect(stdout()).toBe('');
  });

  it('maps network codes to their exit code and hint', () => {
    const { io, stderr } = capture();
    expect(writeError(new SpikeError('NETZ_DNS'), io)).toBe(exitCodes.network);
    expect(stderr()).toContain(hints.netz);
  });
});

describe('integrityLines', () => {
  it('lists the Node.js version and a hash per script file, with relative paths', () => {
    const folder = mkdtempSync(join(tmpdir(), 'spike-hash-'));
    mkdirSync(join(folder, 'lib'));
    writeFileSync(join(folder, '00-probe.mts'), 'a');
    writeFileSync(join(folder, 'lib', 'x.mts'), 'b');
    writeFileSync(join(folder, 'notes.txt'), 'c');
    const lines = integrityLines(folder);
    expect(lines[0]).toBe(`Node.js ${process.version}`);
    expect(lines.slice(2)).toEqual([
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  00-probe.mts',
      '3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  lib/x.mts',
    ]);
  });
});

describe('runProbe', () => {
  const definition = (run: ProbeDefinition['run']): ProbeDefinition => ({
    name: 'test',
    state: 'create',
    run,
  });

  it('stops without environment, with a German hint and without network', async () => {
    const { io, stdout, stderr } = capture();
    const code = await runProbe(
      definition(() => Promise.resolve('x')),
      { env: {}, fetch: noNetwork, io, folder: spikeFolder },
    );
    expect(code).toBe(exitCodes.configuration);
    expect(stdout()).toBe('');
    expect(stderr()).toContain(hints.basisUrlFehlt);
    expect(stderr()).toContain(`Node.js ${process.version}`);
  });

  it('refuses a Node.js environment that could inject code', async () => {
    const { io, stderr } = capture();
    const code = await runProbe(
      definition(() => Promise.resolve('x')),
      {
        env: {
          NODE_OPTIONS: '--require ./x.js',
          ECCLIUM_SPIKE_BASE_URL: origin,
        },
        fetch: noNetwork,
        io,
        folder: spikeFolder,
      },
    );
    expect(code).toBe(exitCodes.configuration);
    expect(stderr()).toContain(hints.umgebungUnsicher);
  });

  it('shows nothing of an unexpected error and withholds leaking results', async () => {
    const canaries = makeCanaries();
    const files = privateFiles(canaries.token);
    const env = {
      ECCLIUM_SPIKE_BASE_URL: origin,
      ECCLIUM_SPIKE_TOKEN_FILE: files.tokenFile,
      ECCLIUM_SPIKE_STATE_FILE: files.stateFile,
    };
    const forbidden = forbiddenTexts(canaries, files.folder);

    const crashing = capture();
    expect(
      await runProbe(
        definition(() =>
          Promise.reject(new Error(`${canaries.personName} ${canaries.token}`)),
        ),
        { env, fetch: noNetwork, io: crashing.io, folder: spikeFolder },
      ),
    ).toBe(exitCodes.internal);

    const leaking = capture();
    expect(
      await runProbe(
        definition(({ guard }) => {
          guard.allowChecked(canaries.token);
          guard.allowChecked(files.tokenFile);
          return Promise.resolve({ [canaries.token]: files.tokenFile });
        }),
        { env, fetch: noNetwork, io: leaking.io, folder: spikeFolder },
      ),
    ).toBe(exitCodes.withheld);

    for (const output of [crashing, leaking]) {
      expect(leaks(output, forbidden)).toEqual([]);
    }
  });
});
