/**
 * The only place that registers tools, prompts and resources with the MCP
 * SDK. This folder is the only part of core that may import the SDK; the
 * serialize stage, the only stage that knows MCP types, will live here too.
 * The server reaches the mount through the subpath export `./mcp`, and the
 * entry point of core does not export it (ADR 0024).
 *
 * @packageDocumentation
 */
export {};
