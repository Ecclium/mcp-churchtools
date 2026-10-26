/**
 * The right the tools that read resources and bookings need, and the
 * messages that name it (ADR 0064). Like a plugin of a third party, it
 * imports only the plugin API (ADR 0022).
 *
 * @packageDocumentation
 */
import type { RightRef } from '@ecclium/mcp-churchtools-plugin-api';

/**
 * The right that opens the resources it names and their bookings
 * (`docs/research/churchtools-api.md`, F36). It counts for each resource,
 * not for a type of resources. Without it, ChurchTools leaves a resource
 * out of the list and refuses its bookings with 403.
 */
export const resourceRight: RightRef = Object.freeze({
  module: 'churchresource',
  right: 'view resource',
});

/** The message of a refused list of bookings. */
export const bookingsRefused = `ChurchTools refused the bookings. The service account needs the right "${resourceRight.right}" in ${resourceRight.module} for each resource named; ct_resources_list lists the resources the account may see.`;
