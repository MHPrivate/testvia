var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Stabilise, require('../../../state-machine'));
function Stabilise(leg, conclude) {
    debug || (debug = module.parent.exports.debug.extend(Stabilise.name.toLowerCase()));
    if (this instanceof Stabilise === false)
        throw new Error('Constructor Protocol:Tt92:' + Stabilise.name + ' requires \'new\'');

    Stabilise.super_.call(this, Stabilise, { // instance setup
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Stabilise, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,   // regexp to scan TT92 digits
    ackMs: 230,                     // delay to check ACK has been heard
    ackTones: 'db@80',              // DTMF to acknowledge DataMessage
    dumpMs: 10000,                  // silence delay to forced hangup
    enqTones: 'da@80',              // DTMF to provoke the DataMessage
    fdcMs: 230,                     // delay after sending Full Duplex Capable
    fdcTones: 'ddda@80',            // DTMF to indicate Full Duplex Capable ARC
    pauseMs: 230,                   // end of data delay

    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'actionEnq'), 0);
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, 'leave: aborted');

        debug(this.leg.session.sid, 'leave:');
        this.conclude && this.conclude(this.verified ? 'verified' : 'refused'); // Stabilise
    },
    release: function () {
        debug(this.leg.session.sid, 'release:');
        this.enter(null, 'release');
    },
    actionEnq: function () {
        debug(this.leg.session.sid, 'actionEnq:', 'send_dtmf', 'ENQ', Stabilise.enqTones, new Date);
        worker.legDtmf(this.leg, Stabilise.enqTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.enqTones], this.leg.uuid);
    },
    actionAck: function () {
        var ackMs = Stabilise.ackMs + esl.dtmfMs(Stabilise.ackTones);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'actionFdc'), ackMs);
        debug(this.leg.session.sid, 'actionAck:', 'send_dtmf', 'ACK', Stabilise.ackTones, ackMs + 'ms', new Date);
        worker.legDtmf(this.leg, Stabilise.ackTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.ackTones], this.leg.uuid);
    },
    actionFdc: function () {
        if (!this.tt.hvs)
            return this.enter(null);

        var fdcMs = Stabilise.fdcMs + esl.dtmfMs(Stabilise.fdcTones);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), fdcMs);
        debug(this.leg.session.sid, 'actionFdc:', 'send_dtmf', 'FDC', Stabilise.FDCTones, fdcMs + 'ms', new Date);
        worker.legDtmf(this.leg, Stabilise.fdcTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.fdcTones], this.leg.uuid);
        this.leg.grouped.fdcSent = true;
    },
    DETECTED_TONE: function (evt) {
        debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), Stabilise.pauseMs);
        debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data.slice(1), Stabilise.pauseMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        if (this.data) // received DTMF - so note the protocol for CDR generation
            this.leg.session.payload.protocol = 'TT 92';

        var match,
            tt,
            data = this.data;
        Stabilise.DH22.lastIndex = this.lastIndex;
        while (match = Stabilise.DH22.exec(data)) { // until verified, for-each matching segment
            this.lastIndex = Stabilise.DH22.lastIndex; // to prevent re-ACK'ing the same data
            if (this.verified = (tt = this.tt = module.parent.exports.parse(match[1], module.parent.exports.parse.alarm22) || {}).verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.leg.session.sid, 'timeout:', this.data || '-', JSON.stringify(tt), new Date);
        if (!this.verified)
            return this.signal('release');

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
        this.signal('actionAck');
    },
});
