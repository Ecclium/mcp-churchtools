/**
 * Raw ChurchTools client. Only the core modules listed in the architecture
 * rules import it. Tools and plugins reach ChurchTools through the tool
 * pipeline, and the entry point of core never passes the client on
 * (ADR 0024).
 *
 * @packageDocumentation
 */
export {};
