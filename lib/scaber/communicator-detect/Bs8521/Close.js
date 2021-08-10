var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl')
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

require('util').inherits(module.exports = exports = Close, require('../../../state-machine'));
function Close(communicator, conclude) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor', 'Communicator:Detect:Bs8521:' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    dumpMs: 10000,              // silence delay to forced hangup
    tones: 'a@250+d@80',        // pathClose tones

    enter: function () {
        debug(this.communicator.session.sid, 'enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude && this.conclude(); // Close
    },
    action: function () {
        debug(this.communicator.session.sid, 'action:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);


        }, function (evt) {
            debug(sm.communicator.session.sid, 'action.2:', 'send_dtmf', exports.tones, exports.dumpMs, new Date);
            esl.executeAsyncX('send_dtmf', [exports.tones], sm.communicator.uuid, this);

        });
        return this;
    },
    release: function () {
        debug(this.communicator.session.sid, 'release:');
        this.enter(null);
    },
});
