/**
 * The reader of YAML for the file of the policy (ADR 0032).
 *
 * Where it stands: at the start, while the configuration is loaded. The
 * reader of the file hands over the text it checked and decoded, this
 * module turns it into plain values, and the schema of `policy.v1` checks
 * those next. Planning and committing a write later only see the checked
 * policy.
 *
 * Why it is narrow: the policy decides which targets a write may reach, so
 * a feature of YAML that makes one text mean two things has no place in
 * it. The reader takes YAML 1.2 with the schema `core` and exactly one
 * document, and refuses a key twice in one map, anchors and aliases, tags,
 * directives such as `%YAML 1.1`, keys that are not text and every
 * warning of the parser. Merge keys are off, so `<<` stays an unknown key
 * that the schema refuses.
 *
 * It is the only module that imports `yaml`, which a rule of
 * dependency-cruiser holds (place `policyYaml`). The library writes the
 * tokens it reads to stdout when the variable `LOG_TOKENS` or `LOG_STREAM`
 * is set, which would break the protocol over stdio; the loader of the
 * configuration refuses both before it reads the file. Its warnings go to
 * no stream either, because the level of its log is `error`.
 *
 * @packageDocumentation
 */
import {
  isScalar,
  LineCounter,
  type ParsedNode,
  parseDocument,
  visit,
} from 'yaml';

// The prefix the handle `!!` stands for in YAML 1.2.
const defaultTagPrefix = 'tag:yaml.org,2002:';

/**
 * Why a text is no YAML the policy takes, frozen. A code never carries a
 * value of the file; the line, if known, travels beside it.
 */
export const policyYamlCodes = Object.freeze([
  'policy_yaml_syntax',
  'policy_yaml_unsupported',
] as const);

/** Why a text is no YAML the policy takes. */
export type PolicyYamlCode = (typeof policyYamlCodes)[number];

/** The plain values of the text, or why there are none. */
export type PolicyYamlResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly code: PolicyYamlCode;
      /** The line of the first problem, from 1, when the parser knows it. */
      readonly line?: number;
    };

// The options of the parser. The level `error` keeps the warnings out of
// every stream and still reports a second document as an error, which the
// level `silent` would not.
const options = Object.freeze({
  version: '1.2',
  schema: 'core',
  uniqueKeys: true,
  merge: false,
  strict: true,
  prettyErrors: false,
  logLevel: 'error',
} as const);

const refuse = (code: PolicyYamlCode, line?: number): PolicyYamlResult =>
  Object.freeze({
    __proto__: null,
    ok: false,
    code,
    ...(line === undefined ? {} : { line }),
  });

/**
 * Reads the text of the policy file as YAML. JSON is YAML as well, so a
 * file in JSON reads the same way.
 *
 * @param text - The decoded text of the file.
 * @returns The plain values, or the code of the first problem with its
 *   line. It never throws for a text.
 * @throws {TypeError} When the text is not a string.
 * @example
 * ```ts
 * readPolicyYaml('schema: policy.v1\n'); // { ok: true, value: { schema: 'policy.v1' } }
 * readPolicyYaml('a: &x 1\nb: *x\n'); // { ok: false, code: 'policy_yaml_unsupported', line: 1 }
 * ```
 */
export function readPolicyYaml(text: string): PolicyYamlResult {
  if (typeof text !== 'string') {
    throw new TypeError('The text of the policy must be a string.');
  }
  const lines = new LineCounter();
  const lineOf = (offset: number): number => lines.linePos(offset).line;
  try {
    const doc = parseDocument(text, { ...options, lineCounter: lines });
    // Errors first, then warnings such as a tag the schema does not know:
    // both mean the text is not what it seems.
    const [problem] = [...doc.errors, ...doc.warnings];
    if (problem !== undefined) {
      return refuse('policy_yaml_syntax', lineOf(problem.pos[0]));
    }
    // A directive could change the version of YAML or what a tag means.
    const { yaml: version, tags } = doc.directives;
    if (
      version.explicit === true ||
      Object.keys(tags).some(
        (handle) => handle !== '!!' || tags[handle] !== defaultTagPrefix,
      )
    ) {
      return refuse('policy_yaml_unsupported', 1);
    }
    let unsupported: number | undefined;
    // Every node of a document parsed from a text has its range.
    const mark = (node: unknown): typeof visit.BREAK => {
      unsupported = lineOf((node as ParsedNode).range[0]);
      return visit.BREAK;
    };
    visit(doc, {
      Alias: (_key, node) => mark(node),
      Node: (_key, node) =>
        node.anchor === undefined && node.tag === undefined
          ? undefined
          : mark(node),
      Pair: (_key, pair) =>
        isScalar(pair.key) && typeof pair.key.value === 'string'
          ? undefined
          : mark(pair.key),
    });
    if (unsupported !== undefined) {
      return refuse('policy_yaml_unsupported', unsupported);
    }
    const value: unknown = doc.toJS({ maxAliasCount: 0 });
    return Object.freeze({ __proto__: null, ok: true, value });
  } catch {
    // Such as a stack too deep for a text nested without end.
    return refuse('policy_yaml_syntax');
  }
}
