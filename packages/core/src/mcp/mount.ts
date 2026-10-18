/**
 * The mount: the only place that registers with the MCP SDK (ADR 0024,
 * ADR 0053). This folder is the only part of core that may import the
 * SDK; the serialize stage, the only stage that knows MCP types, lives
 * next to it in `serialize.ts`. The server reaches the mount through the
 * subpath export `./mcp`, and the entry point of core does not export it.
 *
 * The mount registers no tool with `registerTool`. It answers `tools/list`
 * and `tools/call` with two handlers of its own, so an unknown tool and an
 * input that does not fit reach the pipeline and its audit instead of
 * ending in the SDK, and no object exists that could swap a handler later
 * (ADR 0053). Every instance gets a JSON Schema validator that always
 * throws, so the bundled Ajv never compiles a schema for it (ADR 0059).
 *
 * @packageDocumentation
 */
import type {
  FeatureKey,
  Identity,
  Logger,
  Mode,
  RedactionLevel,
  TenantAssignment,
  TenantResolver,
} from '@ecclium/mcp-churchtools-plugin-api';
import {
  type CallToolRequest,
  type CallToolResult,
  type jsonSchemaValidator,
  type ListToolsResult,
  McpServer,
  type McpServerFactory,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';

import { fixedSentences } from '../errors/index.js';
import type { ToolPipeline } from '../pipeline/index.js';
import type { ToolCatalog } from '../registry/index.js';
import { deriveAnnotations } from './annotations.js';
import {
  deriveInputSchema,
  deriveOutputSchema,
  type ObjectJsonSchema,
} from './schema.js';
import { serializeOutcome } from './serialize.js';

/** What the composition root builds the mount from, once at the start. */
export interface McpMountOptions {
  /** The frozen catalog of tools, the same the pipeline runs. */
  readonly catalog: ToolCatalog;
  /** The pipeline every call runs through. */
  readonly pipeline: ToolPipeline;
  /** The checked identity of the start, the same for every call. */
  readonly identity: Identity;
  /** Assigns tenant and actor to the identity, once per call. */
  readonly resolver: TenantResolver;
  /** How calls run, set by the composition root only. */
  readonly mode: Mode;
  /** The level of redaction of every call. */
  readonly redaction: RedactionLevel;
  /** Whether the server only reads. */
  readonly readOnly: boolean;
  /** Receives the fixed events of the mount, never a message of the SDK. */
  readonly logger: Logger;
  /**
   * The version of the server, which the client reads in `serverInfo`: 1
   * to 32 printable ASCII characters without spaces.
   */
  readonly version: string;
}

/** The mount, built once at the start. */
export interface McpMount {
  /**
   * Builds one instance of the MCP server for one connection over stdio,
   * or for one request over HTTP. It is cheap and has no side effect, so
   * the SDK may call it twice when a client probes with `server/discover`
   * and falls back to `initialize` (ADR 0053). The instance it returns is
   * for the serving entry of the SDK only.
   */
  readonly factory: McpServerFactory;
}

// The name in serverInfo. It is short, because the 2026 era repeats
// serverInfo in the _meta of every result, within the reserve of 1 KiB that
// the pipeline keeps for the rest of the message (ADR 0024).
const serverName = 'ecclium-mcp-churchtools';

// The free core has no licensed features.
const noFeatures: readonly FeatureKey[] = Object.freeze([]);

// The answer of a call that failed in the mount itself, with the fixed
// sentence only. The pipeline never rejects, so this stays a guard.
const internalResult = serializeOutcome(
  Object.freeze({
    ok: false,
    error: Object.freeze({
      code: 'internal',
      message: fixedSentences.internal,
    }),
  }),
);

// Events of the mount. They carry no field: the SDK puts what a client sent
// into the message of an error, so the message never reaches the log.
const validatorEvent = 'mcp_validator_refused';
const instanceErrorEvent = 'mcp_server_error';

const isVersion = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code > 0x7e) return false;
  }
  return true;
};

/**
 * Builds the mount from the catalog. It derives the input schema, the
 * output schema and the annotations of every tool once and freezes the list
 * of tools; every instance the factory builds shares that list.
 *
 * Each instance is built in a fixed order: the server with the throwing
 * validator and without capabilities, then the capability `tools` with
 * `listChanged: false` before the handlers, because registering a handler
 * checks the capability, then the handlers of `tools/list` and
 * `tools/call` and a handler of errors that writes one fixed event.
 *
 * A call resolves tenant and actor for the identity of the start; an answer
 * of the resolver that is no object, or a rejection, counts as no tenant,
 * which the pipeline audits and ends with `auth`. So does an object the
 * pipeline cannot read without running its code, such as a proxy or one
 * with a getter (ADR 0024). The mount waits for the resolver only until
 * the client cancels the call or the connection ends; the call then runs
 * into the pipeline without a tenant, which ends it as `network` and
 * audits it. A call without arguments counts as one with
 * none, as in the tools the SDK registers itself. The handler never throws:
 * the SDK would send the message of an error as it is.
 *
 * @param options - Catalog, pipeline, identity, resolver, the settings of
 *   every call, the logger and the version.
 * @returns The mount, frozen.
 * @throws {RegistryRefusal} With the reason `tool_input` when the input
 *   schema of a tool cannot be advertised. The start then stops.
 * @throws {TypeError} When the version breaks its form; the message never
 *   holds the value.
 * @example
 * ```ts
 * const mount = createMcpMount({ catalog, pipeline, identity, resolver,
 *   mode: 'interactive', redaction: 'standard', readOnly: true, logger,
 *   version: '0.1.0' });
 * serveStdio(mount.factory, { legacy: 'serve' });
 * ```
 */
export function createMcpMount(options: McpMountOptions): McpMount {
  const { catalog, pipeline, identity, resolver, logger, version } = options;
  const { mode, redaction, readOnly } = options;
  if (!isVersion(version)) {
    throw new TypeError('The version of the server is invalid.');
  }
  const serverInfo = Object.freeze({ name: serverName, version });

  const tools: Tool[] = [];
  const outputSchemas = new Map<string, ObjectJsonSchema>();
  for (const entry of catalog.list()) {
    const inputSchema = deriveInputSchema(entry);
    const outputSchema = deriveOutputSchema(entry.shape);
    outputSchemas.set(entry.name, outputSchema);
    tools.push(
      Object.freeze({
        name: entry.name,
        description: entry.description,
        inputSchema,
        outputSchema,
        annotations: deriveAnnotations(entry.meta),
      }),
    );
  }
  Object.freeze(tools);

  // A failing logger never breaks the protocol.
  const report = (event: string): void => {
    try {
      logger.error(event);
    } catch {
      // Nothing else is left to tell.
    }
  };

  // Only elicitInput of the 2025 era asks the validator of an instance,
  // and fromJsonSchema never does; the rule [arch:mcp-json-schema] keeps
  // both out of the packages (ADR 0059). Should code reach it anyway, it
  // throws before Ajv compiles anything, and the event says so.
  const refusingValidator: jsonSchemaValidator = Object.freeze({
    getValidator: (): never => {
      report(validatorEvent);
      throw new Error('JSON Schema validation is switched off (ADR 0059).');
    },
  });

  // The question to the resolver runs against the signal of the request.
  // A resolver of an extension that never answers would otherwise hold the
  // call before the pipeline and its audit, beyond a cancellation and the
  // end of the connection, both of which abort the signal. An abort counts
  // as no tenant, and the pipeline ends the call as network (ADR 0024).
  const resolveAssignment = async (
    signal: AbortSignal,
  ): Promise<TenantAssignment | undefined> => {
    // Removes the listener once either side has settled.
    const settled = new AbortController();
    try {
      // An aborted signal fires no further event, so the race below could
      // not end; the catch makes this no tenant as well.
      signal.throwIfAborted();
      const aborted = new Promise<undefined>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve(undefined);
          },
          { once: true, signal: settled.signal },
        );
      });
      const answered = Promise.resolve(resolver.resolve(identity));
      // A rejection after the abort must not end as an unhandled one.
      answered.catch(() => undefined);
      const answer: unknown = await Promise.race([answered, aborted]);
      return typeof answer === 'object' &&
        answer !== null &&
        !Array.isArray(answer)
        ? (answer as TenantAssignment)
        : undefined;
    } catch {
      return undefined;
    } finally {
      settled.abort();
    }
  };

  const listTools = (): ListToolsResult => ({ tools });

  const callTool = async (
    instance: McpServer,
    request: CallToolRequest,
    ctx: ServerContext,
  ): Promise<CallToolResult> => {
    try {
      const { name } = request.params;
      // A call without arguments counts as one with none, as in the tools
      // the SDK registers itself; the pipeline checks it like any input.
      const input = request.params.arguments ?? {};
      const { signal } = ctx.mcpReq;
      const assignment = await resolveAssignment(signal);
      const outcome = await pipeline.call(
        name,
        input,
        Object.freeze({
          assignment,
          mode,
          redaction,
          readOnly,
          features: noFeatures,
          signal,
        }),
      );
      return instance.server.projectCallToolResult(
        serializeOutcome(outcome),
        outputSchemas.get(name),
      );
    } catch {
      // The SDK would send the message of the error to the client.
      return internalResult;
    }
  };

  const factory: McpServerFactory = () => {
    // No capabilities here: with them, the SDK installs handlers of its
    // own, which check input and output before any code of the mount runs
    // (ADR 0053).
    const instance = new McpServer(serverInfo, {
      jsonSchemaValidator: refusingValidator,
    });
    // Before the handlers, because registering one checks the capability,
    // and before the connection, after which the SDK refuses it. The list
    // of tools never changes while the process runs.
    instance.server.registerCapabilities({ tools: { listChanged: false } });
    instance.server.setRequestHandler('tools/list', listTools);
    instance.server.setRequestHandler('tools/call', (request, ctx) =>
      callTool(instance, request, ctx),
    );
    instance.server.onerror = () => {
      report(instanceErrorEvent);
    };
    return instance;
  };

  return Object.freeze({ __proto__: null, factory });
}
