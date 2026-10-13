/**
 * What a tool may read from ChurchTools.
 *
 * @packageDocumentation
 */

/**
 * The account the server reads with, as `GET /api/whoami` describes it
 * (`docs/research/churchtools-api.md`, F18). Only the fields a tool needs.
 */
export interface Me {
  /** ID of the person behind the account. */
  readonly id: number;
  /** First name. */
  readonly firstName: string;
  /** Last name. */
  readonly lastName: string;
  /** E-mail address. */
  readonly email: string;
}

/** A right that is set: `true`, or a list of numbers, never empty. */
export type RightValue = true | readonly number[];

/**
 * The rights of the account by module and name, such as `churchwiki` and
 * `view` (`docs/research/churchtools-api.md`, F5). ChurchTools lists every
 * right, also those the account lacks; this holds only the set ones.
 */
export type GrantedRights = Readonly<
  Record<string, Readonly<Record<string, RightValue>>>
>;

/**
 * The rights of the account, or `unknown` when the answer of ChurchTools has
 * a structure the core does not know. An unknown structure blocks writing,
 * never reading.
 */
export type Permissions =
  | { readonly kind: 'known'; readonly granted: GrantedRights }
  | { readonly kind: 'unknown' };

/**
 * Reads from ChurchTools for one call of a tool, with the account of the
 * server and through the one outbound path of the core. A tool never sees a
 * token and cannot choose what host it reads from. The core revokes it when
 * the call ends: every method then rejects.
 *
 * It starts with what the first tools need and grows with the tools. Its
 * form may change until version 1.0 of this package.
 */
export interface ReadApi {
  /**
   * Reads the account of the server.
   *
   * @returns The account.
   */
  whoami(): Promise<Me>;
  /**
   * Reads the rights of the account of the server.
   *
   * @returns The set rights, or `unknown` for an unknown structure.
   */
  permissions(): Promise<Permissions>;
}
