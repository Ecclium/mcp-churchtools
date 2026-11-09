/**
 * Builds the language models of the runner from the checked providers of
 * the configuration (ADR 0033). This is the composition root of the way
 * to a model: for each provider it reads the file of the key, builds a
 * transport with exactly the origin and path of its endpoint, the adapter
 * for chat interfaces in the style of OpenAI on it, and wraps the adapter
 * in the guard of core. The engine gets only guarded models, by alias.
 *
 * The keys are read here and not by the loader of the configuration, so
 * that the server over stdio, which needs no model, never holds one, and
 * a new key takes effect with the next build. The runner binds this in a
 * later step; nothing calls it at the start of the server.
 *
 * @packageDocumentation
 */
import {
  type GuardedModel,
  guardModelProvider,
  type ProviderSettings,
  readProviderKey,
  type TokenFileCode,
} from '@ecclium/mcp-churchtools-core';
import {
  createModelHttpTransport,
  type ModelHttpTransportOptions,
  type ModelTransport,
} from '@ecclium/mcp-churchtools-core/http';
import type { Clock, Logger } from '@ecclium/mcp-churchtools-plugin-api';
import { createOpenAiCompatibleProvider } from '@ecclium/mcp-churchtools-workflows';

import { userAgent } from '../version.js';

/** What the models are built from. */
export interface ModelComposeOptions {
  /** The checked providers of the configuration. */
  readonly providers: readonly ProviderSettings[];
  /** The logger of the transports, bound to the tenant. */
  readonly logger: Logger;
  /** The clock for the duration in the log. */
  readonly clock: Clock;
  /** Only for tests: reads the file of a key. */
  readonly readKey?: typeof readProviderKey;
  /** Only for tests: builds the transport to an endpoint. */
  readonly createTransport?: (
    options: ModelHttpTransportOptions,
  ) => ModelTransport;
}

/** The guarded models by alias, or the provider whose key was refused. */
export type ModelComposeResult =
  | {
      readonly ok: true;
      /** The guarded models, by the alias a routine names. */
      readonly models: ReadonlyMap<string, GuardedModel>;
      /** Closes the transports of every model. */
      close(): Promise<void>;
    }
  | {
      readonly ok: false;
      /** The alias of the provider whose key was refused. */
      readonly alias: string;
      /** Why the file of its key was refused, such as `token_file_mode`. */
      readonly code: TokenFileCode;
    };

// Destroys the transports built so far, without waiting. A failure to
// close a pool must not end the process while a refused key is reported.
const destroyAll = (transports: readonly ModelTransport[]): void => {
  for (const transport of transports) {
    transport.destroy().catch(() => undefined);
  }
};

/**
 * Builds the guarded model of each provider. A key that its file does not
 * give stops the build, and the transports built so far are destroyed.
 *
 * @param options - The providers, logger and clock.
 * @returns The models by alias with a function that closes them, or the
 *   alias and the code of the refused key file.
 * @throws {EccliumError} `config` when the information of a provider does
 *   not pass the guard, which the check of the configuration already
 *   prevents.
 * @example
 * ```ts
 * const built = composeModelProviders({
 *   providers: config.providers ?? [],
 *   logger,
 *   clock: systemClock,
 * });
 * if (!built.ok) report(built.alias, built.code);
 * ```
 */
export function composeModelProviders(
  options: ModelComposeOptions,
): ModelComposeResult {
  const readKey = options.readKey ?? readProviderKey;
  const build = options.createTransport ?? createModelHttpTransport;
  const transports: ModelTransport[] = [];
  const models = new Map<string, GuardedModel>();
  try {
    for (const provider of options.providers) {
      const key = readKey(provider.apiKeyFile);
      if (!key.ok) {
        destroyAll(transports);
        return Object.freeze({
          ok: false,
          alias: provider.alias,
          code: key.code,
        });
      }
      const transport = build({
        endpoint: provider.endpoint,
        key: key.value,
        userAgent,
        logger: options.logger,
        clock: options.clock,
      });
      transports.push(transport);
      models.set(
        provider.alias,
        guardModelProvider(
          createOpenAiCompatibleProvider({
            info: provider.info,
            nativeStructuredOutput: provider.structuredOutput,
            transport,
          }),
        ),
      );
    }
  } catch (error) {
    destroyAll(transports);
    throw error;
  }
  return Object.freeze({
    ok: true,
    models,
    close: async (): Promise<void> => {
      await Promise.all(transports.map((transport) => transport.close()));
    },
  });
}
