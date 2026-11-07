/**
 * The settings of the smoke test for writing, from the environment alone,
 * before any request.
 *
 * It reads the same variables as the probes of the write account, because
 * the same guard checks them (ADR 0049): the base URL, the switch that
 * must equal the first label of the host, the token file of the write
 * account and no token of another account, the state of 00-inventory, the
 * write area, the probe calendar and the probe resource. Two state files
 * keep what the server creates, so that 07-wiki-cleanup and
 * 11-calendar-write can remove it later: the page in
 * `ECCLIUM_SPIKE_WRITE_STATE_FILE`, the appointments and bookings in
 * `ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE`. Both must be new.
 *
 * @packageDocumentation
 */
import { isAbsolute } from 'node:path';

import {
  checkNodeEnvironment,
  readOrigin,
  readState,
  readToken,
  statePath,
  type Environment,
  type SpikeState,
} from '../spike/lib/env.mts';
import { SpikeError } from '../spike/lib/errors.mts';
import {
  checkWriteEnvironment,
  type WriteSettings,
} from '../spike/lib/gate.mts';
import type { CalendarArea } from '../spike/lib/http.mts';
import { checkNewWriteState } from '../spike/lib/write-state.mts';

/** What the smoke test for writing runs with. */
export interface SmokeWriteSettings {
  readonly origin: string;
  /** What the guard checks: write area, state path, calendar and resource. */
  readonly write: WriteSettings & { readonly calendarArea: CalendarArea };
  /** The token of the write account, to look for it in every output. */
  readonly token: string;
  /** The absolute path of its file, which the server gets. */
  readonly tokenFile: string;
  /** The state of 00-inventory, for the checks of the guard. */
  readonly state: SpikeState;
  /** Where the appointments and bookings of the run are kept. */
  readonly calendarStatePath: string;
}

/**
 * Reads and checks the settings.
 *
 * @param env - The environment of the process.
 * @returns The settings.
 * @throws {SpikeError} If a variable is missing, wrong or names a file that is unsafe or exists already.
 */
export function readSmokeWriteSettings(env: Environment): SmokeWriteSettings {
  checkNodeEnvironment(env);
  const origin = readOrigin(env);
  const write = checkWriteEnvironment(env, origin);
  const { calendarArea } = write;
  if (calendarArea === undefined) {
    throw new SpikeError('KONFIGURATION', 'schreibSmokeKalenderFehlt');
  }
  const tokenFile = env['ECCLIUM_SPIKE_WRITE_TOKEN_FILE'] ?? '';
  const token = readToken(env, 'ECCLIUM_SPIKE_WRITE_TOKEN_FILE');
  // The server takes only an absolute path (ADR 0055); a relative one
  // would point elsewhere from its folder.
  if (!isAbsolute(tokenFile)) {
    throw new SpikeError('KONFIGURATION', 'schreibSmokeTokenRelativ');
  }
  const calendarStatePath =
    env['ECCLIUM_SPIKE_WRITE_CALENDAR_STATE_FILE'] ?? '';
  if (calendarStatePath === '') {
    throw new SpikeError('KONFIGURATION', 'schreibSmokeKalenderStateFehlt');
  }
  if (calendarStatePath === write.writeStatePath) {
    throw new SpikeError('KONFIGURATION', 'schreibSmokeStateGleich');
  }
  checkNewWriteState(write.writeStatePath);
  checkNewWriteState(calendarStatePath);
  const state = readState(statePath(env), origin);
  return {
    origin,
    write: { ...write, calendarArea },
    token,
    tokenFile,
    state,
    calendarStatePath,
  };
}
