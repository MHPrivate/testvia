var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

util.inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(leg, conclude) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:Tt92:' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
        attempts: isNaN(leg.session.context.tt92) ? 2 : leg.session.context.tt92, // number of ENQ attempts
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastDetect: undefined,      // last STMF detection-evt timestamp
        lastIndex: 0,               // last successful DH22 scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    DH22: /(?=(D#([0-9*ABCD#]{22})))/g, // regexp to scan TT92 digits
    ackMs: 680,                 // delay to check ACK has been heard
    ackDtmf: 'b0@80',           // DTMF to ACK device data
    dumpMs: 10000,              // silence delay to forced hangup
    enqDtmf: '0#@80',           // DTMF to ENQ
    enqMs: 1180,                // repeat enquire delay
    enqStmf: '%(75,5,941);%(75,115,1336);%(80,80,941,1336);%(80,80,941,1477);', // combined STMF:0 + DTMF:0#
    silenceMs: 230,             // end of data delay

    enter: function () {
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        var text = ['spandsp_start_tone_detect', 'DTMF only', 'spandsp_start_tone_detect(dump)'][+this.leg.session.context.tt92NoStmf || 0];
        debug(this.leg.session.sid, 'enter:', text, new Date);

        if (+this.leg.session.context.tt92NoStmf !== 1) //  // tt92NoStmf is 0 OR 2+
            esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-stmf'], this.leg.uuid); // tt92NoStmf is not 1=noStmf
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.leg.session.sid, 'leave:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, exports.name + '.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (sm.leg.stmf && sm.verified) // retain spandsp-tone-detection if we have established using STMF
                return this();
            else if (+sm.leg.session.context.tt92NoStmf === 1) // not enabled - so don't need to disable
                return this(); // tt92NoStmf is 1

            debug(sm.leg.session.sid, 'leave.1:', 'spandsp_stop_tone_detect', new Date);
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.leg.uuid, this);

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.leg.session.sid, 'leave.2:', 'block_dtmf');
            worker.legDtmf(sm.leg, '', true, '?', this); // just block

        });
    },
    action: function () {
        debug(this.leg.session.sid, 'action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, exports.name + '.action:', err);

        }, function () {
            var dtmf = +sm.leg.session.context.tt92NoStmf === 1 ? exports.enqDtmf : exports.enqStmf; // tt92NoStmf is 1=noStmf ? DTMF : STMF
            var ms = worker.legDtmf(sm.leg, dtmf, undefined, 'en9', this) + exports.enqMs; // send only
            debug(sm.leg.session.sid, 'action:', 'ENQ', dtmf, ms + 'ms', new Date);
            sm.timeout = worker.resetTimeout.call(sm.leg.session.sid, sm.timeout, sm.signal.bind(sm, 'action'), ms);

        });
    },
    release: function () {
        debug(this.leg.session.sid, 'release:', this.leg.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    DETECTED_TONE: function (evt) {
        if (+this.leg.session.context.tt92NoStmf === 2)
            return this.leg.session.enter(null); // tt92NoStmf is 2

        this.leg.stmf = true;
        var gapMs,
            lastDetect = this.lastDetect,
            toneRate = 160; // Default tone rate: 80ms per tone, 160ms per digit

        this.lastDetect = evt.when;

        // Get current tone
        var currentTone = evt.headers['Detected-Tone']['telecare-stmf:'.length];

        // Calibrate tone rate when we detect a known sequence (D#)
        if (lastDetect && this.data.length >= 1) {
            // If we just detected '#' and previous tone was 'D', we have a known sequence
            if (currentTone === '#' && this.data[this.data.length - 1] === 'D') {
                // Calculate actual tone rate based on timing between 'D' and '#'
                var actualToneRate = this.lastDetect - lastDetect;

                // Store the calibrated tone rate if it's within reasonable bounds (40-320ms)
                if (actualToneRate >= 40 && actualToneRate <= 320) {
                    // Store in context for the entire session
                    this.leg.session.context.calibratedToneRate = actualToneRate;
                    debug(this.leg.session.sid, 'TONE_CALIBRATION:', 'Rate calibrated to ' + actualToneRate + 'ms', new Date);
                }
            }

            // Use calibrated tone rate if available
            if (this.leg.session.context.calibratedToneRate) {
                toneRate = this.leg.session.context.calibratedToneRate;
            }

            // Calculate gap and backfill missing digits
            gapMs = this.lastDetect - lastDetect;
            this.data += module.parent.exports.backfill(this.data, gapMs / toneRate - 1);
        }

        this.data += currentTone;

        var data = this.data.slice(this.lastIndex), // prevent multiple ACK for same data
            index = data.indexOf('D#'), // find latest instance of 'D#' in received data
            segment = data.slice(index), // extract candidate D#22 segment
            pendingMs = (25 - segment.length) * (this.leg.session.context.calibratedToneRate || 160);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), pendingMs);
        debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone'], this.data.slice(1), gapMs || '-', pendingMs, new Date);
        return this;
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs || +evt.headers['DTMF-Duration'] === 65535)
            this.data += evt.headers['DTMF-Digit'];
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.silenceMs);
        debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data.slice(1), exports.silenceMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        if (this.data) // received DTMF - so note the protocol for CDR generation
            this.leg.session.payload.protocol = 'TT 92';

        var match,
            tt,
            data = this.data + module.parent.exports.backfill(this.data, this.lastDetect && 1);
        exports.DH22.lastIndex = this.lastIndex;
        while (match = exports.DH22.exec(data)) { // until verified, for-each matching segment
            exports.DH22.lastIndex++;  // Lookahead assertions result in zero-length matches that do not automatically advance lastIndex. We advance to avoid infinite loop.
            this.lastIndex = exports.DH22.lastIndex; // to prevent re-ACK'ing the same data
            tt = module.parent.exports.parse(match[2], module.parent.exports.parse.alarm22) || {};
            if (tt.verified === false && this.leg.session.context.ignoreChksm) // parsed unverified BUT ignored
                tt.verified = 'ignored';
            if (this.verified = tt.verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.leg.session.sid, 'timeout:', this.data, UTIL.stringify(tt), new Date);
        if (!tt && !this.data.includes('#')) // only numeric DTMF
            return this.enter(null);

        if (!(tt || {}).verified)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);

        if (this.leg.stmf && 'tt92Stmf' in this.leg.session.context) // STMF Leg and have STMF redirect dial-string
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.tt92Stmf, _tt92Stmf: data });

        if (tt.grouped && 'tt92Grp' in this.leg.session.context) // redirect dial-string for any TT92 Grouped Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.tt92Grp, _tt92Grp: data });

        if ('tt92Any' in this.leg.session.context) // redirect dial-string for any TT92 Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.tt92Any, _tt92Any: data });

        if (!tt.hvs && 'tt92Tvs' in this.leg.session.context) // non-HVS Leg and have non-HVS redirect dial-string
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.tt92Tvs, _tt92Tvs: data });

        Object.assign(this.leg.session.payload, {
            protocol: 'TT 92',
            tt: tt,
            scheme: undefined, // populated by Select for Grouped legs
            unit: undefined, // populated by Select for Grouped legs
            originUser: tt.identity.replace(/\**$/, '').replace(/^0+/, '') || '0', // updated by Select for Grouped legs
            event: tt.callcode,
            grouped: tt.grouped,
            location: tt.padding,
        });
        Object.assign(this.leg, { grouped: tt.grouped ? new module.parent.exports.Grouped : undefined, hvs: tt.hvs });
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, exports.name + '.timeout:', err);
            sm.enter(null);

        }, function () {
            debug(sm.leg.session.sid, 'timeout:', 'ACK', exports.ackDtmf, new Date);
            worker.legDtmf(sm.leg, exports.ackDtmf, undefined, 'ack', this); // send only

        }, function (evt) {
            sm.timeout = worker.resetTimeout.call(sm.leg.session.sid, sm.timeout, this, exports.ackMs);

        });
    },
});
