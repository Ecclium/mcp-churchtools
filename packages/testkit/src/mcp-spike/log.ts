/**
 * Record of the elicitation spike: one JSON line per event, built from a
 * fixed list of fields. It writes through a function it is given and never
 * on its own (ADR 0053).
 *
 * The record leaves the machine of the person who runs the spike, so it
 * holds names, counts and fixed words only: never the content of an
 * answer, a raw `requestState`, the environment or a path. Every field has
 * a kind, and a value that does not fit its kind is written as `null`.
 *
 * @packageDocumentation
 */

/** How a field may look in the record. */
type FieldKind =
  | 'name'
  | 'names'
  | 'count'
  | 'code'
  | 'flag'
  | 'era'
  | 'action'
  | 'outcome'
  | 'reason'
  | 'kind';

/**
 * The events of the spike and the fields each one may carry. A field that
 * is not listed for its event never reaches the record.
 */
const eventFields = {
  process_start: { instanceId: 'name', sdkVersion: 'name' },
  instance_created: { era: 'era' },
  client_hello: {
    protocolVersion: 'name',
    clientName: 'name',
    clientVersion: 'name',
    capabilities: 'names',
  },
  discover: {
    protocolVersion: 'name',
    clientName: 'name',
    clientVersion: 'name',
    capabilities: 'names',
  },
  tool_call: {
    call: 'count',
    era: 'era',
    protocolVersion: 'name',
    clientName: 'name',
    clientVersion: 'name',
    capabilities: 'names',
    metaKeys: 'names',
    requestState: 'flag',
    inputResponses: 'names',
  },
  capability_absent: { era: 'era' },
  input_required_issued: { nonce: 'name', code: 'name', round: 'count' },
  retry_received: {
    nonce: 'name',
    round: 'count',
    action: 'action',
    contentKeys: 'names',
    valid: 'flag',
    elapsedMs: 'count',
  },
  elicitation_sent: { elicitation: 'count' },
  elicitation_answered: {
    elicitation: 'count',
    action: 'action',
    contentKeys: 'names',
    errorCode: 'code',
    elapsedMs: 'count',
  },
  cancel_received: { call: 'count' },
  response_sent: { call: 'count', outcome: 'outcome', errorCode: 'code' },
  request_rejected: { reason: 'reason' },
  server_error: { kind: 'kind' },
  entry_error: { kind: 'kind' },
  process_failed: { kind: 'kind' },
} as const satisfies Readonly<
  Record<string, Readonly<Record<string, FieldKind>>>
>;

/** Name of an event of the spike. */
export type SpikeEventName = keyof typeof eventFields;

/** An event with the fields it may carry; anything else is dropped. */
export type SpikeEvent = {
  readonly [E in SpikeEventName]: readonly [
    name: E,
    fields?: { readonly [F in keyof (typeof eventFields)[E]]?: unknown },
  ];
}[SpikeEventName];

/** Writes events of the spike to the record. */
export interface SpikeLog {
  /**
   * Writes one event as one line.
   *
   * @param event - The name of the event and its fields. Unknown fields and
   *   values of the wrong kind do not reach the record.
   */
  event(...event: SpikeEvent): void;
}

// The fixed words a field of these kinds may hold. Plain arrays, because
// nothing is created with new at module level (ADR 0051).
const words: Readonly<Partial<Record<FieldKind, readonly string[]>>> = {
  era: ['legacy', 'modern'],
  action: [
    'accept',
    'decline',
    'cancel',
    'missing',
    'sampling',
    'roots',
    'unknown',
  ],
  outcome: ['result', 'input_required', 'is_error', 'error'],
  reason: ['malformed', 'mac', 'expired', 'bind', 'other'],
  kind: ['uncaught_exception', 'unhandled_rejection', 'other'],
};

// Names such as a client name, a protocol version or a capability key:
// letters, digits and a few separators, at most 64 characters. Anything
// longer or with other characters could carry data and is dropped.
const namePattern = /^[A-Za-z0-9][A-Za-z0-9 ._:/@+()-]{0,63}$/;
const maxNames = 32;

const isName = (value: unknown): value is string =>
  typeof value === 'string' && namePattern.test(value) && !value.endsWith(' ');

function clean(kind: FieldKind, value: unknown): unknown {
  switch (kind) {
    case 'name':
      return isName(value) ? value : null;
    case 'names':
      return Array.isArray(value)
        ? value.filter(isName).slice(0, maxNames).sort()
        : null;
    case 'count':
      return Number.isSafeInteger(value) && (value as number) >= 0
        ? value
        : null;
    case 'code':
      return Number.isSafeInteger(value) ? value : null;
    case 'flag':
      return typeof value === 'boolean' ? value : null;
    default:
      return typeof value === 'string' && words[kind]?.includes(value) === true
        ? value
        : null;
  }
}

/**
 * Creates the record of the spike.
 *
 * @param write - Receives each line, ending in a line break. The start of
 *   the spike passes a function that writes to stderr.
 * @param now - The current time in milliseconds since the epoch.
 * @returns The record.
 * @example
 * ```ts
 * const lines: string[] = [];
 * const log = createSpikeLog((line) => lines.push(line), () => Date.now());
 * log.event('instance_created', { era: 'modern' });
 * ```
 */
export function createSpikeLog(
  write: (line: string) => void,
  now: () => number,
): SpikeLog {
  return {
    event(...[name, fields]) {
      const allowed: Readonly<Record<string, FieldKind>> = eventFields[name];
      const given: Readonly<Record<string, unknown>> = fields ?? {};
      const record: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        event: name,
      };
      // A field without a value is left out; a value of the wrong kind
      // becomes null, so the record shows that something was there.
      for (const [field, kind] of Object.entries(allowed)) {
        if (Object.hasOwn(given, field) && given[field] !== undefined) {
          record[field] = clean(kind, given[field]);
        }
      }
      write(`${JSON.stringify(record)}\n`);
    },
  };
}
