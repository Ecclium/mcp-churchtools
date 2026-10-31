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
 * (ADR 0053). Prompts go the same way: no `registerPrompt`, but handlers of
 * `prompts/list` and `prompts/get` that fill the templates of the catalog
 * (ADR 0065). Every instance gets a JSON Schema validator that always
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
  type GetPromptRequest,
  type GetPromptResult,
  type jsonSchemaValidator,
  type ListPromptsResult,
  type ListToolsResult,
  McpServer,
  type McpServerFactory,
  type Prompt,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';

import { fixedSentences } from '../errors/index.js';
import { isStrictLevel } from '../redaction/pseudonym-form.js';
import type { ToolPipeline } from '../pipeline/index.js';
import type { ObjectJsonSchema, ToolCatalog } from '../registry/index.js';
import { deriveAnnotations } from './annotations.js';
import { deriveOutputSchema } from './schema.js';
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
const callFailedEvent = 'mcp_call_failed';

// Events of a request for a prompt. A prompt reaches no ChurchTools and
// needs no tenant, so it gets a log line and no audit line (ADR 0065). The
// line names a prompt only from the catalog, never a value of an argument.
const promptServedEvent = 'prompt_served';
const promptRefusedEvent = 'prompt_refused';
const promptUnknownEvent = 'prompt_unknown';

// The SDK sends the message of an error to the client as it is, so every
// refusal of a prompt is a fixed sentence. It names at most an argument
// from the catalog, whose name has the form of its pattern.
const unknownPromptSentence = 'This server offers no prompt of that name.';
const argumentsRefusedSentence =
  'The arguments are no object or hold a name this prompt does not have.';
const argumentRefusedSentence = (name: string): string =>
  `The argument ${name} is missing or does not fit. Its description in the list of prompts says what it takes.`;

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
 * Builds the mount from the catalog. It takes the input schema of every
 * tool as the registry derived it, derives the output schema and the
 * annotations once and freezes the list of tools and the list of prompts;
 * every instance the factory builds shares both.
 *
 * Each instance is built in a fixed order: the server with the throwing
 * validator and without capabilities, then the capabilities `tools` and
 * `prompts`, both with `listChanged: false`, before the handlers, because
 * registering a handler checks the capability, then the handlers of
 * `tools/list`, `tools/call`, `prompts/list` and `prompts/get` and a
 * handler of errors that writes one fixed event. The capability `prompts`
 * stands also when the catalog offers no prompt, so the answer to the
 * handshake does not change with the toolsets.
 *
 * A call resolves tenant and actor for the identity of the start; an answer
 * of the resolver that is no object, or a rejection, counts as no tenant,
 * which the pipeline audits and ends with `auth`. So does an object the
 * pipeline cannot read without running its code, such as a proxy or one
 * with a getter (ADR 0024). The mount waits for the resolver only until
 * the client cancels the call or the connection ends; the call then runs
 * into the pipeline without a tenant, which ends it as `network` and
 * audits it. A call without arguments counts as one with none, as in the
 * tools the SDK registers itself. The handler never throws: the SDK would
 * send the message of an error as it is. A call that fails in the mount
 * itself gets the fixed sentence of `internal`, and the logger gets the
 * fixed event `mcp_call_failed` without fields.
 *
 * `prompts/list` gives every prompt of the catalog with its title, its
 * description and its arguments, all required, and no cursor. `prompts/get`
 * fills the template of the prompt with the checked values, as one message
 * of the person, and writes `prompt_served`. An unknown name (event
 * `prompt_unknown`) or arguments that do not fit (event `prompt_refused`
 * with the code `validation`) end as invalid params with a fixed sentence.
 *
 * @param options - Catalog, pipeline, identity, resolver, the settings of
 *   every call, the logger and the version.
 * @returns The mount, frozen.
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
  // In the level strict an ID of a person is a pseudonym in input and
  // output, a string (ADR 0069).
  const pseudonyms = isStrictLevel(redaction);
  for (const entry of catalog.list()) {
    const outputSchema = deriveOutputSchema(entry.shape, redaction);
    outputSchemas.set(entry.name, outputSchema);
    tools.push(
      Object.freeze({
        name: entry.name,
        description: entry.description,
        inputSchema: pseudonyms ? entry.strictInputSchema : entry.inputSchema,
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
  const note = (
    level: 'info' | 'warn',
    event: string,
    fields?: { readonly prompt: string; readonly code?: 'validation' },
  ): void => {
    try {
      logger[level](event, fields);
    } catch {
      // The answer to the client does not depend on the log.
    }
  };

  const prompts: Prompt[] = [];
  for (const entry of catalog.prompts()) {
    const args: NonNullable<Prompt['arguments']> = entry.arguments.map(
      (argument) =>
        Object.freeze({
          name: argument.name,
          description: argument.description,
          required: true,
        }),
    );
    Object.freeze(args);
    prompts.push(
      Object.freeze({
        name: entry.name,
        title: entry.title,
        description: entry.description,
        arguments: args,
      }),
    );
  }
  Object.freeze(prompts);

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

  const listPrompts = (): ListPromptsResult => ({ prompts });

  // Throws only the refusals below, each with a fixed sentence, which the
  // SDK sends as invalid params.
  const getPrompt = (request: GetPromptRequest): GetPromptResult => {
    const { name } = request.params;
    const entry = catalog.prompt(name);
    if (entry === undefined) {
      note('warn', promptUnknownEvent);
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        unknownPromptSentence,
      );
    }
    const filling = entry.fill(request.params.arguments);
    if (!filling.ok) {
      note('warn', promptRefusedEvent, {
        prompt: entry.name,
        code: 'validation',
      });
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        filling.argument === undefined
          ? argumentsRefusedSentence
          : argumentRefusedSentence(filling.argument),
      );
    }
    note('info', promptServedEvent, { prompt: entry.name });
    return {
      description: entry.description,
      messages: [
        { role: 'user', content: { type: 'text', text: filling.text } },
      ],
    };
  };

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
      // The SDK would send the message of the error to the client. The
      // answer points the operator to the log, and no audit line covers
      // this path, so the fixed event is the only trace of the call.
      report(callFailedEvent);
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
    // and before the connection, after which the SDK refuses it. The lists
    // of tools and prompts never change while the process runs.
    instance.server.registerCapabilities({
      tools: { listChanged: false },
      prompts: { listChanged: false },
    });
    instance.server.setRequestHandler('tools/list', listTools);
    instance.server.setRequestHandler('tools/call', (request, ctx) =>
      callTool(instance, request, ctx),
    );
    instance.server.setRequestHandler('prompts/list', listPrompts);
    instance.server.setRequestHandler('prompts/get', getPrompt);
    instance.server.onerror = () => {
      report(instanceErrorEvent);
    };
    return instance;
  };

  return Object.freeze({ __proto__: null, factory });
}
