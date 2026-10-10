// Blocks network access in the process that loads this file (ADR 0052).
// Allowed are TCP, TLS and UDP to 127.0.0.1 and ::1 written as IP literals,
// and TCP servers that listen on one of them. Every name resolution is
// refused, 'localhost' included. Vitest loads the file into each test
// process through no-network.setup.mts, which hands it on to Node.js child
// processes through NODE_OPTIONS. Programs that are not Node.js, such as
// git, are not covered here; in CI a network namespace without an outbound
// route covers them.
import dgram from 'node:dgram';
import dns from 'node:dns';
import { writeSync } from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import process from 'node:process';
import workerThreads from 'node:worker_threads';

/** The error code of every refused attempt. */
export const blockedCode = 'ECCLIUM_TEST_NETWORK_BLOCKED';

/** The start of every message of the guard, to tell it from other errors. */
export const blockedMarker = 'Netzzugriff im Test gesperrt (ADR 0052)';

/** The option that loads the guard into a Node.js child process. */
export const guardPreload = `--import=${new URL('no-network.mts', import.meta.url).href}`;

/**
 * Environment variables that route requests through a proxy. Node.js follows
 * them with NODE_USE_ENV_PROXY, and a proxy on 127.0.0.1 would pass the
 * loopback rule and carry the request out.
 */
export const proxyVariables: readonly string[] = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

// The variables that name a proxy; NO_PROXY only lists exceptions.
const proxyUrlVariables = proxyVariables.filter(
  (name) => name.toLowerCase() !== 'no_proxy',
);

const loopback: readonly string[] = ['127.0.0.1', '::1'];
const resolverMethod = /^(lookup|lookupService|resolve[A-Za-z0-9]*|reverse)$/;
// process.binding() is deprecated but still hands these out, and tcp_wrap or
// cares_wrap open sockets and resolve names without passing net or dns.
const networkBindings: readonly string[] = [
  'tcp_wrap',
  'udp_wrap',
  'pipe_wrap',
  'tls_wrap',
  'stream_wrap',
  'js_stream',
  'cares_wrap',
];
// One record per process, also when Vitest evaluates the setup file again
// for the next test file in the same process.
const stateKey = Symbol.for('ecclium.tests.noNetwork');

/** Thrown, and recorded, for every refused attempt. */
export class NetworkBlockedError extends Error {
  readonly code = blockedCode;

  constructor(what: string) {
    super(
      `${blockedMarker}: ${what}. Erlaubt sind nur Verbindungen zu 127.0.0.1 ` +
        'und ::1 als IP-Literal, ohne Namensauflösung.',
    );
    this.name = 'NetworkBlockedError';
  }
}

interface Patch {
  readonly target: object;
  readonly key: string;
  readonly guard: unknown;
}

/** Recorded attempts and installed patches of this process. */
export interface NetworkGuard {
  /** Attempts not yet reported; assertNoNetworkUse empties it. */
  readonly violations: string[];
  /** Every attempt of the process, never emptied. */
  readonly log: string[];
  readonly patches: Patch[];
  /**
   * Set by the setup file: whether the process runs Vitest, and whether a
   * test is running, from the first to the last hook of the setup file.
   */
  readonly state: { vitest: boolean; inTest: boolean };
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

interface Target {
  readonly host?: unknown;
  readonly port?: unknown;
  readonly path?: unknown;
}

/** A function stored on an object, read without binding it. */
function methodOf(target: object, key: string): Method {
  const value: unknown = Reflect.get(target, key);
  if (typeof value !== 'function') {
    throw new TypeError(`${key} is not a function`);
  }
  return value as Method;
}

/** A host for a message: characters of a name or an address only. */
function printable(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,253}$/.test(value)
    ? value
    : '<unlesbar>';
}

/** host:port for a message; never headers, paths or other options. */
function endpoint(host: unknown, port: unknown): string {
  const shown = printable(host);
  const number = Number(port);
  const portText =
    Number.isInteger(number) && number >= 0 && number <= 65535
      ? String(number)
      : '<unlesbar>';
  return shown.includes(':')
    ? `[${shown}]:${portText}`
    : `${shown}:${portText}`;
}

function isLoopbackLiteral(host: unknown): boolean {
  return (
    typeof host === 'string' && net.isIP(host) !== 0 && loopback.includes(host)
  );
}

/** Whether a string names a pipe rather than a port, as in lib/net.js. */
function isPipeName(value: unknown): boolean {
  return typeof value === 'string' && !(Number(value) >= 0);
}

/** Records a refused attempt and returns its error. */
function record(guard: NetworkGuard, what: string): NetworkBlockedError {
  const error = new NetworkBlockedError(what);
  guard.violations.push(error.message);
  guard.log.push(error.message);
  if (guard.state.vitest && !guard.state.inTest) {
    // No hook of a test will see this attempt: it came while the file was
    // loaded, before the first or after the last test, or in a file whose
    // tests are all skipped. Vitest reports an uncaught error and fails the
    // run. A microtask runs before Vitest can end the worker, which ends
    // without an exit event, so code 70 would not report it.
    queueMicrotask(() => {
      throw error;
    });
  }
  return error;
}

function refuse(guard: NetworkGuard, what: string): never {
  throw record(guard, what);
}

function freeze(
  guard: NetworkGuard,
  target: object,
  key: string,
  value: unknown,
): void {
  // Symbols on the original, such as the result fields util.promisify()
  // uses for dns.lookup, stay on the replacement.
  const original: unknown = Reflect.get(target, key);
  if (typeof original === 'function' && typeof value === 'function') {
    for (const symbol of Object.getOwnPropertySymbols(original)) {
      const descriptor = Object.getOwnPropertyDescriptor(original, symbol);
      if (descriptor !== undefined) {
        Object.defineProperty(value, symbol, descriptor);
      }
    }
  }
  // Neither writable nor configurable: a test cannot put the original back,
  // and vi.spyOn() fails loudly instead of switching the guard off.
  Object.defineProperty(target, key, {
    value,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  guard.patches.push({ target, key, guard: value });
}

/** The target of Socket#connect() in each call form of lib/net.js. */
function connectTarget(args: readonly unknown[]): Target {
  // net.connect() passes its normalized [options, callback] array on.
  const first: unknown = Array.isArray(args[0])
    ? (args[0] as unknown[])[0]
    : args[0];
  if (typeof first === 'object' && first !== null) {
    return first;
  }
  if (isPipeName(first)) {
    return { path: first };
  }
  return {
    port: first,
    host: typeof args[1] === 'string' ? args[1] : undefined,
  };
}

/**
 * The host a server listens on, or 'local' for a pipe, a file descriptor or
 * a handle, which open no port. Follows the order of Server#listen in
 * lib/net.js: a handle, then a file descriptor, then a port, then a path.
 */
function listenTarget(args: readonly unknown[]): unknown {
  const first: unknown = args[0];
  if (typeof first === 'object' && first !== null) {
    const field = (key: string): unknown => Reflect.get(first, key);
    if (Boolean(field('_handle')) || Boolean(field('handle'))) {
      return 'local';
    }
    const fd = field('fd');
    if (typeof fd === 'number' && fd >= 0) {
      return 'local';
    }
    const port = field('port');
    if (typeof port === 'number' || typeof port === 'string') {
      return field('host');
    }
    return isPipeName(field('path')) && Boolean(field('path'))
      ? 'local'
      : field('host');
  }
  if (isPipeName(first)) {
    return 'local';
  }
  return typeof args[1] === 'string' ? args[1] : undefined;
}

function guardTcp(guard: NetworkGuard): void {
  // Every TCP and TLS client of Node.js ends here: net.connect, tls.connect,
  // http, https, http2 and the undici inside fetch and WebSocket.
  const original = methodOf(net.Socket.prototype, 'connect');
  freeze(
    guard,
    net.Socket.prototype,
    'connect',
    function connect(this: unknown, ...args: unknown[]): unknown {
      const target = connectTarget(args);
      // lib/net.js treats an empty path as no path.
      if (target.path) {
        // The path stays out of the message: it can name a local directory.
        refuse(
          guard,
          'Verbindung über einen lokalen Socket oder eine Named Pipe',
        );
      }
      // lib/net.js connects to 'localhost' when no host is given. An address
      // literal skips the lookup, so a lookup option cannot redirect it.
      const host =
        typeof target.host === 'string' && target.host !== ''
          ? target.host
          : 'localhost';
      if (!isLoopbackLiteral(host)) {
        refuse(guard, `TCP-Verbindung zu ${endpoint(host, target.port)}`);
      }
      return Reflect.apply(original, this, args);
    },
  );
}

function guardServers(guard: NetworkGuard): void {
  // A server on every interface opens a port to the local network.
  const original = methodOf(net.Server.prototype, 'listen');
  freeze(
    guard,
    net.Server.prototype,
    'listen',
    function listen(this: unknown, ...args: unknown[]): unknown {
      const host = listenTarget(args);
      if (host !== 'local' && !isLoopbackLiteral(host)) {
        refuse(
          guard,
          typeof host === 'string' && host !== ''
            ? `Server auf ${printable(host)}`
            : 'Server auf allen Schnittstellen',
        );
      }
      return Reflect.apply(original, this, args);
    },
  );
}

function guardResolvers(guard: NetworkGuard): void {
  // The functions on dns and dns.promises are bound copies, not the methods
  // of Resolver.prototype, so all four places need the guard.
  const promiseHolders: readonly object[] = [
    dns.promises,
    dns.promises.Resolver.prototype,
  ];
  for (const holder of [dns, dns.Resolver.prototype, ...promiseHolders]) {
    for (const key of Object.getOwnPropertyNames(holder)) {
      if (
        !resolverMethod.test(key) ||
        typeof Reflect.get(holder, key) !== 'function'
      ) {
        continue;
      }
      const original = methodOf(holder, key);
      const rejects = promiseHolders.includes(holder);
      freeze(
        guard,
        holder,
        key,
        function resolve(this: unknown, ...args: unknown[]): unknown {
          // lookup() of an address literal answers without a resolver;
          // server.listen('127.0.0.1') and dgram in Node.js 24.15 call it.
          if (
            key === 'lookup' &&
            typeof args[0] === 'string' &&
            net.isIP(args[0]) !== 0
          ) {
            return Reflect.apply(original, this, args);
          }
          const what = `Namensauflösung ${key}(${printable(args[0])})`;
          if (!rejects) {
            return refuse(guard, what);
          }
          // The promise API rejects, as it does for any other error.
          return Promise.reject(record(guard, what));
        },
      );
    }
  }
}

function guardUdp(guard: NetworkGuard): void {
  const proto = dgram.Socket.prototype;
  const send = methodOf(proto, 'send');
  freeze(
    guard,
    proto,
    'send',
    function send_(this: unknown, ...args: unknown[]): unknown {
      // send(msg, port, address) or send(msg, offset, length, port, address),
      // told apart by the rule of Socket#send in lib/dgram.js. Without a port
      // the socket is connected and connect() checked the peer; without an
      // address dgram sends to the loopback of its family.
      const ranged =
        Boolean(args[4]) || (Boolean(args[3]) && typeof args[3] !== 'function');
      const port = ranged ? args[3] : args[1];
      const address = ranged ? args[4] : args[2];
      const given = typeof port !== 'undefined' && typeof port !== 'function';
      if (given && typeof address === 'string' && !isLoopbackLiteral(address)) {
        refuse(guard, `UDP-Paket an ${endpoint(address, port)}`);
      }
      return Reflect.apply(send, this, args);
    },
  );
  // connectSync exists in Node.js 24.21 and 26, not in 24.15.
  for (const key of ['connect', 'connectSync']) {
    if (typeof Reflect.get(proto, key) !== 'function') {
      continue;
    }
    const original = methodOf(proto, key);
    freeze(
      guard,
      proto,
      key,
      function connect(this: unknown, ...args: unknown[]): unknown {
        const [port, address] = args;
        if (typeof address === 'string' && !isLoopbackLiteral(address)) {
          refuse(guard, `UDP-Verbindung zu ${endpoint(address, port)}`);
        }
        return Reflect.apply(original, this, args);
      },
    );
  }
}

function guardBindings(guard: NetworkGuard): void {
  // Not in the types of @types/node, but present at run time.
  if (typeof Reflect.get(process, 'binding') !== 'function') {
    return;
  }
  const original = methodOf(process, 'binding');
  freeze(
    guard,
    process,
    'binding',
    function binding(this: unknown, ...args: unknown[]): unknown {
      const [name] = args;
      if (typeof name === 'string' && networkBindings.includes(name)) {
        refuse(guard, `process.binding('${printable(name)}')`);
      }
      return Reflect.apply(original, process, args);
    },
  );
}

function guardWorkers(guard: NetworkGuard): void {
  // A worker thread starts with fresh built-in modules. A worker from a file
  // inherits --import only when its parent was started with it, and a worker
  // from code (eval: true) never runs preloaded modules. No test needs one.
  freeze(guard, workerThreads, 'Worker', function Worker(): never {
    return refuse(guard, 'Worker-Thread gestartet, dort gilt die Sperre nicht');
  });
}

function guardProxy(guard: NetworkGuard): void {
  // Turns on the proxy from the environment for every later request.
  freeze(
    guard,
    http,
    'setGlobalProxyFromEnv',
    function setGlobalProxyFromEnv(): never {
      return refuse(guard, 'Proxy aus der Umgebung eingeschaltet');
    },
  );
}

/**
 * The record of the guard in this process, without installing it.
 *
 * @returns The record, or undefined when the guard is not installed.
 */
export function currentNetworkGuard(): NetworkGuard | undefined {
  return Reflect.get(globalThis, stateKey) as NetworkGuard | undefined;
}

/**
 * Installs the guard once per process and returns its record.
 *
 * @returns The record of attempts and patches of this process.
 */
export function installNetworkGuard(): NetworkGuard {
  const existing = currentNetworkGuard();
  if (existing !== undefined) {
    return existing;
  }
  const guard: NetworkGuard = {
    violations: [],
    log: [],
    patches: [],
    state: { vitest: false, inTest: false },
  };
  Object.defineProperty(globalThis, stateKey, { value: guard });
  guardTcp(guard);
  guardServers(guard);
  guardResolvers(guard);
  guardUdp(guard);
  guardBindings(guard);
  guardWorkers(guard);
  guardProxy(guard);
  // Named imports of built-ins (import { lookup } from 'node:dns') follow
  // the patched exports only after this call.
  syncBuiltinESMExports();
  // A child process that catches the error and ends normally still fails:
  // no Vitest hook runs there, so the exit code reports the attempt.
  process.once('exit', () => {
    if (guard.violations.length > 0) {
      writeSync(2, `${guard.violations.join('\n')}\n`);
      process.exitCode = 70;
    }
  });
  return guard;
}

/**
 * Throws if a patch was replaced or an attempt was recorded since the last
 * call, and forgets the reported attempts.
 *
 * @param guard - The record of this process.
 * @throws {NetworkBlockedError} When a patch was replaced.
 * @throws {Error} When an attempt was recorded since the last call.
 */
export function assertNoNetworkUse(guard: NetworkGuard): void {
  for (const patch of guard.patches) {
    if (Reflect.get(patch.target, patch.key) !== patch.guard) {
      throw new NetworkBlockedError(
        `die Sperre für ${patch.key} wurde entfernt`,
      );
    }
  }
  const seen = guard.violations.splice(0);
  if (seen.length > 0) {
    throw new Error(
      `${blockedMarker}: ${String(seen.length)} Versuche, auch wenn der Code den Fehler abgefangen hat:\n${seen.join('\n')}`,
    );
  }
}

/**
 * Whether Node.js would send requests through a proxy on a loopback address:
 * NODE_USE_ENV_PROXY or --use-env-proxy is on and HTTP_PROXY, HTTPS_PROXY
 * or ALL_PROXY names 127.0.0.1 or ::1. The guard would let such a
 * connection pass.
 *
 * @param env - The environment of the process.
 * @param flags - The command line options of the process, NODE_OPTIONS included.
 * @returns True when such a proxy is active.
 */
export function loopbackProxyActive(
  env: Readonly<Record<string, string | undefined>>,
  flags: string,
): boolean {
  const switch_ = env['NODE_USE_ENV_PROXY'];
  const on =
    (switch_ !== undefined && switch_ !== '' && switch_ !== '0') ||
    /(^|\s)--use-env-proxy(\s|=|$)/.test(flags);
  if (!on) {
    return false;
  }
  return proxyUrlVariables.some((name) => {
    const value = env[name];
    if (value === undefined || value === '') {
      return false;
    }
    try {
      const host = new URL(value.includes('://') ? value : `http://${value}`)
        .hostname;
      return isLoopbackLiteral(host.replace(/^\[(.*)\]$/, '$1'));
    } catch {
      return false;
    }
  });
}

/**
 * A copy of the environment without the preload of the guard, for a child
 * process that must run without it, such as a program that checks its own
 * environment. In CI the network namespace still covers that child.
 *
 * @param env - The environment to copy.
 * @returns The copy, with the preload removed from NODE_OPTIONS.
 */
export function withoutNetworkGuard(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const options = (env['NODE_OPTIONS'] ?? '')
    .split(/\s+/)
    .filter((option) => option !== '' && option !== guardPreload)
    .join(' ');
  const copy = { ...env };
  if (options === '') {
    delete copy['NODE_OPTIONS'];
  } else {
    copy['NODE_OPTIONS'] = options;
  }
  return copy;
}

installNetworkGuard();
