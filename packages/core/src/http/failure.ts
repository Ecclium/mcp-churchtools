/**
 * Reduces what goes wrong on the outbound path to fixed categories
 * (ADR 0056). Errors of undici and Node.js can carry the address, the
 * headers of the request with the token, or text from the server in their
 * message, stack and cause. None of that leaves the transport: it throws
 * only an {@link HttpTransportError} with a category and a code.
 *
 * @packageDocumentation
 */
import {
  EccliumError,
  type ErrorCode,
} from '@ecclium/mcp-churchtools-plugin-api';

/**
 * Every category of a failure on the outbound path, frozen. The transport
 * writes the category into the name of its log event, `http_<category>`.
 */
export const failureCategories = Object.freeze([
  'refused',
  'connect',
  'tls',
  'timeout',
  'aborted',
  'interrupted',
  'too_large',
  'redirect',
  'encoding',
  'status',
  'failed',
] as const);

/** The category of a failure on the outbound path. */
export type FailureCategory = (typeof failureCategories)[number];

/**
 * The stable code of each category, frozen and without prototype. A refused
 * target is a mistake in the code, never a socket. An answer that the
 * transport does not take is an error of the server, every other failure
 * one of the network.
 */
export const categoryCodes: Readonly<Record<FailureCategory, ErrorCode>> =
  Object.freeze({
    __proto__: null,
    refused: 'internal',
    connect: 'network',
    tls: 'network',
    timeout: 'network',
    aborted: 'network',
    interrupted: 'network',
    too_large: 'upstream',
    redirect: 'upstream',
    encoding: 'upstream',
    status: 'upstream',
    failed: 'network',
  });

/**
 * The error the transport throws. It carries the category and its code and
 * nothing else: no message, no cause and no field of the error it replaces.
 *
 * @example
 * ```ts
 * throw new HttpTransportError('timeout');
 * ```
 */
export class HttpTransportError extends EccliumError {
  /** What went wrong, one of {@link failureCategories}. */
  declare readonly category: FailureCategory;

  /**
   * Creates the error for a category.
   *
   * @param category - What went wrong.
   */
  constructor(category: FailureCategory) {
    super(categoryCodes[category]);
    Object.defineProperty(this, 'name', {
      value: 'HttpTransportError',
      enumerable: false,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(this, 'category', {
      value: category,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
}

/** Where the request was when it failed. */
export type FailurePhase = 'request' | 'body';

/** What the transport knows about a failure besides the thrown value. */
export interface FailureContext {
  /** Before the headers of the response arrived, or while reading its body. */
  readonly phase: FailurePhase;
  /** The reason the transport gives its own deadline when it aborts. */
  readonly deadline: unknown;
  /** Whether the signal of the caller had aborted. */
  readonly callerAborted: boolean;
}

// The codes OpenSSL gives a certificate that fails verification, as Node.js
// reports them, and the codes of Node.js for a failed handshake. Frozen
// lists, not sets: nothing is built while the module loads (ADR 0051).
const tlsCodes: readonly string[] = Object.freeze([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_CRL',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
  'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY',
  'CERT_SIGNATURE_FAILURE',
  'CRL_SIGNATURE_FAILURE',
  'CERT_NOT_YET_VALID',
  'CERT_HAS_EXPIRED',
  'CRL_NOT_YET_VALID',
  'CRL_HAS_EXPIRED',
  'ERROR_IN_CERT_NOT_BEFORE_FIELD',
  'ERROR_IN_CERT_NOT_AFTER_FIELD',
  'ERROR_IN_CRL_LAST_UPDATE_FIELD',
  'ERROR_IN_CRL_NEXT_UPDATE_FIELD',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'CERT_REVOKED',
  'INVALID_CA',
  'PATH_LENGTH_EXCEEDED',
  'INVALID_PURPOSE',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'HOSTNAME_MISMATCH',
  'EPROTO',
]);

// Codes of a connection that could not be made or broke off. Before the
// headers of the response they mean the connection failed, while reading
// the body that the answer was cut off.
const socketCodes: readonly string[] = Object.freeze([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

const timeoutCodes: readonly string[] = Object.freeze([
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// Reads a field of a thrown value without letting a getter or a proxy
// break the transport.
const field = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
};

// The code of a thrown value. Node.js reports a connection that failed for
// every address of a name as an AggregateError; its first error has the code.
const codeOf = (error: unknown): string | undefined => {
  const code = field(error, 'code');
  if (typeof code === 'string') return code;
  const errors = field(error, 'errors');
  if (Array.isArray(errors)) {
    const inner = field(errors[0], 'code');
    if (typeof inner === 'string') return inner;
  }
  return undefined;
};

/**
 * Gives the category of a failure on the outbound path. The own deadline
 * wins, then an abort by the caller, then the code of the thrown value. It
 * never reads the message, the stack, the headers or the cause.
 *
 * @param error - What undici or Node.js threw.
 * @param context - The phase of the request, the reason of the own
 *   deadline and whether the caller aborted.
 * @returns The category.
 * @example
 * ```ts
 * categoriseFailure(error, { phase: 'request', deadline, callerAborted: false });
 * // 'tls' for an untrusted certificate
 * ```
 */
export function categoriseFailure(
  error: unknown,
  context: FailureContext,
): FailureCategory {
  if (error === context.deadline) return 'timeout';
  if (context.callerAborted) return 'aborted';
  // Once the headers are in, a broken socket or any other failure cuts the
  // answer off.
  const broken = context.phase === 'request' ? 'connect' : 'interrupted';
  const other = context.phase === 'request' ? 'failed' : 'interrupted';
  const code = codeOf(error);
  if (code === undefined) return other;
  if (
    tlsCodes.includes(code) ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_')
  ) {
    return 'tls';
  }
  if (timeoutCodes.includes(code)) return 'timeout';
  if (code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') return 'too_large';
  return socketCodes.includes(code) ? broken : other;
}
