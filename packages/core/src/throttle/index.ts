/**
 * The throttle of requests to ChurchTools (ADR 0057). Only the ChurchTools
 * client imports it; no entry point of core passes it on.
 *
 * @packageDocumentation
 */
export {
  createRequestThrottle,
  type RequestThrottle,
  type TakeResult,
  type ThrottleOptions,
} from './token-bucket.js';
