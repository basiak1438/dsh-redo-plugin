/**
 * dsh-redo-plugin host half.
 *
 * The plugin's work is client-side: an "订正" button per user message, a
 * read-only impact preview over the rewind RPC channel, then a centered
 * editor whose confirmation drives two ordered host operations — the rewind
 * (`/rewind-plugin @<seq> chat|both`) and the resend (`session.prompt`).
 *
 * This file therefore exports no behavioural surface beyond the plugin
 * identity. It exists because a bundle row needs a node half: the client
 * modules table resolves `<row-name>/package.json`, and the Loader mounts the
 * package's default export as the row's node face.
 *
 * @module dsh-redo
 */

export const name = 'dsh-redo'

/** No host service is required: this plugin registers nothing on the host. */
export const inject = []

/**
 * Activate the node half. Intentionally empty — every capability this bundle
 * contributes is registered by the browser half (`./client`).
 * @param _ctx - the Loader-provided context for this row.
 * @param _config - the row's config, unused.
 */
export function apply(_ctx, _config) {}
