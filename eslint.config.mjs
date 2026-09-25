// ESLint configuration for the whole workspace (ADR 0020).
//
// TypeScript files are linted with type information. The TypeScript project
// service picks the tsconfig that owns each file, the same way an editor
// does, so tests and scripts are checked with their own settings.
// Configuration files in plain JavaScript (.mjs) are linted without types.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import jsdoc from 'eslint-plugin-jsdoc';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // The brand package is delivered as is and never changed here.
    ignores: ['brand/', '**/dist/', 'coverage/'],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Every export carries documentation: purpose, parameters, results and
    // errors. Functions and classes of the packages also need an example,
    // because the published API and the tools are read by strangers.
    files: ['packages/*/src/**/*.ts', 'scripts/**/*.mts'],
    ignores: ['**/*.test.ts', '**/*.test.mts'],
    extends: [jsdoc.configs['flat/recommended-typescript-error']],
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      // publicOnly also finds exports through `export { name }` lists.
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true,
          },
          contexts: ['TSInterfaceDeclaration', 'TSTypeAliasDeclaration'],
        },
      ],
      'jsdoc/require-description': 'error',
      'jsdoc/require-throws': 'error',
      // One blank line between the description and the first tag, as in TSDoc.
      'jsdoc/tag-lines': ['error', 'never', { startLines: 1 }],
      'jsdoc/check-tag-names': [
        'error',
        { definedTags: ['packageDocumentation'] },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'jsdoc/require-example': [
        'error',
        {
          contexts: [
            'ExportNamedDeclaration > FunctionDeclaration',
            'ExportNamedDeclaration > ClassDeclaration',
          ],
        },
      ],
    },
  },
  {
    // In stdio mode, stdout carries the MCP protocol, and any other output
    // there breaks the connection. Package code therefore writes only
    // through the logger. Scripts under scripts/ may print.
    files: ['packages/*/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'stdout',
          message:
            'Write through the logger: stdout belongs to the MCP protocol.',
        },
        {
          object: 'process',
          property: 'stderr',
          message: 'Write through the logger, which owns stderr.',
        },
      ],
    },
  },
);
