// Shows in CI that the checks have loopback but no way out (ADR 0052).
// scripts/ci/without-network.sh runs it in mode online before it creates the
// network namespace and in mode offline inside it, right before the checks:
//
//   node scripts/ci/check-network.mts online|offline
//
// It prints one line in German and, on GitHub, a notice that the run keeps
// as an annotation. It never prints an address it resolved. The verdict is
// a pure function, so its tests need no network. The probe runs without the
// network guard of the tests: a refusal by that guard counts as a failure,
// so that the guard can never stand in for the namespace.
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import process from 'node:process';

/** The error code of the network guard of the tests. */
export const blockedCode = 'ECCLIUM_TEST_NETWORK_BLOCKED';

/** Where the probe tries to go, by name, when the job still has network. */
const onlineHost = 'github.com';
/**
 * Where the probe tries to go without a name in the namespace: an address
 * for documentation (RFC 5737). Without a route the attempt fails at once.
 */
const offlineAddress = '192.0.2.1';
const timeoutMs = 5000;

/** The outcome of one operation. */
export interface Outcome {
  readonly result: 'ok' | 'failed' | 'timeout';
  /** The error code of a failure, if it had one. */
  readonly code?: string;
  readonly ms: number;
}

/** What the probe observed. */
export interface Observations {
  /** Names of the network interfaces. */
  readonly interfaces: readonly string[];
  /** A round trip through a server on 127.0.0.1. */
  readonly loopback4: Outcome;
  /** A round trip through a server on ::1. */
  readonly loopback6: Outcome;
  /** A name resolution. */
  readonly lookup: Outcome;
  /** A connection out: by name online, to an address offline. */
  readonly outbound: Outcome;
}

/** The mode of the probe. */
export type Mode = 'online' | 'offline';

/**
 * Judges what the probe observed.
 *
 * @param mode - online before the namespace, offline inside it.
 * @param seen - The observations.
 * @returns The problems found, empty when the network is as expected.
 * @example
 * judge('offline', seen); // [] inside a namespace with loopback only
 */
export function judge(mode: Mode, seen: Observations): string[] {
  const problems: string[] = [];
  const outcomes = [seen.loopback4, seen.loopback6, seen.lookup, seen.outbound];
  if (outcomes.some((outcome) => outcome.code === blockedCode)) {
    problems.push('die Sperre der Tests ist aktiv, die Probe misst so nichts');
  }
  if (mode === 'online') {
    if (!seen.interfaces.some((name) => name !== 'lo')) {
      problems.push('keine Schnittstelle ausser lo');
    }
    if (seen.lookup.result !== 'ok')
      problems.push('Namensauflösung gescheitert');
    if (seen.outbound.result !== 'ok')
      problems.push('keine Verbindung nach aussen');
    return problems;
  }
  if (seen.interfaces.length !== 1 || seen.interfaces[0] !== 'lo') {
    problems.push('andere Schnittstellen als lo');
  }
  if (seen.loopback4.result !== 'ok')
    problems.push('Loopback über IPv4 trägt nicht');
  if (seen.loopback6.result !== 'ok')
    problems.push('Loopback über IPv6 trägt nicht');
  // A timeout means the attempt hung instead of failing, as it would behind
  // a filter that drops packets; the namespace must refuse at once.
  if (seen.lookup.result !== 'failed')
    problems.push('Namensauflösung nicht sofort gescheitert');
  if (seen.outbound.result !== 'failed') {
    problems.push('Verbindung nach aussen nicht sofort gescheitert');
  }
  return problems;
}

// One outcome for the line of the probe.
function shown(outcome: Outcome): string {
  const code = outcome.code === undefined ? '' : ` ${outcome.code}`;
  const word = { ok: 'ok', failed: 'gescheitert', timeout: 'Zeitlimit' }[
    outcome.result
  ];
  return `${word}${code}, ${String(outcome.ms)} ms`;
}

/**
 * The line the probe prints, without any address it resolved.
 *
 * @param mode - online or offline.
 * @param seen - The observations.
 * @param problems - The problems from judge().
 * @returns One line in German.
 * @example
 * describe('offline', seen, []); // 'Netzprobe offline: in Ordnung; …'
 */
export function describe(
  mode: Mode,
  seen: Observations,
  problems: readonly string[],
): string {
  const verdict =
    problems.length === 0 ? 'in Ordnung' : `Fehler: ${problems.join(', ')}`;
  return (
    `Netzprobe ${mode}: ${verdict}; Schnittstellen ${seen.interfaces.join(' ') || 'keine'}; ` +
    `Loopback IPv4 ${shown(seen.loopback4)}; Loopback IPv6 ${shown(seen.loopback6)}; ` +
    `Namensauflösung ${shown(seen.lookup)}; Verbindung nach aussen ${shown(seen.outbound)}`
  );
}

// Runs an operation with a time limit and measures it.
async function measure(operation: () => Promise<void>): Promise<Outcome> {
  const start = performance.now();
  const elapsed = (): number => Math.round(performance.now() - start);
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([
      operation().then(() => 'ok' as const),
      limit,
    ]);
    return result === 'ok'
      ? { result, ms: elapsed() }
      : { result: 'timeout', ms: elapsed() };
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), 'code');
    return typeof code === 'string'
      ? { result: 'failed', code, ms: elapsed() }
      : { result: 'failed', ms: elapsed() };
  } finally {
    clearTimeout(timer);
  }
}

// Opens a connection and closes it again once it stands. A connection that
// hangs is closed shortly after measure() gave up on it, so that it does not
// keep the process alive.
function connected(options: net.NetConnectOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    socket.setTimeout(timeoutMs + 100, () => {
      socket.destroy();
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

// A round trip through a server on the address.
async function roundTrip(address: string): Promise<void> {
  const server = net.createServer((socket) => {
    socket.end();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, address, resolve);
    });
    const { port } = server.address() as net.AddressInfo;
    await connected({ host: address, port });
  } finally {
    server.close();
  }
}

// Measures an operation up to three times until it succeeds.
async function withRetries(operation: () => Promise<void>): Promise<Outcome> {
  let outcome = await measure(operation);
  for (let attempt = 1; attempt < 3 && outcome.result !== 'ok'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    outcome = await measure(operation);
  }
  return outcome;
}

// Observes the network of this process.
async function observe(mode: Mode): Promise<Observations> {
  const interfaces = Object.keys(os.networkInterfaces()).sort();
  const loopback4 = await measure(() => roundTrip('127.0.0.1'));
  const loopback6 = await measure(() => roundTrip('::1'));
  // Online the job must reach the outside, so a short outage is retried.
  // Offline every attempt must fail at once, so there is no retry.
  const run = mode === 'online' ? withRetries : measure;
  const lookup = await run(async () => {
    await dns.promises.lookup(onlineHost);
  });
  const outbound = await run(() =>
    mode === 'online'
      ? connected({ host: onlineHost, port: 443 })
      : connected({ host: offlineAddress, port: 443 }),
  );
  return { interfaces, loopback4, loopback6, lookup, outbound };
}

// Escapes a value for a workflow command of GitHub Actions.
function escapeData(text: string): string {
  return text
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'online' && mode !== 'offline') {
    process.stderr.write(
      'Aufruf: node scripts/ci/check-network.mts online|offline\n',
    );
    process.exitCode = 2;
    return;
  }
  const seen = await observe(mode);
  const problems = judge(mode, seen);
  const line = describe(mode, seen, problems);
  process.stdout.write(`${line}\n`);
  if (process.env['GITHUB_ACTIONS'] === 'true') {
    const level = problems.length === 0 ? 'notice' : 'error';
    process.stdout.write(
      `::${level} title=Netzprobe ${mode}::${escapeData(line)}\n`,
    );
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  await main();
}
