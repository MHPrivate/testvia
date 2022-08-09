var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:TtNew:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        attempts: isNaN(leg.session.context.ttnew) ? 2 : leg.session.context.ttnew, // number of ENQ attempts
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,  // regexp to scan TTNew digits
    ackMs: 550,             // delay to check ACK has been heard
    ackTones: 'db@80',      // DTMF to acknowledge DataMessage
    dumpMs: 10000,          // silence delay to forced hangup
    enqMs: 900,             // repeat enquire delay
    enqTones: 'db@80',      // DTMF to provoke the DataMessage
    silenceMs: 230,         // end of data delay

    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.leg.session.sid, 'leave:');
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, exports.name + '.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.leg.session.sid, 'leave.1:', 'block_dtmf');
            worker.legDtmf(sm.leg, '', true, this); // just block
            //esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.leg.uuid, this);

        });
    },
    action: function () {
        debug(this.leg.session.sid, 'action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.enqMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(exports.name + '.action:', err);

        }, function () {
            debug(sm.leg.session.sid, 'action.1:', 'send_dtmf', 'ENQ', exports.enqTones, new Date);
            worker.legDtmf(sm.leg, exports.enqTones, undefined, this); // send only
            //esl.executeAsyncX('send_dtmf', [exports.enqTones], sm.leg.uuid, this);

        });
    },
    release: function () {
        debug(this.leg.session.sid, 'release:');
        this.enter(null, 'release');
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.silenceMs);
        debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data.slice(1), exports.silenceMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        var match,
            tt,
            data = this.data;
        exports.DH22.lastIndex = this.lastIndex;
        while (match = exports.DH22.exec(data)) { // until verified, for-each matching segment
            this.lastIndex = exports.DH22.lastIndex; // to prevent re-ACK'ing the same data
            if (this.verified = (tt = module.parent.exports.parse(match[1], module.parent.exports.parse.alarm22) || {}).verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.leg.session.sid, 'timeout:', JSON.stringify(tt));
        if (!(tt || {}).verified)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);

        if (tt.grouped && 'ttnewGrp' in this.leg.session.context) // redirect dial-string for any TTNew Grouped Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.ttnewGrp, _ttnewGrp: data });

        if (!tt.hvs && 'ttnewTvs' in this.leg.session.context) // non-HVS Leg and have non-HVS redirect dial-string
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.ttnewTvs, _ttnewTvs: data });

        if ('ttnewAny' in this.leg.session.context) // redirect dial-string for any TTNew Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.ttnewAny, _ttnewAny: data });

        Object.assign(this.leg.session.payload, {
            protocol: 'TT New',
            tt: tt,
            scheme: undefined, // populated by Select for Grouped legs
            unit: undefined, // populated by Select for Grouped legs
            originUser: tt.identity.replace(/\**$/, '').replace(/^0+/, '') || '0', // updated by Select for Grouped legs
            event: tt.callcode,
            grouped: tt.grouped,
            location: tt.padding,
        });
        Object.assign(this.leg, { grouped: tt.grouped ? new module.parent.exports.Grouped : undefined, hvs: tt.hvs });
        var ackMs = exports.ackMs + esl.dtmfMs(exports.ackTones);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, exports.name + '.timeout:', err);
            sm.enter(null);

        }, function () {
            debug(sm.leg.session.sid, 'timeout.1:', 'send_dtmf', 'ACK', exports.ackTones, ackMs + 'ms', new Date);
            ackMs += Date.now();
            worker.legDtmf(sm.leg, exports.ackTones, undefined, this); // send only
            //esl.executeAsyncX('send_dtmf', [exports.ackTones], sm.leg.uuid, this);

        }, function (evt) {
            ackMs -= Date.now();
            debug(sm.leg.session.sid, 'timeout.2:', 'wait', ackMs + 'ms', new Date);
            sm.timeout = worker.resetTimeout.call(sm.leg.session.sid, sm.timeout, this, ackMs);

        });
    },
});
