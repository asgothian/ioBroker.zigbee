/**
 *
 * Zigbee devices adapter
 *
 */
'use strict';

let debug;
try {
    debug = require('zigbee-herdsman/node_modules/debug');
} catch (e) {
    debug = require('debug');
}
const originalLogMethod = debug.log;

const zigbeeHerdsmanConvertersUtils = require('zigbee-herdsman-converters/lib/utils');

const safeJsonStringify = require('./lib/json');
const fs = require('fs');
const path = require('path');
const utils = require('@iobroker/adapter-core'); // Get common adapter utils
const SerialListPlugin = require('./lib/seriallist');
const CommandsPlugin = require('./lib/commands');
const GroupsPlugin = require('./lib/groups');
const NetworkMapPlugin = require('./lib/networkmap');
const DeveloperPlugin = require('./lib/developer');
const BindingPlugin = require('./lib/binding');
const OtaPlugin = require('./lib/ota');
const BackupPlugin = require('./lib/backup');
const ZigbeeController = require('./lib/zigbeecontroller');
const StatesController = require('./lib/statescontroller');
const ExcludePlugin = require('./lib/exclude');
const zigbeeHerdsmanConverters = require('zigbee-herdsman-converters');
const zigbeeHerdsmanConvertersPackage = require('zigbee-herdsman-converters/package.json')
const zigbeeHerdsmanPackage = require('zigbee-herdsman/package.json')
const vm = require('vm');
const util = require('util');
const dmZigbee  = require('./lib/devicemgmt.js');
const DeviceDebug = require('./lib/DeviceDebug');

const createByteArray = function (hexString) {
    const bytes = [];
    for (let c = 0; c < hexString.length; c += 2) {
        bytes.push(parseInt(hexString.substr(c, 2), 16));
    }
    return bytes;
};

const E_INFO  = 1;
const E_DEBUG = 2;
const E_WARN  = 3;
const E_ERROR = 4;

const errorCodes = {
    9999: {severity: E_INFO, message: 'No response'},
    233: {severity: E_DEBUG, message: 'MAC NO ACK'},
    205: {severity: E_WARN, message: 'No network route'},
    134: {severity: E_WARN, message: 'Unsupported Attribute'},
};

class Zigbee extends utils.Adapter {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super(Object.assign(options || {}, {
            dirname: __dirname.indexOf('node_modules') !== -1 ? undefined : __dirname,
            name: 'zigbee',
            systemConfig: true,
        }));
        this.on('ready', () => this.onReady());
        this.on('unload', callback => this.onUnload(callback));
        this.on('message', obj => this.onMessage(obj));
        this.uploadRequired = false;

        this.query_device_block = [];

        this.stController = new StatesController(this);
        this.stController.on('log', this.onLog.bind(this));
        this.stController.on('changed', this.publishFromState.bind(this));

        this.deviceManagement = new dmZigbee(this);
        this.deviceDebug =  new DeviceDebug(this),
        this.deviceDebug.on('log', this.onLog.bind(this));


        this.plugins = [
            new SerialListPlugin(this),
            new CommandsPlugin(this),
            new GroupsPlugin(this),
            new NetworkMapPlugin(this),
            new DeveloperPlugin(this),
            new BindingPlugin(this),
            new ExcludePlugin(this),
            new OtaPlugin(this),
            new BackupPlugin(this),
        ];
    }

    async onMessage(obj) {
        if (typeof obj === 'object' && obj.command) {
            switch (obj.command) {
                case 'SendToDevice': {
                    let rv = {
                        success: false,
                        loc: -1,
                    };

                    try {
                        rv = await this.sendPayload(obj.message);
                    } catch (e) {
                        rv.error = e;
                    }

                    this.sendTo(obj.from, obj.command, rv, obj.callback);
                    break;
                }
            }
        }
    }

    warn(message) {
        this.log.warn(message);
    }
    debug(message) {
        this.log.debug(message);
    }
    error(message) {
        this.log.error(message);
    }
    info(message) {
        this.log.info(message);
    }

    sendError(error, message) {
        try {
            if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
                const sentryInstance = this.getPluginInstance('sentry');
                if (sentryInstance) {
                    const Sentry = sentryInstance.getSentryObject();
                    if (Sentry) {
                        if (message) {
                            Sentry.configureScope(scope =>
                                scope.addBreadcrumb({
                                    type: 'error', // predefined types
                                    category: 'error message',
                                    level: 'error',
                                    message
                                }));
                        }

                        if (typeof error == 'string') {
                            Sentry.captureException(new Error(error));
                        } else {
                            Sentry.captureException(error);
                        }
                    }
                }
            }
        } catch (err) {
            this.log.error(`SentryError : ${message} ${error} ${err} `);
        }
    }

    filterError(errormessage, message, error) {
        if (error != null && error.code == undefined) {
            let em = error.stack.match(/failed \((.+?)\) at/);
            em = em || error.stack.match(/failed \((.+?)\)/);
            this.log.error(`${message} no error code (${(em ? em[1] : 'undefined')})`);
            this.sendError(error, `${message} no error code`);
            this.log.debug(`Stack trace for ${em}: ${error.stack}`);
            return;
        }

        const ecode = errorCodes[error.code];
        if (ecode === undefined) {
            this.log.error(errormessage);
            this.sendError(error, errormessage);
            return;
        }

        switch (ecode.severity) {
            case E_INFO:
                this.log.info(`${message}: Code ${error.code} (${ecode.message})`);
                break;
            case E_DEBUG:
                this.log.debug(`${message}: Code ${error.code} (${ecode.message})`);
                break;
            case E_WARN:
                this.log.warn(`${message}: Code ${error.code} (${ecode.message})`);
                break;
            case E_ERROR:
                this.log.error(`${message}: Code ${error.code} (${ecode.message})`);
                this.sendError(error, `${message}: Code ${error.code} (${ecode.message})`);
                break;
            default:
                this.log.error(`${message}: Code ${error.code} (malformed error)`);
                this.sendError(error, `${message}: Code ${error.code} (malformed error)`);
                break;
        }
    }

    debugLog(data, ...args) {
        const message = (args) ? util.format(data, ...args) : data;
        this.log.debug(message.slice(message.indexOf('zigbee-herdsman')));
    }

    async onReady() {
        if (this.config.debugHerdsman) {
            debug.log = this.debugLog.bind(this);
            debug.enable('zigbee-herdsman*');
        }

        // external converters
        this.applyExternalConverters();
        // get devices from exposes
        this.stController.getExposes();

        this.subscribeStates('*');
        // set connection false before connect to zigbee
        this.setState('info.connection', false, true);
        const zigbeeOptions = this.getZigbeeOptions();
        this.zbController = new ZigbeeController(this);
        this.zbController.on('log', this.onLog.bind(this));
        this.zbController.on('ready', this.onZigbeeAdapterReady.bind(this));
        this.zbController.on('disconnect', this.onZigbeeAdapterDisconnected.bind(this));
        this.zbController.on('new', this.newDevice.bind(this));
        this.zbController.on('leave', this.leaveDevice.bind(this));
        this.zbController.on('pairing', this.onPairing.bind(this));
        this.zbController.on('event', this.stController.onZigbeeEvent.bind(this.stController));
        this.zbController.on('msg', this.stController.onZigbeeEvent.bind(this.stController));
        this.zbController.on('publish', this.publishToState.bind(this));
        this.zbController.configure(zigbeeOptions);
        await this.callPluginMethod('configure', [zigbeeOptions]);

        // elevated debug handling
        this.deviceDebug.start(this.stController, this.zbController);

        this.reconnectCounter = 1;
        this.doConnect();
    }

    sandboxAdd(sandbox, item, module) {
        const multipleItems = item.split(',');
        if (multipleItems.length > 1) {
            for(const singleItem of multipleItems) {
                this.log.warn(`trying to add "${singleItem.trim()} = require(${module})[${singleItem.trim()}]" to sandbox`)
                sandbox[singleItem.trim()] = require(module)[singleItem.trim()];
            }
        }
        else {
            this.log.warn(`trying to add "${item} = require(${module})" to sandbox`)
            sandbox[item] = require(module);
        }
    }

    SandboxRequire(sandbox, items) {
        if (!items) return true;
        let converterLoaded = true;
        for (const item of items) {
            const modulePath = item[2].replace(/['"]/gm, '');

            let zhcm1 = modulePath.match(/^zigbee-herdsman-converters\//);
            if (zhcm1) {
                const i2 = modulePath.replace(/^zigbee-herdsman-converters\//, `../zigbee-herdsman-converters/`);
                try {
                    this.sandboxAdd(sandbox, item[1], i2);
                }
                catch (error) {
                    this.log.error(`Sandbox error: ${(error && error.message ? error.message : 'no error message given')}`);
                }
                continue;
            }
            zhcm1 = modulePath.match(/^..\//);
            if (zhcm1) {
                const i2 = modulePath.replace(/^..\//, `../zigbee-herdsman-converters/`);
                try {
                    this.sandboxAdd(sandbox, item[1], i2);
                }
                catch (error) {
                    this.log.error(`Sandbox error: ${(error && error.message ? error.message : 'no error message given')}`);
                    converterLoaded = false;
                }
                continue;
            }
            try {
                this.sandboxAdd(sandbox, item[1], modulePath);
            }
            catch (error) {
                this.log.error(`Sandbox error: ${(error && error.message ? error.message : 'no error message given')}`);
                converterLoaded = false;
            }

        }
        return converterLoaded;
    }


    * getExternalDefinition() {
        if (this.config.external === undefined) {
            return;
        }
        const extfiles = this.config.external.split(';');
        for (const moduleName of extfiles) {
            if (!moduleName) continue;
            const sandbox = {
                require,
                module: {},
            };
            const mN = (fs.existsSync(moduleName) ? moduleName : this.expandFileName(moduleName).replace('zigbee.', 'zigbee_'));
            if (!fs.existsSync(mN)) {
                this.log.warn(`External converter not loaded - neither ${moduleName} nor ${mN} exist.`);
            }
            else {
                const converterCode = fs.readFileSync(mN, {encoding: 'utf8'}).toString();
                let converterLoaded = true;
                let modifiedCode = converterCode.replace(/\s+\/\/.+/gm, ''); // remove all lines starting with // (with the exception of the first.)
                //fs.writeFileSync(mN+'.tmp1', modifiedCode)
                modifiedCode = modifiedCode.replace(/^\/\/.+/gm, ''); // remove the fist line if it starts with //
                //fs.writeFileSync(mN+'.tmp2', modifiedCode)

                converterLoaded &= this.SandboxRequire(sandbox,[...modifiedCode.matchAll(/import\s+\*\s+as\s+(\S+)\s+from\s+(\S+);/gm)]);
                modifiedCode = modifiedCode.replace(/import\s+\*\s+as\s+\S+\s+from\s+\S+;/gm, '')
                //fs.writeFileSync(mN+'.tmp3', modifiedCode)
                converterLoaded &= this.SandboxRequire(sandbox,[...modifiedCode.matchAll(/import\s+\{(.+)\}\s+from\s+(\S+);/gm)]);
                modifiedCode = modifiedCode.replace(/import\s+\{.+\}\s+from\s+\S+;/gm, '');

                converterLoaded &= this.SandboxRequire(sandbox,[...modifiedCode.matchAll(/import\s+(.+)\s+from\s+(\S+);/gm)]);
                modifiedCode = modifiedCode.replace(/import\s+.+\s+from\s+\S+;/gm, '');
                //fs.writeFileSync(mN+'.tmp4', modifiedCode)
                converterLoaded &= this.SandboxRequire(sandbox,[...modifiedCode.matchAll(/const\s+\{(.+)\}\s+=\s+require\((.+)\)/gm)]);
                modifiedCode = modifiedCode.replace(/const\s+\{.+\}\s+=\s+require\(.+\)/gm, '');
                //fs.writeFileSync(mN+'.tmp5', modifiedCode)
                converterLoaded &= this.SandboxRequire(sandbox,[...modifiedCode.matchAll(/const\s+(\S+)\s+=\s+require\((.+)\)/gm)]);
                modifiedCode = modifiedCode.replace(/const\s+\S+\s+=\s+require\(.+\)/gm, '');
                //fs.writeFileSync(mN+'.tmp6', modifiedCode)

                for(const component of modifiedCode.matchAll(/const (.+):(.+)=/gm)) {
                    modifiedCode = modifiedCode.replace(component[0], `const ${component[1]} = `);
                }
                modifiedCode = modifiedCode.replace(/export .+;/gm, '');

                fs.writeFileSync(mN+'.tmp', modifiedCode)

                if (converterLoaded) {
                    try {
                        this.log.warn('Trying to run sandbox for ' + mN);
                        vm.runInNewContext(modifiedCode, sandbox);
                        const converter = sandbox.module.exports;

                        if (Array.isArray(converter)) for (const item of converter) {
                            this.log.info('Model ' + item.model + ' defined in external converter ' + mN);
                            yield item;
                        }
                        else {
                            this.log.info('Model ' + converter.model + ' defined in external converter ' + mN);
                            yield converter;
                        }
                    }
                    catch (e) {
                        this.log.error(`Unable to apply converter from module: ${mN} - the code does not run: ${e}`);
                    }
                }
                else
                    this.log.info(`Ignoring converter from module: ${mN} - see warn messages for reason`);

            }
        }
    }

    applyExternalConverters() {
        for (const definition of this.getExternalDefinition()) {
            const toAdd = {...definition};
            delete toAdd['homeassistant'];
            try {
                const t = Date.now();
                if (zigbeeHerdsmanConverters.hasOwnProperty('addExternalDefinition')) {
                    zigbeeHerdsmanConverters.addExternalDefinition(toAdd);
                    this.log.info(`added external converter using addExternalDefinition (${Date.now()-t} ms)`)
                }
                else if (zigbeeHerdsmanConverters.hasOwnProperty('addDefinition')) {
                    zigbeeHerdsmanConverters.addDefinition(toAdd);
                    this.log.info(`added external converter using addDefinition (${Date.now()-t} ms)`);
                }
            } catch (e) {
                this.log.error(`unable to apply external converter for ${JSON.stringify(toAdd.model)}: ${e && e.message ? e.message : 'no error message available'}`);
            }
        }
    }

    async doConnect() {
        let debugversion = '';
        try {
            const DebugIdentify = require('./debugidentify');
            debugversion = DebugIdentify.ReportIdentifier();
        } catch {
            debugversion = 'npm ...';
        }

        // installed version
        let gitVers = '';
        try {
            this.log.info(`Starting Adapter ${debugversion}`);

            this.getForeignObject(`system.adapter.${this.namespace}`,async (err, obj) => {
                if (!err && obj && obj.common.installedFrom && obj.common.installedFrom.includes('://')) {
                    const instFrom = obj.common.installedFrom;
                    gitVers = gitVers + instFrom.replace('tarball', 'commit');
                } else {
                    gitVers = obj.common.installedFrom;
                }
                this.log.info(`Installed Version: ${gitVers} (Converters ${zigbeeHerdsmanConvertersPackage.version} Herdsman ${zigbeeHerdsmanPackage.version})`);
                await this.zbController.start();
            });

        } catch (error) {
            this.setState('info.connection', false, true);
            this.log.error(`Failed to start Zigbee`);
            if (error.stack) {
                this.log.error(error.stack);
            } else {
                this.log.error(error);
            }
            this.sendError(error, `Failed to start Zigbee`);

            if (this.reconnectCounter > 0) {
                this.tryToReconnect();
            }
        }
    }

    UploadRequired(status) {
        this.uploadRequired = (typeof status === 'boolean' ? status : this.uploadRequired) ;
        return status;
    }

    async onZigbeeAdapterDisconnected() {
        this.reconnectCounter = 5;
        this.log.error('Adapter disconnected, stopping');
        this.sendError('Adapter disconnected, stopping');
        this.setState('info.connection', false, true);
        await this.callPluginMethod('stop');
        this.tryToReconnect();
    }

    tryToReconnect() {
        this.reconnectTimer = setTimeout(() => {
            if (this.config.port.includes('tcp://')) {
                // Controller connect though Wi-Fi.
                // Unlikely USB dongle, connection broken may only cause user unplugged the dongle,
                // Wi-Fi connected gateway is possible that device connection is broken caused by
                // AP issue or Zigbee gateway power is turned off unexpectedly.
                // So try to reconnect gateway every 10 seconds all the time.
                this.log.info(`Try to reconnect.`);
            } else {
                this.log.info(`Try to reconnect. ${this.reconnectCounter} attempts left`);
                this.reconnectCounter -= 1;
            }
            this.doConnect();
        }, 10 * 1000); // every 10 seconds
    }

    async onZigbeeAdapterReady() {
        this.reconnectTimer && clearTimeout(this.reconnectTimer);
        this.log.info(`Zigbee started`);
        // https://github.com/ioBroker/ioBroker.zigbee/issues/668
        const extPanIdFix = this.config.extPanIdFix ? this.config.extPanIdFix : false;
        if (!extPanIdFix) {
            const configExtPanId = this.config.extPanID ? `0x${this.config.extPanID.toLowerCase()}` : '0xdddddddddddddddd';
            let networkExtPanId = (await this.zbController.herdsman.getNetworkParameters()).extendedPanID;
            let needChange = false;
            this.log.info(`Config value ${configExtPanId} : Network value ${networkExtPanId}`);
            const adapterType = this.config.adapterType || 'zstack';
            if (adapterType === 'zstack') {
                if (configExtPanId !== networkExtPanId) {
                    try {
                        // try to read from nvram
                        const result = await this.zbController.herdsman.adapter.znp.request(
                            1, // Subsystem.SYS
                            'osalNvRead',
                            {
                                id: 45, // EXTENDED_PAN_ID
                                len: 0x08,
                                offset: 0x00,
                            },
                            null, [
                                0, // ZnpCommandStatus.SUCCESS
                                2, // ZnpCommandStatus.INVALID_PARAM
                            ]
                        );
                        const nwExtPanId = `0x${result.payload.value.reverse().toString('hex')}`;
                        this.log.debug(`Config value ${configExtPanId} : nw value ${nwExtPanId}`);
                        if (configExtPanId !== nwExtPanId) {
                            networkExtPanId = nwExtPanId;
                            needChange = true;
                        }
                    } catch (e) {
                        this.log.error(`Unable to apply ExtPanID changes: ${e}`);
                        this.sendError(e, `Unable to apply ExtPanID changes`);
                        needChange = false;
                    }
                } else {
                    needChange = true;
                }
            }
            if (needChange) {
                // need change config value and mark that fix is applied
                this.log.debug(`Fix extPanId value to ${networkExtPanId}. And restart adapter.`);
                this.updateConfig({extPanID: networkExtPanId.substr(2), extPanIdFix: true});
            } else {
                // only mark that fix is applied
                this.log.debug(`Fix without changes. And restart adapter.`);
                this.updateConfig({extPanIdFix: true});
            }
        }

        await this.setState('info.connection', true, true);
        this.stController.CleanupRequired(false);
        const devicesFromDB = this.zbController.getClientIterator(false);
        for (const device of devicesFromDB) {
            const entity = await this.zbController.resolveEntity(device);
            if (entity) {
                const model = entity.mapped ? entity.mapped.model : entity.device.modelID;
                this.stController.updateDev(device.ieeeAddr.substr(2), model, model, () =>
                    this.stController.syncDevStates(device, model));
            }
            else (this.log.warn('resolveEntity returned no entity'));
        }
        await this.callPluginMethod('start', [this.zbController, this.stController]);
    }

    async checkIfModelUpdate(entity) {
        const model = entity.mapped ? entity.mapped.model : entity.device.modelID;
        const device = entity.device;
        const devId = device.ieeeAddr.substr(2);

        return new Promise((resolve) => {
            this.getObject(devId, (err, obj) => {
                if (obj && obj.common.type !== model) {
                    // let's change model
                    this.getStatesOf(devId, (err, states) => {
                        if (!err && states) {
                            const chain = [];
                            states.forEach((state) =>
                                chain.push(this.deleteStateAsync(devId, null, state._id)));

                            Promise.all(chain)
                                .then(() =>
                                    this.stController.deleteObj(devId, () =>
                                        this.stController.updateDev(devId, model, model, async () => {
                                            await this.stController.syncDevStates(device, model);
                                            resolve();
                                        })));
                        } else {
                            resolve();
                        }
                    });
                } else {
                    resolve();
                }
            });
        });
    }

    publishToState(devId, model, payload) {
        this.stController.publishToState(devId, model, payload);
    }

    acknowledgeState(deviceId, model, stateDesc, value) {
        if (model === 'group') {
            const stateId = `${this.namespace}.group_${deviceId}.${stateDesc.id}`;
            this.setState(stateId, value, true);
        } else {
            const stateId = `${this.namespace}.${deviceId.replace('0x', '')}.${stateDesc.id}`;
            this.setState(stateId, value, true);
        }
    }

    processSyncStatesList(deviceId, model, syncStateList) {
        syncStateList.forEach((syncState) => {
            this.acknowledgeState(deviceId, model, syncState.stateDesc, syncState.value);
        });
    }

    async publishFromState(deviceId, model, stateModel, stateList, options, debugID) {
        let isGroup = false;
        const has_elevated_debug = this.stController.checkDebugDevice(deviceId)

        if (has_elevated_debug)
        {
            const stateNames = [];
            for (const state of stateList) {
                stateNames.push(state.stateDesc.id);
            }
            const message = `Publishing to ${deviceId} of model ${model} with ${stateNames.join(', ')}`;
            this.emit('device_debug', { ID:debugID, data: { ID: deviceId, flag: '03', IO:false }, message: message});
        }
        else
            this.log.debug(`publishFromState : ${deviceId} ${model} ${safeJsonStringify(stateList)}`);
        if (model === 'group') {
            isGroup = true;
            deviceId = parseInt(deviceId);
        }
        try {
            const entity = await this.zbController.resolveEntity(deviceId);
            this.log.debug(`entity: ${deviceId} ${model} ${safeJsonStringify(entity)}`);
            const mappedModel = entity ? entity.mapped : undefined;

            if (!mappedModel) {
                this.log.debug(`No mapped model for ${model}`);
                if (has_elevated_debug) {
                    const message=`No mapped model ${deviceId} (model ${model})`;
                    this.emit('device_debug', { ID:debugID, data: { error: 'NOMODEL' , IO:false }, message: message});
                }
                return;
            }

            if (!mappedModel.toZigbee)
            {
                this.log.error(`No toZigbee in mapped model for ${model}`);
                return;
            }

            stateList.forEach(async changedState => {
                const stateDesc = changedState.stateDesc;
                const value = changedState.value;

                if (stateDesc.id === 'send_payload') {
                    try {
                        const json_value = JSON.parse(value);
                        const payload = {device: deviceId.replace('0x', ''), payload: json_value, model:model, stateModel:stateModel};
                        if (has_elevated_debug) this.emit('device_debug', { ID:debugID, data: { flag: '04' ,payload:value ,states:[{id:stateDesc.id, value:json_value, payload:'none'}], IO:false }});

                        const result = await this.sendPayload(payload);
                        if (result.hasOwnProperty('success') && result.success) {
                            this.acknowledgeState(deviceId, model, stateDesc, value);
                        }
                        else {
                            this.error('Error in SendPayload: '+result.error.message);
                        }
                    } catch (error) {
                        const message = `send_payload: ${value} does not parse as JSON Object : ${error.message}`;
                        if (has_elevated_debug) this.emit('device_debug', { ID:debugID, data: { error: 'EXSEND' ,states:[{id:stateDesc.id, value:value, payload:error.message}], IO:false }, message:message});
                        else this.error(message);
                        return;
                    }
                    return;
                }

                if (stateDesc.isOption || stateDesc.compositeState) {
                    // acknowledge state with given value
                    if (has_elevated_debug) {
                        const message = 'changed state: ' + JSON.stringify(changedState);
                        this.emit('device_debug', { ID:debugID, data: { flag: 'cc', states:[{id:stateDesc.id, value:value, payload:'none (OC State)'}] , IO:false }, message:message});
                    }
                    else
                        this.log.debug('changed composite state: ' + JSON.stringify(changedState));

                    this.acknowledgeState(deviceId, model, stateDesc, value);
                    if (stateDesc.compositeState && stateDesc.compositeTimeout) {
                        this.stController.triggerComposite(deviceId, model, stateDesc, changedState.source.includes('.admin.'));
                    }
                    // on activation of the 'device_query' state trigger hardware query where possible
                    if (stateDesc.id === 'device_query') {
                        if (this.query_device_block.indexOf(deviceId) > -1) {
                            this.log.info(`Device query for '${entity.device.ieeeAddr}' blocked`);
                            return;
                        }
                        if (mappedModel) {
                            this.query_device_block.push(deviceId);
                            if (has_elevated_debug) {
                                const message  = `Device query for '${entity.device.ieeeAddr}/${entity.device.endpoints[0].ID}' triggered`;
                                this.emit('device_debug', { ID:debugID, data: { flag: 'qs' ,states:[{id:stateDesc.id, value:value, payload:'none for device query'}], IO:false }, message:message});
                            }
                            else
                                this.log.debug(`Device query for '${entity.device.ieeeAddr}' started`);
                            for (const converter of mappedModel.toZigbee) {
                                if (converter.hasOwnProperty('convertGet')) {
                                    for (const ckey of converter.key) {
                                        try {
                                            await converter.convertGet(entity.device.endpoints[0], ckey, {});
                                        } catch (error) {
                                            if (has_elevated_debug) {
                                                const message = `Failed to read state '${JSON.stringify(ckey)}'of '${entity.device.ieeeAddr}/${entity.device.endpoints[0].ID}' from query with '${error && error.message ? error.message : 'no error message'}`;
                                                this.log.warn(`ELEVATED OE02.1 ${message}`);
                                                this.emit('device_debug', { ID:debugID, data: { error: 'NOTREAD' , IO:false }, message:message });
                                            }
                                            else
                                                this.log.info(`failed to read state ${JSON.stringify(ckey)} of ${entity.device.ieeeAddr}/${entity.device.endpoints[0].ID} after device query`);
                                        }
                                    }
                                }
                            }
                            if (has_elevated_debug) {
                                const message = `ELEVATED O07: Device query for '${entity.device.ieeeAddr}/${entity.device.endpoints[0].ID}' complete`;
                                this.emit('device_debug', { ID:debugID, data: { flag: 'qe' , IO:false }, message:message});
                            }
                            else
                                this.log.info(`Device query for '${entity.device.ieeeAddr}' done`);
                            const idToRemove = deviceId;
                            setTimeout(() => {
                                const idx = this.query_device_block.indexOf(idToRemove);
                                if (idx > -1) {
                                    this.query_device_block.splice(idx);
                                }
                            }, 10000);
                        }
                        return;
                    }
                    return;
                }

                let converter = undefined;
                let msg_counter = 0;
                for (const c of mappedModel.toZigbee) {

                    if (!c.hasOwnProperty('convertSet')) continue;
                    this.log.debug(`Type of toZigbee is '${typeof c}', Contains key ${(c.hasOwnProperty('key')?JSON.stringify(c.key):'false ')}`)
                    if (!c.hasOwnProperty('key'))
                    {
                        if (converter === undefined)
                        {
                            converter = c;
                            if (has_elevated_debug) {
                                const message = `Setting converter to keyless converter for ${deviceId} of type ${model}`;
                                this.emit('device_debug', { ID:debugID, data: { flag: `s4.${msg_counter}` , IO:false }, message:message});
                            }
                            else
                                this.log.debug(`Setting converter to keyless converter for ${deviceId} of type ${model}`);
                            msg_counter++;
                        }
                        else
                        {
                            if (has_elevated_debug)
                            {
                                const message = `ignoring keyless converter for ${deviceId} of type ${model}`;
                                this.emit('device_debug', { ID:debugID, data: { flag: `i4.${msg_counter}` , IO:false} , message:message});
                            }
                            else
                                this.log.debug(`ignoring keyless converter for ${deviceId} of type ${model}`);
                            msg_counter++;
                        }
                        continue;
                    }
                    if (c.key.includes(stateDesc.prop) || c.key.includes(stateDesc.setattr) || c.key.includes(stateDesc.id))
                    {
                        const message = `${(converter===undefined?'Setting':'Overriding')}' converter to converter with key(s)'${JSON.stringify(c.key)}}`;
                        if (has_elevated_debug) {
                            this.emit('device_debugug', { ID:debugID, data: { flag: `${converter===undefined ? 's' : 'o'}4.${msg_counter}` , IO:false }, message:message});

                        }
                        else
                            this.log.debug(message);
                        converter = c;
                        msg_counter++;
                    }
                }
                if (converter === undefined) {
                    const message = `No converter available for '${model}' with key '${stateDesc.id}' `;
                    if (has_elevated_debug) {
                        this.emit('device_debug', { ID:debugID, data: { error: 'NOCONV',states:[{id:stateDesc.id, value:value, payload:'no converter'}] , IO:false }, message:message});
                    }
                    else {
                        this.log.warn(message);
                    }
                    return;
                }

                const preparedValue = (stateDesc.setter) ? stateDesc.setter(value, options) : value;
                const preparedOptions = (stateDesc.setterOpt) ? stateDesc.setterOpt(value, options) : {};

                let syncStateList = [];
                if (stateModel && stateModel.syncStates) {
                    stateModel.syncStates.forEach(syncFunct => {
                        const res = syncFunct(stateDesc, value, options);
                        if (res) {
                            syncStateList = syncStateList.concat(res);
                        }
                    });
                }

                const epName = stateDesc.epname !== undefined ? stateDesc.epname : (stateDesc.prop || stateDesc.id);
                const key = stateDesc.setattr || stateDesc.prop || stateDesc.id;
                const message = `convert ${key}, ${safeJsonStringify(preparedValue)}, ${safeJsonStringify(preparedOptions)} for device ${deviceId} with Endpoint ${epName}`;
                if (has_elevated_debug) {
                    this.emit('device_debug', { ID:debugID, data: { flag: '04', payload: {key:key, ep: stateDesc.epname, value:preparedValue, options:preparedOptions}, IO:false }, message:message});
                }
                else
                    this.log.debug(message);

                let target;
                if (model === 'group') {
                    target = entity.mapped;
                } else {
                    target = await this.zbController.resolveEntity(deviceId, epName);
                    target = target.endpoint;
                }

                this.log.debug(`target: ${safeJsonStringify(target)}`);

                const meta = {
                    endpoint_name: epName,
                    options: preparedOptions,
                    device: entity.device,
                    mapped: model === 'group' ? [] : mappedModel,
                    message: {[key]: preparedValue},
                    logger: this.log,
                    state: {},
                };

                // new toZigbee
                if (preparedValue !== undefined && Object.keys(meta.message).filter(p => p.startsWith('state')).length > 0) {
                    if (typeof preparedValue === 'number') {
                        meta.message.state = preparedValue > 0 ? 'ON' : 'OFF';
                    } else {
                        meta.message.state = preparedValue;
                    }
                }
                if (has_elevated_debug) {
                    this.emit('device_debug', { ID:debugID, data: { states:[{id:stateDesc.id, value:value, payload:preparedValue, ep:stateDesc.epname}] , IO:false }});
                }

                if (preparedOptions !== undefined) {
                    if (preparedOptions.hasOwnProperty('state')) {
                        meta.state = preparedOptions.state;
                    }
                }

                try {
                    const result = await converter.convertSet(target, key, preparedValue, meta);
                    const message = `convert result ${safeJsonStringify(result)} for device ${deviceId}`;
                    if (has_elevated_debug) {
                        this.emit('device_debug', { ID:debugID, data: { flag: 'SUCCESS' , IO:false }, message:message});
                    }
                    else
                        this.log.debug(message);
                    if (result !== undefined) {
                        if (stateModel && !isGroup && !stateDesc.noack) {
                            this.acknowledgeState(deviceId, model, stateDesc, value);
                        }
                        // process sync state list
                        this.processSyncStatesList(deviceId, model, syncStateList);
                    }
                    else {
                        if (has_elevated_debug) {
                            const message = `Convert does not return a result result for ${key} with ${safeJsonStringify(preparedValue)} on device ${deviceId}.`;
                            this.emit('device_debug', { ID:debugID, data: { flag: '06' , IO:false }, message:message});
                        }
                    }
                } catch (error) {
                    if (has_elevated_debug) {
                        const message = `caught error ${safeJsonStringify(error)} when setting value for device ${deviceId}.`;
                        this.emit('device_debug', { ID:debugID, data: { error: 'EXSET' , IO:false },message:message});
                    }
                    this.filterError(`Error ${error.code} on send command to ${deviceId}.` +
                        ` Error: ${error.stack}`, `Send command to ${deviceId} failed with`, error);
                }
            });
        } catch (err) {
            const message = `No entity for ${deviceId} : ${err && err.message ? err.message : 'no error message'}`;
            this.emit('device_debug', { ID:debugID, data: { error: 'EXPUB' , IO:false }, message:message});
        }
    }


    extractEP(key, endpoints) {
        try {
            if (endpoints) for (const ep of Object.keys(endpoints)) {
                if (key.endsWith('_'+ep)) return { setattr: key.replace('_'+ep, ''), epname:ep }
            }
        }
        catch {
            return {};
        }
        return {};
    }
    // This function is introduced to explicitly allow user level scripts to send Commands
    // directly to the zigbee device. It utilizes the zigbee-herdsman-converters to generate
    // the exact zigbee message to be sent and can be used to set device options which are
    // not exposed as states. It serves as a wrapper function for "publishFromState" with
    // extended parameter checking
    //
    // The payload can either be a JSON object or the string representation of a JSON object
    // The following keys are supported in the object:
    // device: name of the device. For a device zigbee.0.0011223344556677 this would be 0011223344556677
    // payload: The data to send to the device as JSON object (key/Value pairs)
    // endpoint: optional: the endpoint to send the data to, if supported.
    //
    async sendPayload(payload) {
        let payloadObj = {};
        if (typeof payload === 'string') {
            try {
                payloadObj = JSON.parse(payload);
            } catch (e) {
                this.log.error(`Unable to parse ${safeJsonStringify(payload)}: ${safeJsonStringify(e)}`);
                this.sendError(e, `Unable to parse ${safeJsonStringify(payload)}: ${safeJsonStringify(e)}`);
                return {
                    success: false,
                    error: `Unable to parse ${safeJsonStringify(payload)}: ${safeJsonStringify(e)}`
                };
            }
        } else if (typeof payload === 'object') {
            payloadObj = payload;
        } else return { success: false, error: 'illegal type of payload: ' + typeof payload};

        if (payloadObj.hasOwnProperty('device') && payloadObj.hasOwnProperty('payload')) {
            try {
                const isDevice = !payload.device.includes('group_');
                const stateList = [];
                const devID = isDevice ? `0x${payload.device}` : parseInt(payload.device.replace('group_', ''));

                const entity = await this.zbController.resolveEntity(devID);
                if (!entity) {
                    this.log.error(`Device ${safeJsonStringify(payloadObj.device)} not found`);
                    this.sendError(`Device ${safeJsonStringify(payloadObj.device)} not found`);
                    return {success: false, error: `Device ${safeJsonStringify(payloadObj.device)} not found`};
                }
                const mappedModel = entity.mapped;
                if (!mappedModel) {
                    this.log.error(`No Model for Device ${safeJsonStringify(payloadObj.device)}`);
                    this.sendError(`No Model for Device ${safeJsonStringify(payloadObj.device)}`);
                    return {success: false, error: `No Model for Device ${safeJsonStringify(payloadObj.device)}`};
                }
                if (typeof payloadObj.payload !== 'object') {
                    this.log.error(`Illegal payload type for ${safeJsonStringify(payloadObj.device)}`);
                    this.sendError(`Illegal payload type for ${safeJsonStringify(payloadObj.device)}`);
                    return {success: false, error: `Illegal payload type for ${safeJsonStringify(payloadObj.device)}`};
                }
                const endpoints = mappedModel && mappedModel.endpoint ? mappedModel.endpoint(entity.device) : null;
                for (const key in payloadObj.payload) {
                    if (payloadObj.payload[key] != undefined) {
                        const datatype = typeof payloadObj.payload[key];
                        const epobj = this.extractEP(key, endpoints);
                        if (payloadObj.endpoint) {
                            epobj.epname = payloadObj.endpoint;
                            delete epobj.setattr;
                        }
                        stateList.push({
                            stateDesc: {
                                id: key,
                                prop: key,
                                role: 'state',
                                type: datatype,
                                noack:true,
                                epname: epobj.epname,
                                setattr: epobj.setattr,
                            },
                            value: payloadObj.payload[key],
                            index: 0,
                            timeout: 0,
                        });
                    }
                }
                try {
                    await this.publishFromState(`0x${payload.device}`, payload.model, payload.stateModel, stateList, payload.options, Date.now());
                    return {success: true};
                } catch (error) {
                    this.log.error(`Error ${error.code} on send command to ${payload.device}.` + ` Error: ${error.stack} ` + `Send command to ${payload.device} failed with ` + error);
                    this.filterError(`Error ${error.code} on send command to ${payload.device}.` + ` Error: ${error.stack}`, `Send command to ${payload.device} failed with`, error);
                    return {success: false, error};
                }
            } catch (e) {
                return {success: false, error: e};
            }
        }

        return {success: false, error: `missing parameter device or payload in message ${JSON.stringify(payload)}`};
    }


    newDevice(entity) {
        const dev = entity.device;
        const model = (entity.mapped) ? entity.mapped.model : dev.modelID;
        this.log.debug(`New device event: ${safeJsonStringify(entity)}`);
        if (!entity.mapped && !entity.device.interviewing) {
            const msg = `New device: '${dev.ieeeAddr}' does not have a known model. please provide an external converter for '${dev.modelID}'.`;
            this.log.warn(msg);
            this.logToPairing(msg, true);
        }
        this.stController.AddModelFromHerdsman(entity.device, model)
        if (dev) {
            this.getObject(dev.ieeeAddr.substr(2), (err, obj) => {
                if (!obj) {
                    this.log.debug(`new device ${dev.ieeeAddr} ${dev.networkAddress} ${model} `);
                    this.logToPairing(`New device joined '${dev.ieeeAddr}' model ${model}`, true);
                    this.stController.updateDev(dev.ieeeAddr.substr(2), model, model, () =>
                        this.stController.syncDevStates(dev, model));
                }
                else this.log.debug(`Device ${safeJsonStringify(entity)} rejoined, no new device`);
            });
        }
    }

    leaveDevice(ieeeAddr) {
        this.log.debug(`Leave device event: ${ieeeAddr}`);
        if (ieeeAddr) {
            const devId = ieeeAddr.substr(2);
            this.log.debug(`Delete device ${devId} from iobroker.`);
            this.stController.deleteObj(devId);
        }
    }

    async callPluginMethod(method, parameters) {
        for (const plugin of this.plugins) {
            if (plugin[method]) {
                try {
                    if (parameters !== undefined) {
                        await plugin[method](...parameters);
                    } else {
                        await plugin[method]();
                    }
                } catch (error) {
                    if (error && !error.hasOwnProperty('code')) {
                        this.log.error(`Failed to call '${plugin.constructor.name}' '${method}' (${error.stack})`);
                        this.sendError(error, `Failed to call '${plugin.constructor.name}' '${method}'`);
                    }
                    throw error;
                }
            }
        }
    }

    /**
     * @param {() => void} callback
     */
    async onUnload(callback) {
        try {
            if (this.config.debugHerdsman) {
                debug.disable();
                debug.log = originalLogMethod;
            }

            this.log.info('cleaned everything up...');
            if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
            await this.callPluginMethod('stop');
            if (this.zbController) {
                await this.zbController.stop();
            }
            callback();
        } catch (error) {
            if (error) {
                this.log.error(`Unload error (${error.stack})`);
            }
            this.sendError(error, `Unload error`);
            callback();
        }
    }

    getZigbeeOptions() {
        // file path for db
        let dbDir = path.join(utils.getAbsoluteInstanceDataDir(this), '');
        dbDir = dbDir.replace('zigbee.', 'zigbee_');

        if (this.systemConfig && !fs.existsSync(dbDir)) {
            try {
                fs.mkdirSync(dbDir);
            } catch (e) {
                this.log.error(`Cannot create directory ${dbDir}: ${e}`);
                this.sendError(`Cannot create directory ${dbDir}: ${e}`);
            }
        }
        const port = this.config.port;
        if (!port) {
            this.log.error('Serial port not selected! Go to settings page.');
            this.sendError('Serial port not selected! Go to settings page.');
        }
        const panID = parseInt(this.config.panID ? this.config.panID : 0x1a62);
        const channel = parseInt(this.config.channel ? this.config.channel : 11);
        const precfgkey = createByteArray(this.config.precfgkey ? this.config.precfgkey : '01030507090B0D0F00020406080A0C0D');
        const extPanId = createByteArray(this.config.extPanID ? this.config.extPanID : 'DDDDDDDDDDDDDDDD').reverse();
        const adapterType = this.config.adapterType || 'zstack';
        // https://github.com/ioBroker/ioBroker.zigbee/issues/668
        const extPanIdFix = this.config.extPanIdFix ? this.config.extPanIdFix : false;
        const baudRate = parseInt(this.config.baudRate ? this.config.baudRate : 115200);

        const setRtscts = this.config.flowCTRL ? this.config.flowCTRL : false;

        return {
            net: {
                panId: panID,
                extPanId: extPanId,
                channelList: [channel],
                precfgkey: precfgkey
            },
            sp: {
                port: port,
                baudRate: baudRate,
                rtscts: setRtscts,
                adapter: adapterType,
            },
            dbDir: dbDir,
            dbPath: 'shepherd.db',
            backupPath: 'nvbackup.json',
            disableLed: this.config.disableLed,
            disablePing: this.config.disablePing,
            transmitPower: this.config.transmitPower,
            disableBackup: this.config.disableBackup,
            extPanIdFix: extPanIdFix,
            startWithInconsistent: this.config.startWithInconsistent || false,
        };
    }

    onPairing(message, data) {
        if (Number.isInteger(data)) {
            this.setState('info.pairingCountdown', data, true);
        }
        if (data === 0) {
            // set pairing mode off
            this.setState('info.pairingMode', false, true);
        }
        if (data) {
            this.logToPairing(`${message}: ${data.toString()}`);
        } else {
            this.logToPairing(`${message}`);
        }
    }

    logToPairing(message) {
        this.setState('info.pairingMessage', message, true);
    }

    expandFileName(fn) {
        return path.join(utils.getAbsoluteInstanceDataDir(this), fn);
    }

    onLog(level, msg, data) {
        if (msg) {
            let logger = this.log.info;
            switch (level) {
                case 'error':
                    logger = this.log.error;
                    if (data)
                        data = data.toString();
                    this.logToPairing(`Error: ${msg}. ${data}`, true);
                    this.sendError(`Error: ${msg}. ${data}`);
                    break;
                case 'debug':
                    logger = this.log.debug;
                    break;
                case 'info':
                    logger = this.log.info;
                    break;
                case 'warn':
                    logger = this.log.warn;
                    break;
            }
            if (data) {
                if (typeof data === 'string') {
                    logger(`${msg}. ${data}`);
                } else {
                    logger(`${msg}. ${safeJsonStringify(data)}`);
                }
            } else {
                logger(msg);
            }
        }
    }
}


if (module && module.parent) {
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Zigbee(options);
} else {
    // or start the instance directly
    new Zigbee();
}
