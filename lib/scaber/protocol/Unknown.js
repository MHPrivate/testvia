#! /usr/bin/env node-strict
module.exports = exports = new (function Unknown() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Protocol:' + module.exports.constructor.name,
    chain = require('scope-chain'),
    debug = require('debug')(Variant.toLowerCase()),
    main = require.main.exports,
    worker = require('../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(leg, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor ' + Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        if ('unknown' in this.leg.session.context === false)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null, 'refused'), 0);

        return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.leg.session.sid, 'leave:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        this.conclude && this.conclude(conclusion); // Establish
    },
    action: function () {
        debug(this.leg.session.sid, 'action:', this.leg.session.context.unknown);
        this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.unknown, _unknown: 'CatchAll' });
    },
});
