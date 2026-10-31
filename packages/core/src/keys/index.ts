/**
 * The holder of the secret behind the pseudonyms of the level `strict`
 * (ADR 0069), for the configuration that reads it from its file. The
 * function that reads its bytes stays inside, held by the rule
 * `keys-internals`, and the provider that derives the keys of a day is
 * reached only from its own module, which the rule
 * `key-provider-only-from-composition-root` keeps for the composition root.
 *
 * @packageDocumentation
 */
export { KeyMaterial, keyMaterialLength } from './key-material.js';
