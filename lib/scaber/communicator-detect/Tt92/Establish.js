var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

util.inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(communicator, conclude) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Communicator:Detect:Tt92:' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
        attempts: isNaN(communicator.session.context.tt92) ? 2 : communicator.session.context.tt92, // number of ENQ attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastDetect: undefined,      // last STMF detection-evt timestamp
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,  // regexp to scan TT92 digits
    ackMs: 1000,                // delay to check ACK has been heard
    ackTones: ['b0@80', '%(75,5,770);%(75,5,1633);%(75,5,941);%(75,85,1336);'], // tones to ACK device data
    dumpMs: 10000,              // silence delay to forced hangup
    enqMs: 1500,                // repeat enquire delay
    enqTones: ['0#@80', '%(75,5,941);%(75,115,1336);%(80,80,941,1336);%(80,80,941,1477);'], // combined STMF:0 + DTMF:0#
    silenceMs: 230,             // end of data delay

    enter: function () {
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        debug(this.communicator.session.sid, 'enter:', this.communicator.session.context.tt92NoStmf ? 'DTMF only' : 'spandsp_start_tone_detect:stmf', new Date);

        if (!this.communicator.session.context.tt92NoStmf)
            esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-stmf'], this.communicator.uuid);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (sm.communicator.stmf && sm.verified) // retain spandsp-tone-detection if we have established using STMF
                return this();
            else if (sm.communicator.session.context.tt92NoStmf) // not enabled - so don't need to disable 
                return this();

            debug(sm.communicator.session.sid, 'leave.1:', 'spandsp_stop_tone_detect', new Date);
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.communicator.uuid, this);

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.communicator.session.sid, 'leave.2:', 'block_dtmf');
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
            err && console.log(sm.communicator.session.sid, exports.name + '.action:', err);

        }, function () {
            var n = sm.communicator.session.context.tt92NoStmf ? 0 : 1;
            debug(sm.communicator.session.sid, 'action:', module.parent.exports.tonesCmd[n], 'ENQ', exports.enqTones[n], new Date);
            esl.executeAsyncX(module.parent.exports.tonesCmd[n], [exports.enqTones[n]], sm.communicator.uuid, this);

        });
    },
    release: function () {
        debug(this.communicator.session.sid, 'release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    DETECTED_TONE: function (evt) {
        this.communicator.stmf = true;
        var gapMs,
            lastDetect = this.lastDetect;
        this.lastDetect = evt.when;
        if (lastDetect) // only backfill on 2nd and subsequent tone-detect
            this.data += module.parent.exports.backfill(this.data, (gapMs = this.lastDetect - lastDetect) / 160 - 1);
        this.data += evt.headers['Detected-Tone']['telecare-stmf:'.length];

        var data = this.data.slice(this.lastIndex), // prevent multiple ACK for same data
            index = data.indexOf('D#'), // find latest instance of 'D#' in received data
            segment = data.slice(index), // extract candidate D#22 segment
            pendingMs = (25 - segment.length) * 160;
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), pendingMs);
        debug(this.communicator.session.sid, 'TONE:', evt.headers['Detected-Tone'], this.data.slice(1), gapMs || '-', pendingMs, new Date);
        return this;
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
            tt,
            data = this.data + module.parent.exports.backfill(this.data, this.lastDetect && 1);
        exports.DH22.lastIndex = this.lastIndex;
        while (match = exports.DH22.exec(data)) { // until verified, for-each matching segment
            this.lastIndex = exports.DH22.lastIndex; // to prevent re-ACK'ing the same data
            if (this.verified = (tt = module.parent.exports.parse(match[1], module.parent.exports.parse.alarm22) || {}).verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.communicator.session.sid, 'timeout:', this.data, JSON.stringify(tt), new Date);
        if (!tt && !this.data.includes('#')) // only numeric DTMF
            return this.enter(null);

        if (!(tt || {}).verified)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);

        if (this.communicator.stmf && 'tt92Stmf' in this.communicator.session.context) // STMF Communicator and have STMF redirect dial-string
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Stmf, _tt92Stmf: data });

        if (tt.grouped && 'tt92Grp' in this.communicator.session.context) // redirect dial-string for any TT92 Grouped Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Grp, _tt92Grp: data });

        if ('tt92Any' in this.communicator.session.context) // redirect dial-string for any TT92 Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Any, _tt92Any: data });

        if (!tt.hvs && 'tt92Tvs' in this.communicator.session.context) // non-HVS Communicator and have non-HVS redirect dial-string
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Tvs, _tt92Tvs: data });

        Object.assign(this.communicator.session.payload, {
            protocol: 'TT 92',
            tt: tt,
            scheme: undefined, // populated by Select for Grouped communicators
            unit: undefined, // populated by Select for Grouped communicators
            originUser: tt.identity.replace(/\**$/, '').replace(/^0+/, '') || '0', // updated by Select for Grouped communicators
            event: tt.callcode,
            grouped: tt.grouped,
            location: tt.padding,
        });
        Object.assign(this.communicator, { grouped: tt.grouped ? new module.parent.exports.Grouped : undefined, hvs: tt.hvs });
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.timeout:', err);
            sm.enter(null);

        }, function () {
            var n = +sm.communicator.stmf;
            debug(sm.communicator.session.sid, 'timeout:', module.parent.exports.tonesCmd[n], 'ACK', exports.ackTones[n], new Date);
            esl.executeAsyncX(module.parent.exports.tonesCmd[n], [exports.ackTones[n]], sm.communicator.uuid, this);

        }, function (evt) {
            sm.timeout = worker.resetTimeout.call(sm.communicator.session.sid, sm.timeout, this, exports.ackMs);

        });
    },
});
