'use strict';

const utils = require('./utils');

/**
 * Resolve a device log label from any id/IEEE/group-id form (with or without namespace prefix).
 * Looks up the user-assigned name via the adapter's state controller; when the user has not
 * renamed the device, the name of the device object (usually the model, cached by the state
 * controller) is used, so an un-named device is labelled the same way the admin shows it. The id
 * is always kept for unique identification (see utils.deviceDisplayName). Never throws — a log
 * line can never fail because of this. An invalid id resolves to "unknown device" (via
 * deviceDisplayName), a lookup failure to "failed to get name".
 *
 * Lives in its own module (not in utils) so that utils stays free of adapter-specific code.
 *
 * @param {object} adapter the ioBroker adapter instance (needs .stController.verifyDeviceName)
 * @param {string|number} idOrIeee the device id / IEEE address / group id (always shown in the label)
 * @param {string} [model] the device model — per-model override key and default name when un-named
 * @returns {string} the display label ("name (id)"), or "failed to get name (id)" on error
 */
function devLabel(adapter, idOrIeee, model) {
    let name = 'unnamed';
    try {
        const bareId = adapter && adapter.namespace ? String(idOrIeee).replace(`${adapter.namespace}.`, '') : idOrIeee;
        const adId = utils.zbIdorIeeetoAdId(adapter, bareId, false);
        if (adapter && adapter.stController && typeof adapter.stController.verifyDeviceName === 'function') {
            name = adapter.stController.verifyDeviceName(adId, model, model);
        }
    } catch {
        return `failed to get name (${idOrIeee})`;
    }
    return utils.deviceDisplayName(idOrIeee, name);
}

module.exports = { devLabel };
