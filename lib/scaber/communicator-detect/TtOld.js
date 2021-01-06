#! /usr/bin/env node-strict
module.exports = new (function TtOld() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
        dtmfMaxMs: 2500,        // max valid DTMF duration
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name;
var chain = require('scope-chain');
var debug = require('debug')(Variant.toLowerCase());
var esl = require('../../esl');
var main = require.main.exports;
var worker = require('../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');
    Establish.super_.call(this, Establish, {
        communicator: communicator, // reference to parent state-machine
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, {
    enter: function () {
        debug(this.communicator.session.sid, 'Establish.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), 0);
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Establish.leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.communicator.signal('establish', false);
    },
});