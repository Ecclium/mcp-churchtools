// Preload for the child process of tests/stdio-start.test.mts, loaded with
// --import after the network guard. The configuration takes no IP address
// and no localhost as the address of ChurchTools, and the guard refuses
// every name resolution, so the child could reach no server at all. This
// preload sends a TLS connection to the host demo.example to 127.0.0.1
// instead, where the test serves, and keeps the port and the servername:
// the certificate is still checked for demo.example. undici opens its TLS
// connections with tls.connect of the module object, so the replacement
// sees them. Should undici stop doing so, the guard refuses the attempt and
// the test fails loudly.
import { syncBuiltinESMExports } from 'node:module';
import tls from 'node:tls';

const host = 'demo.example';
const original = tls.connect;

/** Whether the first argument of tls.connect is options for the host. */
const isForHost = (value: unknown): value is tls.ConnectionOptions =>
  typeof value === 'object' &&
  value !== null &&
  (value as tls.ConnectionOptions).host === host;

tls.connect = function connect(
  this: unknown,
  ...args: unknown[]
): tls.TLSSocket {
  const [first, ...rest] = args;
  const redirected = isForHost(first)
    ? [{ ...first, host: '127.0.0.1' }, ...rest]
    : args;
  return Reflect.apply(original, this, redirected) as tls.TLSSocket;
};
syncBuiltinESMExports();
