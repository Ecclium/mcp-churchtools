/**
 * The contract of a prompt: a fixed template a person picks in the client,
 * whose text then stands in the conversation as the message of that person
 * (ADR 0065). A prompt is data, not code: when a client asks for one, no
 * code of the plugin runs. The core checks the arguments by their kind and
 * puts their values into the template.
 *
 * @packageDocumentation
 */

import type { ToolName } from './tool.js';

/**
 * The form of the name of a prompt: a lower-case letter, then lower-case
 * letters, digits and underscores, 63 characters at most. A client shows
 * it, Claude Code as a command such as `/mcp__ecclium__dienstplan_wochenende`.
 */
export const promptNamePattern: RegExp = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * The form of the name of an argument, which also stands in the template
 * as its placeholder `{name}`: a lower-case letter, then lower-case
 * letters, digits and underscores, 32 characters at most.
 */
export const promptArgumentNamePattern: RegExp = /^[a-z][a-z0-9_]{0,31}$/;

/** The longest title of a prompt, in UTF-16 code units. */
export const maxPromptTitleLength = 100;

/** The longest description of a prompt, in UTF-16 code units. */
export const maxPromptDescriptionLength = 500;

/** The longest description of an argument, in UTF-16 code units. */
export const maxPromptArgumentDescriptionLength = 300;

/**
 * The longest template, in UTF-16 code units. A template of this length
 * with the longest values of its arguments still fits easily into one
 * message of the protocol.
 */
export const maxPromptTextLength = 8000;

/** The most arguments of one prompt. */
export const maxPromptArguments = 5;

/** The most tools one prompt relies on. */
export const maxPromptTools = 10;

/**
 * The highest `maxLength` of an argument of the kind `text`, in UTF-16
 * code units.
 */
export const maxPromptTextArgumentLength = 2000;

/** A day of the week as ISO 8601 counts it, 1 for Monday to 7 for Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * An argument of the kind `date`: a day as `YYYY-MM-DD` that exists, from
 * 1970 to 9999, and, with `weekday`, only a day of that weekday.
 */
export interface PromptDateArgument {
  /** Name of the argument and of its placeholder. */
  readonly name: string;
  /** What the person enters, in the language of the prompt. */
  readonly description: string;
  /** The kind. */
  readonly kind: 'date';
  /** The only weekday the core takes, such as 6 for a Saturday. */
  readonly weekday?: IsoWeekday;
}

/**
 * An argument of the kind `text`: what the person writes, with invisible
 * characters removed and line breaks as LF, at least one character and at
 * most `maxLength`.
 */
export interface PromptTextArgument {
  /** Name of the argument and of its placeholder. */
  readonly name: string;
  /** What the person enters, in the language of the prompt. */
  readonly description: string;
  /** The kind. */
  readonly kind: 'text';
  /**
   * The longest value the core takes, 1 to
   * {@link maxPromptTextArgumentLength}.
   */
  readonly maxLength: number;
}

/**
 * An argument of a prompt. Every argument is required: the core refuses a
 * request that leaves one out. The kinds are fixed in the core, so the
 * check of a value never runs code of a plugin.
 */
export type PromptArgument = PromptDateArgument | PromptTextArgument;

/**
 * A prompt as a plugin adds it. The core checks it when it is added and
 * offers it only while it offers every tool in `tools`, so a prompt never
 * asks for a tool the client does not see.
 *
 * The texts are for the person, in the language of the congregation. They
 * are static, hold no content of a tenant and name no tool: the person
 * reads the text as their own message, and the model finds the tools by
 * their descriptions. The core adds a fixed sentence to every text that
 * content of ChurchTools is data, which no prompt can leave out.
 */
export interface PromptDefinition {
  /** Name of the prompt, in the form of {@link promptNamePattern}. */
  readonly name: string;
  /** The title a client shows, up to {@link maxPromptTitleLength}. */
  readonly title: string;
  /**
   * What the prompt does, for the person who picks it, up to
   * {@link maxPromptDescriptionLength}.
   */
  readonly description: string;
  /**
   * The tools the steps of the text rely on, 1 to {@link maxPromptTools},
   * each once. Every one must be in the catalog.
   */
  readonly tools: readonly ToolName[];
  /** The arguments, at most {@link maxPromptArguments}, each name once. */
  readonly arguments: readonly PromptArgument[];
  /**
   * The template, up to {@link maxPromptTextLength}. Braces stand only in
   * placeholders `{name}`, each placeholder names an argument, and each
   * argument appears at least once. Lines end with LF.
   */
  readonly text: string;
}
