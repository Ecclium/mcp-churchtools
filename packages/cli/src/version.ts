/**
 * The version of Ecclium, as the client reads it in `serverInfo` and
 * ChurchTools in the User-Agent of every request. A constant instead of a
 * read of `package.json` at run time, whose path differs between `dist/`
 * and a bundle, and instead of a JSON import, which the build would have
 * to take in from outside `src/`. A test holds it equal to the version in
 * `package.json`.
 *
 * @packageDocumentation
 */

/**
 * The version of the package: 1 to 32 printable ASCII characters without
 * spaces, as `serverInfo` takes it.
 *
 * @example
 * ```ts
 * startStdioServer({ ...options, version });
 * ```
 */
export const version = '0.0.0';

/**
 * The User-Agent of every request to ChurchTools: Ecclium with its version.
 *
 * @example
 * ```ts
 * createHttpTransport({ ...options, userAgent });
 * ```
 */
export const userAgent = `Ecclium/${version}`;
