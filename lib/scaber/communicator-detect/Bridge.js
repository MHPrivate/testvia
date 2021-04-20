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
function Establish(communicator, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    enter: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.enter:', JSON.stringify({ enterMs: Date.now() - this.communicator.answered }));
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.communicator.session.sid, 'Establish.leave:', JSON.stringify({ leaveMs: Date.now() - this.communicator.answered, conclusion: conclusion }));
        this.timeout = worker.resetTimeout(this.timeout);
        this.conclude(conclusion); // Establish
    },
    action: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.action:', (this.communicator.session.context || {}).bridge || 'non-bridge', JSON.stringify({ actionMs: Date.now() - this.communicator.answered }));
        switch ((this.communicator.session.context || {}).bridge) {
            case undefined: // missing 'bridge' - so refuse (this protocol)
                this.enter(null, 'refused');
                break;

            case '': // empty 'bridge' - so release/reject (the call)
                this.enter(null, 'release');
                break;

            default: // presumably a useful 'bridge' target'
                this.enter(null, 'verified');
                break;
        }
        return this;
    },
});
