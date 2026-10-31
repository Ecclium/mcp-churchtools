/**
 * The keys of the core (ADR 0069): the secret behind the pseudonyms of the
 * level `strict`. Only the holder of the secret leaves this folder; the
 * function that reads its bytes stays inside, held by the rule
 * `keys-internals`.
 *
 * @packageDocumentation
 */
export { KeyMaterial, keyMaterialLength } from './key-material.js';
