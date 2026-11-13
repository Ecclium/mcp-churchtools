import { describe, expect, it } from 'vitest';

import * as entry from './index.js';

// The entry of the package is what the command line imports for
// `ecclium run-once` and the daemon: the pass, the run by hand, the
// preview, how a run is judged, the metrics file and the ping of a pass.
describe('@ecclium/mcp-churchtools-runner', () => {
  it('exports the pass, the run by hand, the preview, the judgement of a run, the metrics and the ping', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'auditEndOf',
      'metricStatuses',
      'pingOf',
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
      'pingOf',
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
