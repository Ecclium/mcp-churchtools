// Child process for tests/quota-processes.test.mts. It asks the gate of the
// policy of core, run from source, about writes to one category of the
// wiki whose entry allows a number of writes per day, with the store of
// quotas in the folder of state the test gives (ADR 0032, ADR 0063).
// With `commit` it commits as often as the test says, from the moment the
// test gives, with a pause after each so that another child gets the lock
// in between, and prints for each whether the policy let the write go. With
// `plan` it plans once and prints the reason the write would wait in the
// queue, or `go`.
import process from 'node:process';

import {
  isEccliumError,
  type TenantContext,
} from '../../../packages/plugin-api/src/index.ts';
import { checkPolicy } from '../../../packages/core/src/policy/check.ts';
import { createFileQuotaStore } from '../../../packages/core/src/quota/file-store.ts';
import { createPolicyGate } from '../../../packages/core/src/write/policy-gate.ts';
import type { IntentRules } from '../../../packages/core/src/write/rules.ts';

const [
  stateDir = '',
  phase = 'commit',
  maxPerDay = '1',
  times = '1',
  startAt = '0',
  pauseMs = '0',
] = process.argv.slice(2);

const tool = 'ct_wiki_page_create';
const checked = checkPolicy({
  schema: 'policy.v1',
  interactive: {
    targets: [
      {
        target: { kind: 'wiki_category', id: 12, name: 'Berichte' },
        tools: [tool],
        maxPerDay: Number(maxPerDay),
      },
    ],
  },
});
if (!checked.ok) throw new Error(checked.code);

const gate = createPolicyGate({
  policy: checked.policy,
  quota: createFileQuotaStore({
    stateDir,
    clock: { now: () => Date.now() },
    pid: process.pid,
    host: 'test-host',
  }),
  clock: { now: () => Date.now() },
  categoryName: () => Promise.resolve('Berichte'),
  calendarName: () => Promise.resolve(undefined),
  resourceName: () => Promise.resolve(undefined),
});
const quiet = (): void => undefined;
const ctx = {
  tenantId: 'default',
  actor: { kind: 'service', id: 'stdio:local-stdio' },
  readOnly: false,
  mode: 'interactive',
  log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
} as unknown as TenantContext;
const rules = {
  target: { kind: 'wiki_category', key: '12' },
  requiredRights: [],
  sensitivity: 'personal',
  unattended: 'policy',
  reversible: 'snapshot',
  replayGuard: 'marker',
  module: 'core',
  alwaysQueue: false,
  runs: true,
} as unknown as IntentRules;

if (phase === 'plan') {
  const reason = await gate.check(ctx, tool, rules, {}, 'plan');
  process.stdout.write(`${JSON.stringify(reason ?? 'go')}\n`);
} else {
  await new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(startAt) - Date.now()));
  });
  const outcomes: string[] = [];
  for (let index = 0; index < Number(times); index += 1) {
    try {
      await gate.check(ctx, tool, rules, {}, 'commit');
      outcomes.push('go');
    } catch (error) {
      if (!isEccliumError(error) || error.code !== 'policy_denied') {
        throw error;
      }
      outcomes.push('refused');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, Number(pauseMs));
    });
  }
  process.stdout.write(`${JSON.stringify(outcomes)}\n`);
}
