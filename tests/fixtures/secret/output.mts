// Child process for tests/secret-output.test.mts. It wraps a canary in a
// Secret and lets the secret reach the output paths of Node.js that skip the
// custom inspect hook or run outside the code of Ecclium: the printer for an
// uncaught error, an unhandled 'error' event, console and warnings. The parent checks stdout and stderr for the canary.
// With a third argument 'naive', a careless secret takes its place, with the
// value in a public field and a toString that gives it. That it leaks shows
// that the path can leak a secret at all.
import { EventEmitter } from 'node:events';
import process from 'node:process';

import { Secret } from '../../../packages/core/src/http/secret.ts';

class NaiveSecret {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const [mode = '', value = '', form = ''] = process.argv.slice(2);
const secret = form === 'naive' ? new NaiveSecret(value) : new Secret(value);

/* eslint-disable @typescript-eslint/only-throw-error -- the point is to throw values that are not errors */
switch (mode) {
  case 'throw':
    throw secret;
  case 'throw-cause':
    throw new Error('failed', { cause: secret });
  case 'throw-object':
    throw { token: secret };
  case 'aggregate':
    throw new AggregateError([secret], 'failed');
  case 'timer':
    setTimeout(() => {
      throw secret;
    }, 0);
    break;
  case 'emitter':
    new EventEmitter().emit('error', { s: secret });
    break;
  case 'console':
    console.log(secret);
    console.error({ secret });
    console.dir(secret, { customInspect: false });
    console.dir({ a: { b: secret } }, { customInspect: false, depth: null });
    console.table([{ secret }]);
    break;
  case 'warning':
    process.emitWarning('a warning', { detail: String(secret) });
    break;
  default:
    throw new Error(`unknown mode ${mode}`);
}
/* eslint-enable @typescript-eslint/only-throw-error */
