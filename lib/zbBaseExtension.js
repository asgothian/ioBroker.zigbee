'use strict';

/*eslint no-unused-vars: ['off']*/

const { devLabel } = require('./deviceLabel');

class BaseExtension {
    constructor(zigbee, options) {
        this.zigbee = zigbee;
        this.name = 'BaseExtension';
        this.elevate_debug = false;
    }

    info (message, data) {
        this.zigbee.adapter.onLog('info', message, data);
    }

    warn (message, data) {
        this.zigbee.adapter.onLog('warn', `${this.pluginName}:${message}`, data);
    }
    debug (message, data) {
        this.zigbee.adapter.onLog('debug', `${this.pluginName}:${message}`, data);
    }

    error (message, data) {
        this.zigbee.adapter.onLog('error', `${this.pluginName}:${message}`, data);
    }

    // Log label for a device: user-assigned name if set, otherwise the id/address.
    internalDevLabel(idOrIeee, model) {
        if (!model) return idOrIeee;
        return devLabel(this.adapter, idOrIeee, model);
    }

    pairingMessage(message) {
        this.zigbee.emit('pairing', `${this.name}:${message}`)
    }

    sendError(error, message) {
        this.zigbee.sendError(error, message);
    }

    sendTo(...args) {
        this.adapter.sendTo(args);
    }

}

module.exports = BaseExtension;
