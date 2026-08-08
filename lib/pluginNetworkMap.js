'use strict';

const basePlugin = require('./pluginBase');

class NetworkMap extends basePlugin{
    constructor(adapter) {
        super(adapter)
        adapter.on('message', this.onMessage.bind(this));
        this.mapdata = { hasMap:false, timestamp:0 };
        this.mapValidityTime = 30*60*1000;
        this.name = 'NetworkMap';

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

    async getMap(from, command, message, callback) {
        if (this.zbController) {
            if (!message.forcebuild)  {
                if (this.mapdata.hasMap) {
                    this.mapdata.errors = {};
                    this.sendTo(from, command, this.mapdata, callback)
                }
                else this.sendTo(from, command, { hasMap: false });
                return;
            }

            const devIter = this.zbController?.getClientIterator();
            try {
                this.mapdata = { lqi:{}, routing:{}, sdev:[], edev:[], ddev: []};
                this.info('Collecting Map Data');
                const devIter = this.herdsman.getDevicesIterator((d) => d.type !== 'EndDevice');
                const lqis = [];
                const routing = [];
                const errors = [];

                let cnt = 0;
                this.pairingMessage(`Map Devices done:${cnt}`)
                for (const device of devIter)
                {
                    cnt++;
                    if (this.disabledDevices.has(device.ieeeAddr)) {
                        this.mapdata.ddev.push(device.ieeeAddr);
                        lqis.push({
                            parent: 'undefined',
                            networkAddress: 0,
                            ieeeAddr: device.ieeeAddr,
                            lqi: 'undefined',
                            relationship: 0,
                            depth: 0,
                            status: 'disabled',
                        });
                        continue;
                    }
                    const entity = await this.zbController.resolveEntity(device, 0) ?? { name:'unresolved device', device:device };
                    if (entity.name === 'unresolved device' && this.debugActive) {
                        this.debug('resolve Entity failed for ' + "'" + this.devLabel(device.ieeeAddr) + "'");
                    }

                    let attemptRouting = true;

                    try {
                        const result = await device.lqi();
                        this.mapdata.sdev.push(`lqi ${device.ieeeAddr}`);
                        this.mapdata.lqi[device.ieeeAddr] = result;
                        const r_arr = Array.isArray(result) ? result : result?.neighbors;
                        if (r_arr) {
                            for (const dev of r_arr) {
                                const ieeeAddr = dev.ieeeAddr || dev.eui64;
                                if (dev !== undefined && ieeeAddr !== '0xffffffffffffffff') {
                                    const lq = (dev.linkquality == undefined) ? dev.lqi== undefined ? 0 : dev.lqi : dev.linkquality
                                    lqis.push({
                                        parent: (entity ? entity.device.ieeeAddr : undefined),
                                        networkAddress: dev.networkAddress || dev.nwkAddress,
                                        ieeeAddr: ieeeAddr,
                                        lqi: lq,
                                        relationship: dev.relationship,
                                        depth: dev.depth,
                                        status: lq > 0 ? 'online' : 'offline',
                                    });
                                }
                            }
                        }
                    } catch (error) {
                        this.mapdata.edev.push(device.ieeeAddr);
                        const eReason = this.zbController.filterHerdsmanError(error.message);
                        errors.push(`Failed to execute LQI for '${entity?.name ?? 'unresolved device'} (${entity?.device?.modelID ??'unknown'}') : ${eReason}.`);
                        attemptRouting = (eReason != 'Timeout');
                        lqis.push({
                            parent: 'undefined',
                            networkAddress: 0,
                            ieeeAddr: device.ieeeAddr,
                            lqi: 'undefined',
                            relationship: 0,
                            depth: 0,
                            status: 'offline',
                        });
                    }

                    if (attemptRouting) try {
                        const result = await device.routingTable();
                        const r_arr = Array.isArray(result) ? result : result?.table;
                        this.mapdata.routing[device.ieeeAddr] = result;
                        if (r_arr !== undefined) {
                            for (const dev of r_arr) {
                                routing.push({
                                    source: entity.device.ieeeAddr,
                                    destination: dev.destinationAddress,
                                    nextHop: dev.nextHop ? dev.nextHop: dev.nextHopAddress,
                                    status: dev.status,
                                });
                            }
                        }
                    } catch (error) {
                        this.mapdata.edev.push(`routing ${device.ieeeAddr}`);
                        if (error) {
                            errors.push(`Failed to collect routing table for '${entity?.name ?? 'unresolved device'} (${entity?.device?.modelID ?? 'unknown'}') : ${ this.zbController.filterHerdsmanError(error.message)}`);
                        }
                    }
                    else errors.push(`Omitted collecting routing table for '${entity?.name ?? 'unresolved device'} (${entity?.device?.modelID ??'unknown'}') : LQI timed out`);
                    this.pairingMessage(`Map Devices left: ${cnt}`);
                }
                this.pairingMessage('Map data collection complete');

                /* const fs = require('fs');
                fs.writeFileSync(this.adapter.expandFileName('mapdata.json'), JSON.stringify(MapData));
                */

                if (errors.length) {
                    this.info(`Map Data collection complete with ${errors.length} issues:`);
                    for (const msg of errors)
                        if (this.debugActive) this.debug(msg);
                }
                else
                    this.info('Map data collection complete');
            } catch (error) {
                this.sendError(error);
                this.error(`Failed to get map: ${JSON.stringifgy(error.stack)}`);
            }
        }
        this.mapdata.hasMap = true;
        this.mapdata.timestamp = Date.now();
        //this.adapter.log.debug(`getMap result: ${JSON.stringify(this.mapdata)}`);
        if (this.mapTimeout) this.zigbee.clearTimeout(this.mapTimeout);
        this.mapTimeout = this.zigbee.setTimeout(() => {
            this.pairingMessage('Map invalidated.');
        }, this.mapValidityTime);
        this.sendTo(from, command, this.mapdata, callback);

    }
}

module.exports = NetworkMap;
