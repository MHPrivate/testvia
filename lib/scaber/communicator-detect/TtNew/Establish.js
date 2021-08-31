var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

require('util').inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(communicator, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Communicator:Detect:TtNew:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(communicator.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        attempts: isNaN(communicator.session.context.ttnew) ? 2 : communicator.session.context.ttnew, // number of ENQ attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,  // regexp to scan TTNew digits
    ackMs: 1000,            // delay to check ACK has been heard
    ackTones: 'db@80',      // DTMF to acknowledge DataMessage
    dumpMs: 10000,          // silence delay to forced hangup
    enqMs: 900,             // repeat enquire delay
    enqTones: 'db@80',      // DTMF to provoke the DataMessage
    silenceMs: 230,         // end of data delay

    enter: function () {
        debug(this.communicator.session.sid, 'enter:');
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'leave:');
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.communicator.session.sid, 'leave.1:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
    },
    action: function () {
        debug(this.communicator.session.sid, 'action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.enqMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(exports.name + '.action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'send_dtmf', 'ENQ', exports.enqTones, new Date);
            esl.executeAsyncX('send_dtmf', [exports.enqTones], sm.communicator.uuid, this);

        });
    },
    release: function () {
        debug(this.communicator.session.sid, 'release:');
        this.enter(null, 'release');
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.silenceMs);
        debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data.slice(1), exports.silenceMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        var match,
            parsed,
            data = this.data;
        exports.DH22.lastIndex = this.lastIndex;
        while (match = exports.DH22.exec(data)) { // until verified, for-each matching segment
            this.lastIndex = exports.DH22.lastIndex; // to prevent re-ACK'ing the same data
            if (this.verified = (parsed = module.parent.exports.parse(match[1], module.parent.exports.parse.alarm22) || {}).verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.communicator.session.sid, 'timeout:', JSON.stringify(parsed));
        if (!(parsed || {}).verified)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);

        if (parsed.grouped && 'ttnewGrp' in this.communicator.session.context) // redirect dial-string for any TTNew Grouped Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.ttnewGrp, _ttnewGrp: data });

        if (!parsed.hvs && 'ttnewTvs' in this.communicator.session.context) // non-HVS Communicator and have non-HVS redirect dial-string
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.ttnewTvs, _ttnewTvs: data });

        if ('ttnewAny' in this.communicator.session.context) // redirect dial-string for any TTNew Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.ttnewAny, _ttnewAny: data });

        Object.assign(this.communicator.session.payload, { tt: parsed, originUser: parsed.identity.replace(/\**$/, '').replace(/^0+/, '') || '0' });
        Object.assign(this.communicator, { grouped: parsed.grouped ? new module.parent.exports.Grouped : undefined, hvs: parsed.hvs });
        var ackMs = exports.ackMs + esl.dtmfMs(exports.ackTones);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.timeout:', err);
            sm.enter(null);

        }, function () {
            debug(sm.communicator.session.sid, 'timeout.1:', 'send_dtmf', 'ACK', exports.ackTones, ackMs + 'ms', new Date);
            esl.executeAsyncX('send_dtmf', [exports.ackTones], sm.communicator.uuid, this);

        }, function (evt) {
            sm.timeout = worker.resetTimeout.call(sm.communicator.session.sid, sm.timeout, this, ackMs);

        });
    },
});
