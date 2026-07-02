'use strict';

/*eslint no-unused-vars: ['off']*/

const { devLabel } = require('./deviceLabel');

class BaseExtension {
    constructor(zigbee, options) {
        this.zigbee = zigbee;
        this.name = 'BaseExtension';
        this.elevate_debug = false;
    }

    info(message, data) {
        this.zigbee.info(message, data);
    }

    error(message, data) {
        this.zigbee.error(`${this.name}:${message}`, data);
    }

    warn(message, data) {
        this.zigbee.warn(`${this.name}:${message}`, data);
    }

    debug(message, data) {
        if (this.elevate_debug)
            this.zigbee.warn(`DE ${this.name}:${message}`, data);
        else
            this.zigbee.debug(`${this.name}:${message}`, data);
    }

    // Log label for a device: user-assigned name if set, otherwise the id/address.
    devLabel(idOrIeee, model) {
        return devLabel(this.zigbee.adapter, idOrIeee, model);
    }

    pairingMessage(message) {
        this.zigbee.emit('pairing', `${this.name}:${message}`)
    }

    sendError(error, message) {
        this.zigbee.sendError(error, message);
    }
}

module.exports = BaseExtension;
