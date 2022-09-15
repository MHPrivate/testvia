#! /usr/bin/env node-strict
var debug = require('debug')('protocol:bsia');

module.exports = exports = new (function Bsia() {
    Object.assign(this, {
        Establish: require('./Bsia/Establish'),   // state-machine to action the channel establish
        debug: debug,                               // for reference by substates
        dtmfMaxMs: 2500,                            // max valid DTMF duration
    });
})();
