var chain = require('scope-chain');
var debug;
var esl = require('../../../esl');
var worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = exports = function Close(communicator, conclude) {
    debug || (debug = exports.debug);
    if (this instanceof exports === false)
        throw new Error('Constructor', 'Communicator:Detect:' + exports.protocol.constructor.name + ':' + exports.name + ' requires \'new\'');

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
        debug(this.communicator.session.sid, exports.name + '.enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, exports.name + '.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(); // Close
    },
    action: function () {
        debug(this.communicator.session.sid, exports.name + '.action:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.action:', err);

        }, function () {
            debug(sm.communicator.session.sid, exports.name + '.action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);


        }, function (evt) {
            debug(sm.communicator.session.sid, exports.name + '.action.2:', 'send_dtmf', exports.tones);
            esl.executeAsyncX('send_dtmf', [exports.tones], sm.communicator.uuid, this);

        });
        return this;
    },
    release: function () {
        debug(this.communicator.session.sid, exports.name + '.release:');
        this.enter(null);
    },
});
