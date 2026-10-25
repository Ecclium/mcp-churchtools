// Resolution hook for the child processes of tests/mcp-stdio.test.mts,
// tests/stdio-start.test.mts, tests/blocking-descriptors.test.mts and
// tests/quota-processes.test.mts,
// loaded with --import before the script the child runs. The packages
// import their own modules under the names of the build, ending in .js,
// while the child runs their TypeScript source, which Node.js loads only
// under its real name. The hook maps such a relative import from a source
// file of a package to the .ts file of the same name and leaves every
// other import to Node.js. Packages resolve by name to their source
// through the export condition @ecclium/source, which the tests pass with
// --conditions (ADR 0022).
import { registerHooks } from 'node:module';

const packages = new URL('../../../packages/', import.meta.url).href;

/** Whether the URL names a file under src/ of a package. */
const isPackageSource = (url: string): boolean =>
  url.startsWith(packages) &&
  url.slice(packages.length).split('/')[1] === 'src';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const own =
      isPackageSource(context.parentURL ?? '') &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js');
    return own
      ? nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context)
      : nextResolve(specifier, context);
  },
});
