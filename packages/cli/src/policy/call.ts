/**
 * The forms of a call of `ecclium policy init` (ADR 0032): `--interactive`
 * for the interactive part, or `--routine <Routine> --credential <Alias>`
 * for the entry of a routine. The command line checks the form before it
 * loads the command, and the command checks it again.
 *
 * @packageDocumentation
 */

/** What is wrong with the form of a call of `ecclium policy init`. */
export type PolicyInitCallProblem =
  | 'mode_missing'
  | 'mode_both'
  | 'credential_missing'
  | 'credential_interactive'
  | 'routine_invalid'
  | 'credential_invalid';

/** The options of a call of `ecclium policy init`. */
export interface PolicyInitCall {
  readonly interactive: boolean;
  readonly routine?: string | undefined;
  readonly credential?: string | undefined;
}

// The ID of a routine and an alias of the policy have the same form:
// lower case letters, digits and hyphens, at most 63 characters. An alias
// becomes part of the name of a token file, so it is never a path.
const idPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * What is wrong with the form of a call, before any file is read.
 *
 * @param call - The options of the call.
 * @returns The problem, or undefined for a call of one of the two forms.
 * @example
 * ```ts
 * policyInitCallProblem({ interactive: false, routine: 'dienstplan-report' }); // 'credential_missing'
 * ```
 */
export function policyInitCallProblem(
  call: PolicyInitCall,
): PolicyInitCallProblem | undefined {
  const { routine, credential } = call;
  if (call.interactive && routine !== undefined) return 'mode_both';
  if (call.interactive) {
    return credential === undefined ? undefined : 'credential_interactive';
  }
  if (routine === undefined) return 'mode_missing';
  if (credential === undefined) return 'credential_missing';
  if (!idPattern.test(routine)) return 'routine_invalid';
  return idPattern.test(credential) ? undefined : 'credential_invalid';
}
