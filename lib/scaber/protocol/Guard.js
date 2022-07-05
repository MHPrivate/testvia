#! /usr/bin/env node-strict
module.exports = exports = new (function Guard() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Protocol:' + module.exports.constructor.name,
    chain = require('scope-chain'),
    debug = require('debug')(Variant.toLowerCase()),
    esl = require('../../esl'),
    main = require.main.exports,
    worker = require('../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(leg, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor ' + Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        conclude: conclude,         // callback to signal State complete
        guardMs: isNaN(leg.session.context.guardMs) ? Establish.guardMs : leg.session.context.guardMs,
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
        verified: undefined,        // default outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    guardMs: 4600,              // guard-tone detection period (from TTnew/TTold sect 4.1)
    silenceMs: 500,             // post guard-tone delay

    enter: function () {
        debug(this.leg.session.sid, 'Establish.enter:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.leg.session.sid, 'Establish.leave:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, Variant + ':Establish.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            debug(sm.leg.session.sid, 'Establish.leave.1:', 'spandsp_stop_tone_detect', new Date);
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.leg.uuid, this);

        });
    },
    action: function () {
        debug(this.leg.session.sid, 'Establish.action:');
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, Variant + ':Establish.action:', err);
            sm.enter(null);

        }, function () {
            esl.executeAsyncX('set', ['park_after_bridge=true'], sm.leg.uuid, this); // must enable drop_dtmf when we consume

        }, function (evt) {
            sm.leg.signal('answer', this);

        }, function (evt) {
            debug(sm.leg.session.sid, 'Establish.action:', 'spandsp_start_tone_detect:junk', new Date);
            esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-junk'], sm.leg.uuid, this);

        }, function (evt) {
            sm.timeout = worker.resetTimeout.call(sm.leg.session.sid, sm.timeout, this, sm.guardMs);

        });
    },
    DETECTED_TONE: function (evt) {
        debug(this.leg.session.sid, 'Establish.TONE:', evt.headers['Detected-Tone']);
        return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), Establish.silenceMs);
    },
    DTMF: function (evt) {
        debug(this.leg.session.sid, 'Establish.DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8), Establish.silenceMs + 'ms');
        this.leg.guardDTMF = true;
        return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), Establish.silenceMs);
    },
});
