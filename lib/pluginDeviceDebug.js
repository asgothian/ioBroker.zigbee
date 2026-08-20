const basePlugin = require('./pluginBase.js');

const { AdapterOptions } = require('./localconfig.js');

class DeviceDebug extends basePlugin {
    constructor(adapter) {
        super(adapter);
        this.dataByID = { };
        this.dataByDevice = { };
        this.logStatus = true;
        this.adapter.on('message',this.onMessage.bind(this));
    }

    start(statescontroller, zigbeecontroller) {
        super.start(statescontroller, zigbeecontroller);
        this.debug('--- creating device debug ---');
        this.registerHandler(this.stController, 'device_debug', this.onDebugEvent.bind(this))
        this.registerHandler(this.adapter, 'device_debug', this.onDebugEvent.bind(this))
        this.registerHandler(this.zbController, 'device_debug', this.onDebugEvent.bind(this))
        this.pluginName = 'DeviceDebug';
    }

    async onMessage(obj) {
        if (!this.isStarted) return;
        if (typeof obj === 'object' && obj.command) {
            if (obj) {
                let handled = false;
                switch (obj.command) {
                    case 'getDeviceCleanupRequired':
                        if (this.stController) this.sendTo(obj.from, obj.command, {clean:this.stController.CleanupRequired(), errors:this.stController.getStashedErrors()}, obj.callback);
                        // NO Break - returning the debug-data as well is intentional
                    case 'getDebugMessages':
                        this.sendTo(obj.from, obj.command, {byId:this.collectDebugData( obj.message.inlog, obj.message.del )},obj.callback);
                        handled = true;
                        break;
                    case 'setDeviceActivated':
                        if (obj.message && typeof obj.message === 'object') {
                            this.stController.setDeviceActivated(obj.message.id, obj.message.deactivated);
                            this.zbController.setDeviceDisabled(obj.message.id, obj.message.deactivated);
                            this.sendTo(obj.from, obj.command, {}, obj.callback);
                            handled = true;
                        }
                        break;
                    case 'setDeviceDebug':
                        if (obj.message && typeof obj.message === 'object') {
                            this.sendTo(obj.from, obj.command, {debugDevices:await this.stController.toggleDeviceDebug(obj.message.id)}, obj.callback)
                            handled = true;
                        }
                        break;
                    case 'getDebugDevices':
                        if (obj.message && typeof obj.message === 'object') {
                            this.sendTo(obj.from, obj.command, {debugDevices:await this.stController.getDebugDevices()}, obj.callback);
                            handled = true;
                        }
                        break;
                    case 'getDevice':
                        if (obj.message && typeof obj.message === 'object' && obj.message.id) {
                            this.getDevices(obj.from, obj.command, obj.message.id, obj.callback);
                            handled = true;
                        }
                        break;
                    case 'getDevices':
                        if (obj.message && typeof obj.message === 'object') {
                            this.getDevices(obj.from, obj.command, null, obj.callback);
                            handled = true;
                        }
                        break;
                }
                if (handled) this.debug(`handled ${(obj.command)}`);
            }
        }
    }



    onDebugEvent(message) {
        if (typeof message === 'object' && message.hasOwnProperty('ID'))
        {
            let flag='NONE';
            if (message.hasOwnProperty('data')) {
                const dataId = message.ID;
                const item = this.dataByID[dataId] ? this.dataByID[dataId] : { dataID: dataId, deviceID:'unknown', states:[],flags:[], errors:[], IO:message.IO, messages:{} };
                this.dataByID[dataId] = item;
                const data = message.data;
                if (data.error && item.errors.indexOf(data.error)<0) item.errors.push(data.error);
                if (data.states) item.states.push(...data.states);
                if (data.flag && item.flags.indexOf(data.flag)<0) item.flags.push(data.flag);
                if (data.payload && !item.payload) item.payload = data.payload;
                item.IO = data.IO ? true : false;
                if (data.error) flag = data.error;
                else if (data.flag)
                    if (data.flag === 'SUCCESS') flag = data.flag;
                    else flag = item.IO ? 'I'+data.flag : 'O'+data.flag;
                else
                    flag = item.IO ? 'IN' : 'OUT';
                if (message.message) {
                    let msgIdx = 0;
                    while (item.messages.hasOwnProperty(`${flag}${msgIdx ? '-'+msgIdx : ''}`)) msgIdx++;
                    item.messages[`${flag}${msgIdx ? '-'+msgIdx : ''}`] = message.message;
                }
                if (data.ID && data.ID !== item.deviceID) {
                    item.deviceID = data.ID;
                    const DevData = this.dataByDevice[item.deviceID] ? this.dataByDevice[item.deviceID] : { IN:[], OUT:[] };
                    const target = (data.IO ? DevData.IN : DevData.OUT)
                    while (target.length > 20 || (target.length > 10 && dataId - target[0]>30000)) {
                        const pre = target.length;
                        const ditem = target.shift();
                        delete this.dataByID[ditem.dataID];
                        this.debug(`on Debug Message: removing item ${ditem.dataID} : pre ${pre} post ${target.length}`)
                    }
                    target.push(item);
                    this.dataByDevice[item.deviceID] = DevData;
                }
                if (message.hasOwnProperty('message') && this.logStatus) {
                    this.warn(`ELEVATED:${flag} (${dataId?.toString(16).slice(-4)}) ${message.message}`)
                }
            }
        }
    }

    deleteMessagesFor(item) {
        if (item == 'all') {
            this.dataByDevice = {};
            this.dataByID = {};
            return;
        }
        delete this.dataByDevice[item];
        const obsoleteIDs = [];
        for (const id in this.dataByID) {
            if (this.dataByID[id].deviceID === item) obsoleteIDs.push(id)
        }
        for (const id of obsoleteIDs) delete this.dataByID[id];
    }

    collectDebugData(logStatus, del) {
        if (logStatus != undefined)
            this.logStatus = logStatus;
        if (del) {
            this.deleteMessagesFor(del);
        }
        return this.dataByDevice;
    }

    async getDevices(from, command, id, callback) {
        //this.warn(`getDevices called from  ${from} with command ${JSON.stringify(command)}${id ? ' and id '+JSON.stringify(id) : ' without ID'}`);
        if (!(this.zbController && this.zbController.herdsmanStarted)) {
            this.sendTo(from, command, {error: 'No active connection to Zigbee Hardware!'}, callback);
            return;
        }
        const devInfo = await this.adapter.getDeviceInformation(id)
        const rv = { devices:devInfo.deviceObjects,
            inLog:this.logStatus,
            adapterOptions:AdapterOptions,
        }
        if (!id) {
            rv.deviceDebugData = this.collectDebugData();
            rv.localOverrides = this.adapter.stController.localConfig.localData;
            rv.models = devInfo.models.byUID;
        }

        if (this.stController) {
            rv.clean = this.stController.CleanupRequired();
            rv.errors = this.stController.getStashedErrors();
            rv.debugDevices = this.stController.debugDevices;
        }
        this.sendTo(from, command, rv, callback);

    }

}

module.exports = DeviceDebug;
