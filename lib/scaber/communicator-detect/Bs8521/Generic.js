var chain = require('scope-chain');
var debug;
var esl = require('../../../esl');
var worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

require('util').inherits(module.exports = exports = Generic, require('../../../state-machine'));
function Generic(communicator, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor', 'Communicator:Detect:Bs8521:' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
        args: args,                 // arguments for Generic transaction
        callbacks: [args.pop()],    // Consumer callback - updated by 'acknowledge'
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        datas: [''],                // received DTMF
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    digitMs: 400,     // max wait for non-final digits

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
        if (!this.callbacks.length)
            null;
        else if (!this.datas[0])
            this.callbacks.shift()();
        else
            this.callbacks.shift()(null, this.datas[0]);
        this.datas.unshift('');
        this.conclude(); // Generic
    },
    action: function () {
        var timeoutMs = exports.digitMs + module.parent.exports.digitsMs(this.args[1].send);
        debug(this.communicator.session.sid, 'action:', this.args[1].send, 'timeout:', timeoutMs + 'ms');
        if (!this.args[1].send)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), timeoutMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'action.2:', 'send_dtmf', sm.args[1].send);
            esl.executeAsyncX('send_dtmf', [sm.args[1].send], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'action.3:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
    DTMF: function (evt) {
        var ack, digit = evt.headers['DTMF-Digit'], durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs > module.parent.exports.dtmfMaxMs)
            return debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG');

        this.datas[0] += digit;
        switch (digit) {
            case '#': // Communicator needs to be ACK'd - also expect ACK from Consumer
                ack = 'B@80';
                debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.datas[0], '- ACK');
                this.callbacks.length && this.callbacks.shift()(null, this.datas[0]);
                this.datas.unshift(''); // reset once sent
                break;
            case 'B': // all done
                debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.datas[0], '- DONE');
                this.callbacks.length && this.callbacks.shift()(null, this.datas[0]);
                this.datas.unshift(''); // reset once sent
                break;
            default: // wait for additional digits
                debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.datas[0], '- MORE');
                this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), exports.digitMs);
                break;
        }

        var sm = this;
        ack && chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'DTMF:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'DTMF.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'DTMF.2:', 'send_dtmf', ack);
            esl.executeAsyncX('send_dtmf', [ack], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'DTMF.3:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.communicator.session.sid, 'acknowledge:');
        this.callbacks.push(cb);
        return this.enter(null) || this; // invokes callback()
    },
});
