import { describe, expect, it } from 'vitest';

import { originCodes } from '../http/index.js';
import { isEventName } from '../logger/index.js';
import { configProblemCodes, configWarningCodes } from './codes.js';
import { tokenFileCodes } from './token-file.js';

describe('the codes of the configuration', () => {
  it('are frozen, each once, and no code is a problem and a warning', () => {
    const all = [...configProblemCodes, ...configWarningCodes];
    expect(Object.isFrozen(configProblemCodes)).toBe(true);
    expect(Object.isFrozen(configWarningCodes)).toBe(true);
    expect(new Set(all).size).toBe(all.length);
  });

  // The log reports a code as the event config_<code>.
  it('fit the name of a log event behind a prefix', () => {
    for (const code of [...configProblemCodes, ...configWarningCodes]) {
      expect(isEventName(`config_${code}`), code).toBe(true);
    }
  });

  it('hold every code of the address and of the token file', () => {
    for (const code of [...originCodes, ...tokenFileCodes]) {
      expect(configProblemCodes, code).toContain(code);
    }
  });
});
