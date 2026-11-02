import { type EccliumConfig, loadConfig } from '@ecclium/mcp-churchtools-core';
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
import { afterEach, describe, expect, it } from 'vitest';

import { createStdioCatalog } from '../stdio/catalog.js';
import { userAgent } from '../version.js';
import { composeToolPipeline } from './pipeline.js';

// The build of the pipeline alone; the start over stdio and its tests use
// it with the server around it.

const canary = makeCanaries();

const configOf = (): EccliumConfig => {
  const loaded = loadConfig({
    environment: {
      ECCLIUM_CHURCHTOOLS_URL: doubleOrigin,
      ECCLIUM_CHURCHTOOLS_TOKEN: canary.token.value,
    },
    transport: 'stdio',
  });
  if (!loaded.ok) throw new Error('the configuration of the test is invalid');
  return loaded.config;
};

const open: MockedHttpTransport[] = [];
afterEach(async () => {
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
