'use strict';

const fs = require('node:fs');

const { basePlugin } = require('./pluginBase.js');

class SerialList extends basePlugin {
    constructor(adapter) {
        super(adapter);
        this.adapter.on('message', obj => this.onMessage(obj));
        this.pluginName = 'SerialList';
    }

    /**
     * @param {ioBroker.Message} obj
     */
    onMessage(obj) {
        if (typeof obj === 'object' && obj.command) {
            switch (obj.command) {
                case 'listUart':
                {
                    const candidates = [];
                    if (obj.callback) {
                        require('fs').readdir('/dev/serial/by-id', (err, files) => {
                            if (!err) {
                                for (const item of files)
                                    candidates.push({comName: `/dev/serial/by-id/${item}`});
                            }
                            const shortNames = [];
                            for (const candidate of candidates) {
                                fs.readlink(candidate.comName, (err, target) => {
                                    if (!err) {
                                        shortNames.push({comName: target})
                                    }
                                });
                            }
                            this.sendTo(obj.from, obj.command, candidates.reverse(), obj.callback);
                        })
                    }
                    break;
                }
            }
        }
    }
}

module.exports = SerialList;
