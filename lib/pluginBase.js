class basePlugin {
    constructor(adapter) {
        this.adapter = adapter;
        this.log = adapter?.log;
        this.pluginName = '';
    }

    info (message, data) {
        this.log.info(`${this.pluginName}: ${message}`, data);
    }

    warn (message, data) {
        this.log.warn(`${this.pluginName}: ${message}`, data);
    }
    debug (message, data) {
        this.log.debug(`${this.pluginName}: ${message}`, data);
    }

    error (message, data) {
        this.log.error(`${this.pluginName}: ${message}`, data);
    }

    sendTo (from, command, message, callback) {
        this.adapter.sendTo(from, command, message, callback);
    }

    start(zigbee, state) {
        this.zbController = zigbee;
        this.stController = state;
    }

    stop() {
        delete this.zbController;
        delete this.stController;
    }
}

exports.basePlugin = basePlugin;
