import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// The entry of the package is what the command line imports for
// `ecclium run-once` and the daemon: the pass, the run by hand, the
// preview, how a run is judged and the metrics file.
describe('@ecclium/mcp-churchtools-runner', () => {
  it('exports the pass, the run by hand, the preview, the judgement of a run and the metrics', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'auditEndOf',
      'metricStatuses',
      'previewRoutine',
      'readRunnerMetrics',
      'renderRunnerMetrics',
      'runByHand',
      'runDue',
      'runnerSeverities',
      'severityOf',
      'updateRunnerMetrics',
      'worseOf',
    ]);
    for (const name of [
      'auditEndOf',
      'previewRoutine',
      'readRunnerMetrics',
      'renderRunnerMetrics',
      'runByHand',
      'runDue',
      'severityOf',
      'updateRunnerMetrics',
      'worseOf',
    ] as const) {
      expect(entry[name]).toBeTypeOf('function');
    }
    expect(entry.runnerSeverities).toContain('ok');
    expect(entry.metricStatuses).toContain('refused');
  });
});
