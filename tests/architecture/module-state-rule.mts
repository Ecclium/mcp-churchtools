import type { Rule } from 'eslint';

// ESLint rule ecclium-arch/no-module-state (ADR 0051): code in the packages
// keeps no mutable state at module level. It reports
// - let and var that belong to the module, not to a function or a block;
// - every new while the module loads, also in static fields and static
//   blocks of a class, so that no singleton holds state. TextEncoder,
//   TextDecoder and the formatters of Intl are the exceptions, they hold no
//   state that changes;
// - static fields without readonly.
// A field of an instance is fine, it lives as long as its object, and so is
// a declaration for the type checker, which creates nothing.
//
// The rule reads code, not what runs. A mutated object or array in a
// constant or a readonly static field, a closure, a factory called while the
// module loads and state in a dependency escape it; ADR 0051 lists them.

/** Constructors whose objects hold no state that changes. */
const stateless: readonly string[] = ['TextEncoder', 'TextDecoder'];

const functions: readonly string[] = [
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
];

/** Scopes of let and var that belong to the module. */
const moduleScopes: readonly string[] = ['module', 'global', 'tsModule'];

/** A node of the syntax tree, as ESLint hands out its ancestors. */
type Node = ReturnType<Rule.RuleContext['sourceCode']['getAncestors']>[number];

/** The parts of a class field that the rule reads. */
interface Field {
  readonly value: unknown;
  readonly static: boolean;
  readonly readonly?: boolean;
  readonly declare?: boolean;
}

/**
 * The node as a class field, or undefined. The syntax tree of TypeScript
 * adds readonly, declare and auto-accessors, which the types of ESLint do
 * not know.
 */
function asField(node: Node): Field | undefined {
  const type: string = node.type;
  return type === 'PropertyDefinition' || type === 'AccessorProperty'
    ? (node as unknown as Field)
    : undefined;
}

/** Whether the node lies inside a declaration for the type checker. */
function inDeclaration(ancestors: readonly Node[]): boolean {
  return ancestors.some((entry) => {
    const type: string = entry.type;
    return (
      type === 'TSModuleDeclaration' &&
      (entry as unknown as { declare?: boolean }).declare === true
    );
  });
}

/**
 * Whether code at this node runs once while the module loads. Walks from the
 * node outwards: a function ends the search, and so does the field of an
 * instance; a static field or static block does not.
 */
function runsAtLoad(ancestors: readonly Node[], node: Node): boolean {
  let child: Node = node;
  for (const ancestor of [...ancestors].reverse()) {
    if (functions.includes(ancestor.type)) return false;
    const field = asField(ancestor);
    if (field !== undefined && field.value === child && !field.static) {
      return false;
    }
    child = ancestor;
  }
  return true;
}

/** Whether new with this callee creates an object without changing state. */
function isStateless(callee: Node): boolean {
  if (callee.type === 'Identifier') return stateless.includes(callee.name);
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Intl'
  );
}

/** The rule, configured with the message that names its ADR. */
export const moduleStateRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid mutable state at module level in the packages.',
    },
    schema: [
      {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: false,
      },
    ],
    messages: { state: '{{message}}' },
  },
  create(context) {
    const [{ message }] = context.options as [{ message: string }];
    const report = (node: Node): void => {
      context.report({ node, messageId: 'state', data: { message } });
    };
    const ancestors = (node: Node): readonly Node[] =>
      context.sourceCode.getAncestors(node);
    const checkStaticField = (node: Node): void => {
      const field = asField(node);
      if (
        field?.static === true &&
        field.readonly !== true &&
        field.declare !== true &&
        runsAtLoad(ancestors(node), node)
      ) {
        report(node);
      }
    };
    return {
      VariableDeclaration(node) {
        if ('declare' in node && node.declare === true) return;
        if (node.kind !== 'let' && node.kind !== 'var') return;
        if (inDeclaration(ancestors(node))) return;
        // var belongs to the nearest function or the module, let to the
        // nearest block.
        const scope = context.sourceCode.getScope(node);
        const owner = node.kind === 'var' ? scope.variableScope : scope;
        if (moduleScopes.includes(owner.type)) report(node);
      },
      NewExpression(node) {
        const path = ancestors(node);
        if (
          !inDeclaration(path) &&
          runsAtLoad(path, node) &&
          !isStateless(node.callee)
        ) {
          report(node);
        }
      },
      PropertyDefinition: checkStaticField,
      AccessorProperty: checkStaticField,
    };
  },
};
