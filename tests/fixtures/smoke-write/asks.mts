// Child process for the test of `onRequest` in scripts/smoke/session.mts,
// in tests/scripts/smoke-write.test.mts. It plays a server that asks its
// client, as the server of Ecclium asks with `elicitation/create` in the
// 2025 era: for a request `frage` of the client it sends a request of its
// own with the method, ID and params the client named, waits for the
// answer with that ID and gives it back as the result of `frage`. With the
// ID of the client's own request it shows that a request of the server
// settles nothing of the client. It ends when its stdin closes.
import process from 'node:process';
import { createInterface } from 'node:readline';

const pending = new Map<unknown, (answer: unknown) => void>();

const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

createInterface({ input: process.stdin }).on('line', (line) => {
  const message: unknown = JSON.parse(line);
  if (!isRecord(message)) return;
  if (message['method'] === 'frage' && isRecord(message['params'])) {
    const { method, id, params } = message['params'];
    pending.set(id, (answer) => {
      send({ jsonrpc: '2.0', id: message['id'], result: { answer } });
    });
    send({ jsonrpc: '2.0', id, method, params });
    return;
  }
  if ('method' in message) return;
  const settle = pending.get(message['id']);
  if (settle === undefined) return;
  pending.delete(message['id']);
  settle(message);
});
