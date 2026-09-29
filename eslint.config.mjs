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

import { loadBoundaries } from './tests/architecture/boundaries.mts';
import { architectureLintConfig } from './tests/architecture/lint-rules.mts';

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
  // Architecture rules for the code of the packages, generated from
  // tests/architecture/boundaries.json: in the stdio mode stdout carries the
  // MCP protocol, so only the listed places write to stdout or stderr and
  // nothing uses console (ADR 0018); only the mount and the server import
  // the MCP SDK (ADR 0024). Scripts under scripts/ may print.
  // tests/architecture/lint-rules.mts explains each restriction.
  ...architectureLintConfig(loadBoundaries()),
);
