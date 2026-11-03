/**
 * Why a private folder could not be prepared, for the start over stdio
 * and `ecclium undo`, which both make the folders of the counters, the
 * day keys and the snapshots before they write (ADR 0031, ADR 0063). It
 * loads nothing but core, so that the first stage of the start can use it
 * before the server, its SDK and undici (ADR 0054).
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import {
  type PrivateFileCode,
  privateFileCodes,
} from '@ecclium/mcp-churchtools-core';
import { PrivateFileError } from '@ecclium/mcp-churchtools-core/composition';

/**
 * Reads the code of a refusal of core as an own data property. Any other
 * value gives undefined, and the caller then reports an internal error.
 *
 * @param error - What a preparation threw.
 * @returns The code of the refusal, or undefined.
 * @example
 * ```ts
 * const code = privateFileCodeOf(error);
 * if (code === undefined) throw error;
 * ```
 */
export function privateFileCodeOf(error: unknown): PrivateFileCode | undefined {
  if (
    typeof error !== 'object' ||
    error === null ||
    isProxy(error) ||
    !(error instanceof PrivateFileError)
  ) {
    return undefined;
  }
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'code')?.value;
  return privateFileCodes.find((known) => known === code);
}
