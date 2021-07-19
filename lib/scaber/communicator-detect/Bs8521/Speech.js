var chain = require('scope-chain');
var debug;
var esl = require('../../../esl');
var worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = exports = function Speech(communicator, conclude, duplex) {
    debug || (debug = exports.debug);
    if (this instanceof exports === false)
        throw new Error('Constructor', exports.variant + ':' + exports.name + ' requires \'new\'');

    if (typeof conclude !== 'function') {
        duplex = conclude;
        conclude = undefined;
    }
    exports.super_.call(this, exports, { // instance setup
        attempts: 2,                // send twice
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        tones: duplex ? exports.duplexTones : exports.simplexTones, // desired mode tones
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    duplexTones: 'a38#@80',     // pathDuplex tones
    silenceMs: 2000,            // delay after detecting any tones
    simplexTones: 'a39#@80',    // pathSimplex tones

    enter: function () {
        debug(this.communicator.session.sid, exports.name + '.enter:', exports.actionMs);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, exports.name + '.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(); // Speech
    },
    action: function () {
        debug(this.communicator.session.sid, exports.name + '.action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.silenceMs);
        var sm = this;
        chain(function (err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.action:', err);

        }, function () {
            debug(sm.communicator.session.sid, exports.name + '.action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, exports.name + '.action.2:', 'send_dtmf', sm.tones);
            esl.executeAsyncX('send_dtmf', [sm.tones], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, exports.name + '.action.3:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
});
