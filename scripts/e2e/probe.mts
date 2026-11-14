// The probe of the network of the runner in the E2E job (ADR 0035, ADR
// 0036). scripts/e2e/run.mts starts it in a container like the runner: the
// same image, user and network, only with this file instead of the runner.
//
//   node /app/scripts/e2e/probe.mts <address of the decoy> <target> …
//
// It tries the decoy directly, by name and by its address in the outer
// network, the proxy directly, and each target as `name:port` with CONNECT
// through the proxy, without TLS and without a request in the tunnel. It
// prints one line of JSON in the form of ProbeResult (verdict.mts), with
// outcomes and codes only, never an address it resolved.
import dns from 'node:dns/promises';
import net from 'node:net';
import process from 'node:process';
import tls from 'node:tls';

import type { ProbeOutcome, ProbeResult } from './verdict.mts';

/** The name of the decoy in the outer network. */
export const decoyName = 'decoy.e2e.test';
/** The proxy as the runner reaches it. */
export const proxy = { host: 'egress', port: 3128 } as const;

const timeoutMs = 5000;

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;

const resolve = async (name: string): Promise<ProbeOutcome> => {
  try {
    await dns.lookup(name);
    return { result: 'ok' };
  } catch (error) {
    const code = errorCode(error);
    return code === undefined
      ? { result: 'failed' }
      : { result: 'failed', code };
  }
};

const connect = (host: string, port: number): Promise<ProbeOutcome> =>
  new Promise((done) => {
    const socket = net.connect({ host, port });
    const finish = (outcome: ProbeOutcome): void => {
      socket.destroy();
      done(outcome);
    };
    socket.setTimeout(timeoutMs, () => {
      finish({ result: 'timeout' });
    });
    socket.once('connect', () => {
      finish({ result: 'ok' });
    });
    socket.once('error', (error) => {
      const code = errorCode(error);
      finish(
        code === undefined ? { result: 'failed' } : { result: 'failed', code },
      );
    });
  });

// The handshake of TLS in an open tunnel, with the certificates the
// container trusts, as the runner makes it.
const handshake = (socket: net.Socket, host: string): Promise<ProbeOutcome> =>
  new Promise((done) => {
    const secure = tls.connect({ socket, servername: host });
    const finish = (outcome: ProbeOutcome): void => {
      secure.destroy();
      done(outcome);
    };
    secure.setTimeout(timeoutMs, () => {
      finish({ result: 'timeout' });
    });
    secure.once('secureConnect', () => {
      finish({ result: 'ok' });
    });
    secure.once('error', (error) => {
      const code = errorCode(error);
      finish(
        code === undefined ? { result: 'failed' } : { result: 'failed', code },
      );
    });
  });

// The status of the answer of the proxy to CONNECT, or undefined without
// one in time, and after a 200 the handshake of TLS through the tunnel.
const tunnel = (
  target: string,
): Promise<{ status: number | undefined; tls?: ProbeOutcome }> =>
  new Promise((done) => {
    const socket = net.connect(proxy);
    let answer = '';
    let settled = false;
    const finish = (
      status: number | undefined,
      outcome?: ProbeOutcome,
    ): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(outcome === undefined ? { status } : { status, tls: outcome });
    };
    socket.setTimeout(timeoutMs, () => {
      finish(undefined);
    });
    socket.once('connect', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    const onData = (chunk: Buffer): void => {
      answer += chunk.toString('latin1');
      const status = /^HTTP\/1\.[01] (\d{3})/u.exec(answer)?.[1];
      if (status === undefined || !answer.includes('\r\n\r\n')) return;
      socket.off('data', onData);
      if (status !== '200') {
        finish(Number(status));
        return;
      }
      socket.setTimeout(0);
      const host = target.slice(0, target.lastIndexOf(':'));
      void handshake(socket, host).then((outcome) => {
        finish(200, outcome);
      });
    };
    socket.on('data', onData);
    socket.once('error', () => {
      finish(undefined);
    });
  });

const main = async (): Promise<void> => {
  const [address, ...targets] = process.argv.slice(2);
  if (address === undefined || net.isIP(address) === 0) {
    process.stderr.write(
      'Aufruf: probe.mts <Adresse des Lockziels> <Ziel> …\n',
    );
    process.exit(64);
  }
  const connects: Record<string, number | undefined> = {};
  const handshakes: Record<string, ProbeOutcome> = {};
  for (const target of targets) {
    const { status, tls: outcome } = await tunnel(target);
    connects[target] = status;
    if (outcome !== undefined) handshakes[target] = outcome;
  }
  const result: ProbeResult = {
    decoyName: await resolve(decoyName),
    decoyAddress: await connect(address, 443),
    proxy: await connect(proxy.host, proxy.port),
    connect: connects,
    tls: handshakes,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
};

if (import.meta.main) await main();
