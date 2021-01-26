#! /usr/bin/env node-strict
module.exports = new (function Guard() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name;
var chain = require('scope-chain');
var debug = require('debug')(Variant.toLowerCase());
var esl = require('../../esl');
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
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    guardMs: 3700,              // guard-tone detection period (from TTnew/TTold sect 4.1)
    silenceMs: 500,             // post guard-tone delay

    enter: function () {
        debug(this.communicator.session.sid, 'Establish.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Establish.leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.leave:', err);
            sm.communicator.signal('establish', false);

        }, function () {
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.communicator.uuid, this);

        });
    },
    action: function () {
        debug(this.communicator.session.sid, 'Establish.action:');
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.action:', err);
            sm.enter(null)

        }, function () {
            esl.executeAsyncX('set', ['park_after_bridge=true'], sm.communicator.uuid, this); // must enable drop_dtmf when we consume

        }, function (evt) {
            sm.communicator.signal('answer', this);

        }, function (evt) {
            esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-junk'], sm.communicator.uuid, this);

        }, function (evt) {
            sm.timeout = worker.resetTimeout(sm.timeout, this, Establish.guardMs);

        });
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, 'Establish.TONE:', evt.headers['Detected-Tone']);
        return this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), Establish.silenceMs);
    },
    DTMF: function (evt) {
        debug(this.communicator.session.sid, 'Establish.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data, timeoutMs + 'ms');
        this.communicator.guardDTMF = true;
        return this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), Establish.silenceMs);
    },
});
