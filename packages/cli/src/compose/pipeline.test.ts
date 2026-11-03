import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type EccliumConfig,
  loadConfig,
  type ToolPipelineOptions,
} from '@ecclium/mcp-churchtools-core';
import {
  createStderrWriter,
  systemClock,
} from '@ecclium/mcp-churchtools-core/composition';
import type {
  HttpTransport,
  HttpTransportOptions,
} from '@ecclium/mcp-churchtools-core/http';
import {
  createChurchToolsDouble,
  doubleOrigin,
  makeCanaries,
  type MockedHttpTransport,
} from '@ecclium/mcp-churchtools-testkit';
import type { IsoDate } from '@ecclium/mcp-churchtools-plugin-api';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { createStdioCatalog } from '../stdio/catalog.js';
import { userAgent } from '../version.js';
import { composeToolPipeline } from './pipeline.js';

// The build of the pipeline alone; the start over stdio and its tests use
// it with the server around it. The factory of the pipeline is wrapped, so
// that a test sees the keys it gets.

const built = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock(import('@ecclium/mcp-churchtools-core'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    createToolPipeline: (options: ToolPipelineOptions) => {
      built.options.push(options);
      return original.createToolPipeline(options);
    },
  };
});

const canary = makeCanaries();

// A folder of keys with 0700, and a key file for the level strict, with a
// key made from a seed instead of written out, so that no secret scanner
// reads it as a leaked one.
const base = mkdtempSync(join(tmpdir(), 'ecclium-compose-'));
const keysDir = mkdtempSync(join(base, 'keys-'));
chmodSync(keysDir, 0o700);
const keyFile = join(base, 'pseudonym-key');
writeFileSync(
  keyFile,
  `${createHash('sha256').update('compose').digest('hex')}\n`,
  { mode: 0o600 },
);
chmodSync(keyFile, 0o600);
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

const configOf = (extra: Record<string, string> = {}): EccliumConfig => {
  const loaded = loadConfig({
    environment: {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
      ...extra,
    },
    transport: 'stdio',
  });
  if (!loaded.ok) throw new Error('the configuration of the test is invalid');
  return loaded.config;
};

const open: MockedHttpTransport[] = [];
afterEach(async () => {
  built.options.length = 0;
  await Promise.all(
    open.splice(0).map((double) => double.close().catch(() => undefined)),
  );
});

const setup = (config = configOf()) => {
  const given: HttpTransportOptions[] = [];
  const made: HttpTransport[] = [];
  let closed = 0;
  const build = () =>
    composeToolPipeline({
      config,
      catalog: createStdioCatalog(config),
      writer: createStderrWriter({
        writeSync: (_fd, _b, _o, length) => length,
      }),
      clock: systemClock,
      createTransport: (options) => {
        given.push(options);
        const double = createChurchToolsDouble({
          token: options.token,
          origin: options.origin,
        });
        open.push(double);
        const transport: HttpTransport = {
          ...double.transport,
          close: () => {
            closed += 1;
            return double.transport.close();
          },
        };
        made.push(transport);
        return transport;
      },
    });
  return { build, given, made, closed: () => closed };
};

describe('the build of the pipeline', () => {
  it('builds the pipeline over the transport to the instance of the configuration', () => {
    const { build, given, made, closed } = setup();
    const composed = build();
    expect(made).toHaveLength(1);
    expect(composed.transport).toBe(made[0]);
    expect(typeof composed.pipeline.call).toBe('function');
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({ origin: doubleOrigin, userAgent });
    expect(closed()).toBe(0);
    expect(Object.isFrozen(composed)).toBe(true);
  });

  it('gives the pipeline no keys while the level is not strict and no folder of keys is set', () => {
    const composed = setup().build();
    expect(composed.dayKeys).toBeUndefined();
    expect(built.options).toHaveLength(1);
    expect(Object.hasOwn(built.options[0] as object, 'keys')).toBe(false);
  });

  // Every write keeps a snapshot whose key a day key encrypts (ADR 0031),
  // so the provider the pipeline gets wraps with the day keys in the
  // folder, the same the start destroys through.
  it('gives the pipeline a provider with the day keys in the folder of keys', async () => {
    const config = configOf({
      ECCLIUM_READ_ONLY: 'false',
      ECCLIUM_KEYS_DIR: keysDir,
    });
    const composed = setup(config).build();
    expect(composed.dayKeys).toBeDefined();
    const { keys } = built.options[0] as ToolPipelineOptions;
    if (keys === undefined) throw new Error('no keys');
    const ctx = { tenantId: 'default' } as never;
    const day = '2026-11-03' as IsoDate;
    const key = new Uint8Array(32).fill(7);
    const wrapped = await keys.wrap(ctx, 'snapshot', day, key);
    expect(readdirSync(join(keysDir, 'snapshot'))).toEqual([
      'default.2026-11-03.key',
    ]);
    expect(await composed.dayKeys?.unwrap(ctx, 'snapshot', wrapped)).toEqual(
      key,
    );
    // Without strict, the provider has no secret for pseudonyms.
    await expect(keys.dataKeys(ctx, 'pseudonym', day)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(
      await composed.dayKeys?.destroyBefore(
        'snapshot',
        '2026-11-04' as IsoDate,
      ),
    ).toBe(1);
  });

  it('gives one provider with the secrets of strict and the day keys', async () => {
    const config = configOf({
      ECCLIUM_REDACTION: 'strict',
      ECCLIUM_PSEUDONYM_KEY_FILE: keyFile,
      ECCLIUM_KEYS_DIR: keysDir,
    });
    const composed = setup(config).build();
    const { keys } = built.options[0] as ToolPipelineOptions;
    const ctx = {
      tenantId: 'default',
      instance: 'https://example.church.tools',
      actor: { kind: 'user', id: 'stdio:local-stdio' },
    } as never;
    const day = '2026-11-02' as IsoDate;
    const wrapped = await keys?.wrap(ctx, 'snapshot', day, new Uint8Array(32));
    expect(wrapped?.day).toBe(day);
    // The same provider derives the keys of the pseudonyms.
    const derived = await keys?.dataKeys(ctx, 'pseudonym', day);
    expect(derived?.map((key) => key.length)).toEqual([32]);
    expect(
      await composed.dayKeys?.destroyBefore(
        'snapshot',
        '2026-11-03' as IsoDate,
      ),
    ).toBe(1);
    const strictOnly = setup(
      configOf({
        ECCLIUM_REDACTION: 'strict',
        ECCLIUM_PSEUDONYM_KEY_FILE: keyFile,
      }),
    ).build();
    expect(strictOnly.dayKeys).toBeUndefined();
    const withoutDayKeys = (built.options[1] as ToolPipelineOptions).keys;
    await expect(
      withoutDayKeys?.destroyBefore('snapshot', '2026-11-04' as IsoDate),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('closes the transport again when the level strict has no key', () => {
    const { build, closed } = setup({
      ...configOf(),
      redaction: 'strict',
      pseudonymKey: undefined,
    });
    expect(build).toThrow(TypeError);
    expect(closed()).toBe(1);
  });
});
