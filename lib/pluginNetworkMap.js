'use strict';
const basePlugin = require ('./pluginBase');

class NetworkMap extends basePlugin {
    constructor(adapter) {
        super(adapter, 'NetworkMap');
    }

    start(zbController, stController) {
        super.start(zbController, stController)
        this.registerHandler(this.adapter,'message', this.onMessage.bind(this));
        this.mapdata = { hasMap:false, timestamp:0 };
        this.mapValidityTime = 30*60*1000;
    }

    stop() {
        delete this.zbController;
        delete this.stController;
    }

    /**
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        if (typeof obj === 'object' && obj.command) {
            switch (obj.command) {
                case 'getMap':
                    if (obj && obj.message && typeof obj.message === 'object') {
                        this.getMap(obj.from, obj.command, obj.message, obj.callback);
                    }
                    break;
            }
        }
    }

    getMap(from, command, message, callback) {
        if (!message.forcebuild)  {
            if (this.mapdata.hasMap) {
                this.mapdata.errors = {};
                this.adapter.sendTo(from, command, this.mapdata, callback)
            }
            else this.adapter.sendTo(from, command, { hasMap: false });
            return;
        }
        if (this.zbController) {
            this.zbController.getMap(networkmap => {
                this.mapdata = networkmap;
                this.mapdata.hasMap = true;
                const t = this;
                this.mapdata.timestamp = Date.now();
                if (this.debugActive) this.debug(`getMap result: ${JSON.stringify(networkmap)}`);
                if (t.mapTimeout) clearTimeout(t.mapTimeout);
                t.mapTimeout = setTimeout(() => {
                    t.adapter.setState('info.pairingMessage', 'Map invalidated.', true);
                }, this.mapValidityTime);
                this.adapter.sendTo(from, command, networkmap, callback);
            });
        }
    }
}

module.exports = NetworkMap;
