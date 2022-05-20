#! /usr/bin/env node-strict
module.exports = exports = new (function Unknown() {
    Object.assign(this, {
        Establish: Establish,   // state-machine to action the channel establish
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name,
    chain = require('scope-chain'),
    debug = require('debug')(Variant.toLowerCase()),
    main = require.main.exports,
    worker = require('../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor ' + Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    enter: function () {
        debug(this.communicator.session.sid, 'Establish.enter:');
        if ('unknown' in this.communicator.session.context === false)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null, 'refused'), 0);

        return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Establish.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude && this.conclude(conclusion); // Establish
    },
    action: function () {
        debug(this.communicator.session.sid, 'Establish.action:', this.communicator.session.context.unknown);
        this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.unknown, _unknown: 'CatchAll' });
    },
});
