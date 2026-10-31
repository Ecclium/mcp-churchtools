/**
 * Tenant context, identity and the port that turns one into the other
 * (ADR 0003, ADR 0037).
 *
 * @packageDocumentation
 */

import type { Clock, Logger } from './logger.js';

/**
 * Identifies a tenant: one ChurchTools instance. Self-hosting serves exactly
 * one, named `default` (ADR 0003).
 *
 * The brand keeps a plain string, such as a value from the input of a tool,
 * from passing as a tenant by accident. Only the core and the
 * {@link TenantResolver} it uses create one, from a checked source. The
 * brand uses a string key, not a symbol, so that two copies of this package
 * agree on the type.
 */
export type TenantId = string & { readonly __ecclium: 'TenantId' };

/** Identifies one run of the runner. Created only by the core. */
export type RunId = string & { readonly __ecclium: 'RunId' };

/** Who acts: the service itself, a person, the runner or the operator. */
export type ActorKind = 'service' | 'user' | 'runner' | 'operator';

/**
 * The actor of a request or run. It goes into every audit event, so `id` is
 * a neutral name derived from source and subject of a checked sign-in,
 * over stdio `stdio:` and the subject from the configuration (ADR 0003,
 * ADR 0055). It is never the name or the e-mail address of a person.
 */
export interface Actor {
  /** Kind of actor. */
  readonly kind: ActorKind;
  /** Neutral identifier of the actor. */
  readonly id: string;
}

/**
 * How a request runs. It comes from how the server is started, never from a
 * request, a header or a parameter.
 */
export type Mode = 'interactive' | 'unattended' | 'operator';

/**
 * Level of redaction. `standard` is the default; `strict` also shortens
 * last names, puts pseudonyms in place of the IDs of persons and checks
 * free text (ADR 0069).
 */
export type RedactionLevel = 'off' | 'standard' | 'strict';

/** A licensed feature. The free core has none. */
export type FeatureKey = string;

/**
 * Everything a layer needs to know about the tenant of one request or run
 * (ADR 0003). The core creates it for every call of a tool and never keeps
 * it beyond that call, so a tool must not keep it either.
 *
 * Every field is read-only, and the core freezes the object and what it
 * holds. The address of the instance is a string and the features a list,
 * both of which can be frozen, where a `URL` or a `Set` could be changed in
 * place.
 */
export interface TenantContext {
  /** The tenant, from a checked source only. */
  readonly tenantId: TenantId;
  /** Origin of the ChurchTools instance, such as `https://example.church.tools`. */
  readonly instance: string;
  /** Who acts. */
  readonly actor: Actor;
  /** How the request runs, set by the composition root. */
  readonly mode: Mode;
  /** The run of the runner, if the request belongs to one. */
  readonly runId?: RunId;
  /** Level of redaction for this request. */
  readonly redaction: RedactionLevel;
  /** Whether write tools are off. They are by default. */
  readonly readOnly: boolean;
  /** Licensed features, empty in the free core. */
  readonly features: readonly FeatureKey[];
  /** The time as the core sees it. */
  readonly clock: Clock;
  /** Aborts the request, for example when the client cancels it. */
  readonly signal: AbortSignal;
  /** Logger bound to tenant and run. */
  readonly log: Logger;
}

/** Where a checked sign-in comes from (ADR 0037). */
export type IdentitySource = 'stdio' | 'bearer' | 'oauth';

/** What an identity may do at the server. */
export type Scope = 'read' | 'write';

/**
 * A checked sign-in at the server (ADR 0037). Over stdio the configuration
 * provides it; bearer tokens and OAuth follow with HTTP. Pipeline, audit and
 * any cache see only this, never how someone signed in.
 */
export interface Identity {
  /** How the identity was checked. */
  readonly source: IdentitySource;
  /** Subject of the sign-in, a neutral name over stdio. */
  readonly subject: string;
  /** Scopes of the sign-in. An identity without a known scope has none. */
  readonly scopes: readonly Scope[];
}

/** Tenant and actor that a {@link TenantResolver} assigns to an identity. */
export interface TenantAssignment {
  /** The tenant of the identity. */
  readonly tenantId: TenantId;
  /** The actor, derived from source and subject of the identity. */
  readonly actor: Actor;
}

/**
 * The one place that derives tenant and actor from a checked identity
 * (ADR 0003). The composition root provides it; an extension may replace it.
 */
export interface TenantResolver {
  /**
   * Assigns tenant and actor to a checked identity.
   *
   * @param identity - A checked sign-in, never input of a tool or a header.
   * @returns Tenant and actor, or `undefined` when no tenant belongs to the
   *   identity. The caller then refuses the request.
   */
  resolve(identity: Identity): Promise<TenantAssignment | undefined>;
}
