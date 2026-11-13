import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { probeDirect, probeDirectWith } from './direct-probe.js';

// The check of the direct path (ADR 0035). A connector of the test stands
// in for the network: the network guard of the tests refuses every name
// resolution and counts even an attempt that fails as a fault, so the
// connector of undici is only built here, never used. The Docker run of
// ecclium doctor shows it against a real network.

const target = { host: 'demo.example', port: 443 } as const;
const limits = { connectMs: 1_000 };

describe('probeDirect', () => {
  it('reports a connection that stood and closes it at once', async () => {
    const calls: unknown[] = [];
    let destroyed = 0;
    expect(
      await probeDirectWith(target, (options, callback) => {
        calls.push(options);
        const socket = new (class extends PassThrough {
          override destroy(error?: Error): this {
            destroyed += 1;
            return super.destroy(error);
          }
        })() as unknown as Socket;
        callback(null, socket);
      }),
    ).toEqual({ connected: true });
    // Plain TCP, no TLS and no socket handed in.
    expect(calls).toEqual([
      { hostname: 'demo.example', protocol: 'http:', port: '443' },
    ]);
    expect(destroyed).toBe(1);
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NODATA', 'EAI_NONAME'])(
    'gives dns for %s',
    async (code) => {
      expect(
        await probeDirectWith(target, (_, callback) => {
          callback(Object.assign(new Error('x'), { code }), null);
        }),
      ).toEqual({ connected: false, reason: 'dns' });
    },
  );

  it('reads the code of the first error of an AggregateError', async () => {
    const error = new AggregateError([
      Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
    ]);
    expect(
      await probeDirectWith(target, (_, callback) => {
        callback(error, null);
      }),
    ).toEqual({ connected: false, reason: 'dns' });
  });

  it.each([
    'ECONNREFUSED',
    'UND_ERR_CONNECT_TIMEOUT',
    'ENETUNREACH',
    undefined,
  ])('gives no_connection for %s', async (code) => {
    expect(
      await probeDirectWith(target, (_, callback) => {
        callback(Object.assign(new Error('x'), { code }), null);
      }),
    ).toEqual({ connected: false, reason: 'no_connection' });
  });

  it('gives no_connection when the connector throws', async () => {
    expect(
      await probeDirectWith(target, () => {
        throw new Error('x');
      }),
    ).toEqual({ connected: false, reason: 'no_connection' });
  });

  it.each([
    [{ host: '192.0.2.1', port: 443 }],
    [{ host: 'Demo.example', port: 443 }],
    [{ host: 'localhost', port: 443 }],
    [{ host: 'demo.example', port: 0 }],
    [{ host: 'demo.example', port: 1.5 }],
  ])('refuses %j before a socket opens', async (options) => {
    // probeDirect builds the connector of undici, then the check refuses.
    await expect(probeDirect(options)).rejects.toThrow(
      'The target must be checked.',
    );
    await expect(probeDirect(options, limits)).rejects.toThrow(
      'The target must be checked.',
    );
  });
});
