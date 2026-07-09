'use strict';

const utils = require('./utils');

/**
 * Resolve a device log label from any id/IEEE/group-id form (with or without namespace prefix).
 * Name resolution order: user override from the local config (per-device wins over per-model,
 * the per-model lookup needs the model parameter) -> name of the device object (usually the
 * model, cached by the state controller), so the label matches what the admin shows -> the model
 * parameter itself (covers devices without an object, e.g. while pairing) -> "unnamed". The id
 * is always kept for unique identification (see utils.deviceDisplayName). Never throws — a log
 * line can never fail because of this. An invalid id resolves to "unknown device" (via
 * deviceDisplayName), a lookup failure to "failed to get name".
 *
 * Lives in its own module (not in utils) so that utils stays free of adapter-specific code.
 *
 * @param {object} adapter the ioBroker adapter instance (needs .stController.verifyDeviceName)
 * @param {string|number} idOrIeee the device id / IEEE address / group id (always shown in the label)
 * @param {string} [model] the mapped model (common.type key space, 'group' for groups) — per-model
 *        override key and last-resort default name; empty/non-string values are ignored
 * @returns {string} the display label ("name (id)"), or "failed to get name (id)" on error
 */
function devLabel(adapter, idOrIeee, model) {
    let name = 'unnamed';
    try {
        const bareId = adapter && adapter.namespace ? String(idOrIeee).replace(`${adapter.namespace}.`, '') : idOrIeee;
        const adId = utils.zbIdorIeeetoAdId(adapter, bareId, false);
        // '' must not reach verifyDeviceName: it is not nullish and would suppress the fallbacks
        const mdl = typeof model === 'string' && model.length > 0 ? model : undefined;
        if (adapter && adapter.stController && typeof adapter.stController.verifyDeviceName === 'function') {
            name = adapter.stController.verifyDeviceName(adId, mdl, undefined);
        }
    } catch {
        return `failed to get name (${idOrIeee})`;
    }
    return utils.deviceDisplayName(idOrIeee, name);
}

module.exports = { devLabel };
