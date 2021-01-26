#! /usr/bin/env node-strict
module.exports = new (function Bridge() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name;
var chain = require('scope-chain');
var debug = require('debug')(Variant.toLowerCase());
var main = require.main.exports;
var worker = require('../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');
    Establish.super_.call(this, Establish, { // instance setup
        communicator: communicator, // reference to parent state-machine
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // cli-match outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    enter: function () {
        debug(this.communicator.session.sid, 'Establish.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Establish.leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.communicator.signal('establish', !!this.verified);
    },
    action: function () {
        debug(this.communicator.session.sid, 'Establish.action:', (this.communicator.session.context || {}).bridge);
        this.verified = !!(this.communicator.session.context || {}).bridge;
        this.enter(null);
        return this;
    },
});
