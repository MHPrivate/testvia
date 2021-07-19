#! /usr/bin/env node-strict
var StateMachine = require('../../state-machine');
var util = require('util');
module.exports = new (function Bs8521() {
    Object.assign(this, {
        Close: require('./Bs8521/Close'),           // state-machine to action channel-close
        Establish: require('./Bs8521/Establish'),   // state-machine to action the channel establish
        Keepalive: require('./Bs8521/Null'),        // state-machine to action the keepalive control
        Speech: require('./Bs8521/Speech'),         // state-machine to action simplex/duplex control
        dtmfMaxMs: 2500,                            // max valid DTMF duration
        keepaliveMs: 60000,                         // time between keep-online messages
    });
    var properties = {
        debug: { value: require('debug')(('Communicator:Detect:' + this.constructor.name).toLowerCase()) },
        protocol: { value: this },
    };
    Object.keys(this).forEach(function (key, idx, arr) {
        if (typeof this[key] === 'function')
            util.inherits(Object.defineProperties(this[key], properties), StateMachine);
    }, this);
})();
