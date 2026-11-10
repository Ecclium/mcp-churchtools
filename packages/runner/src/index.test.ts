import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// The entry of the package is what the command line and later the daemon
// import: the pass, the run by hand, the preview and how a run is judged.
describe('@ecclium/mcp-churchtools-runner', () => {
  it('exports the pass, the run by hand, the preview and the judgement of a run', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'auditEndOf',
      'previewRoutine',
      'runByHand',
      'runDue',
      'runnerSeverities',
      'severityOf',
      'worseOf',
    ]);
    for (const name of [
      'auditEndOf',
      'previewRoutine',
      'runByHand',
      'runDue',
      'severityOf',
      'worseOf',
    ] as const) {
      expect(entry[name]).toBeTypeOf('function');
    }
    expect(entry.runnerSeverities).toContain('ok');
  });
});
