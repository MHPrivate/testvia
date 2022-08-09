var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Stabilise, require('../../../state-machine'));
function Stabilise(leg, conclude) {
    debug || (debug = module.parent.exports.debug.extend(Stabilise.name.toLowerCase()));
    if (this instanceof Stabilise === false)
        throw new Error('Constructor Protocol:TtOld:' + Stabilise.name + ' requires \'new\'');

    Stabilise.super_.call(this, Stabilise, { // instance setup
        conclude: conclude,         // callback to signal State complete
        data: '',                   // accumulator for received data
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Stabilise, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,   // regexp to scan TTOld digits
    ackMs: 230,                     // delay to check ACK has been heard
    ackTones: 'db@80',              // DTMF to acknowledge DataMessage
    dumpMs: 10000,                  // silence delay to forced hangup
    enqTones: '*@2000',             // DTMF to provoke the DataMessage
    fdcMs: 230,                     // delay after sending Full Duplex Capable
    fdcTones: 'ddda@80',            // DTMF to indicate Full Duplex Capable ARC
    pauseMs: 230,                   // end of data delay

    enter: function () {
        debug(this.leg.session.sid, new Date, 'enter:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'actionEnq'), 0);
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, new Date, 'leave: aborted');

        debug(this.leg.session.sid, new Date, 'leave:');
        this.conclude && this.conclude(this.verified ? 'verified' : 'refused'); // Stabilise
    },
    release: function () {
        debug(this.leg.session.sid, new Date, 'release:');
        this.enter(null, 'release');
    },
    actionEnq: function () {
        debug(this.leg.session.sid, new Date, 'actionEnq:', 'send_dtmf', 'ENQ', Stabilise.enqTones);
        worker.legDtmf(this.leg, Stabilise.enqTones, undefined, this); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.enqTones], this.leg.uuid);
    },
    actionAck: function () {
        var ackMs = Stabilise.ackMs + esl.dtmfMs(Stabilise.ackTones);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'actionFdc'), ackMs);
        debug(this.leg.session.sid, new Date, 'actionAck:', 'send_dtmf', 'ACK', Stabilise.ackTones, ackMs + 'ms');
        worker.legDtmf(this.leg, Stabilise.ackTones, undefined, this); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.ackTones], this.leg.uuid);
    },
    actionFdc: function () {
        if (!this.tt.hvs)
            return this.enter(null);

        var fdcMs = Stabilise.fdcMs + esl.dtmfMs(Stabilise.fdcTones);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), fdcMs);
        debug(this.leg.session.sid, new Date, 'actionFdc:', 'send_dtmf', 'FDC', Stabilise.FDCTones, fdcMs + 'ms');
        worker.legDtmf(this.leg, Stabilise.fdcTones, undefined, this); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.fdcTones], this.leg.uuid);
        this.leg.grouped.fdcSent = true;
    },
    DETECTED_TONE: function (evt) {
        debug(this.leg.session.sid, new Date, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), Stabilise.pauseMs);
        debug(this.leg.session.sid, new Date, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data.slice(1), Stabilise.pauseMs + 'ms');
        return this;
    },
    timeout: function () {
        if (this.signal('action')) // send Full Duplex Capable message if not already sent
            return;

        var tt = this.tt = module.parent.exports.parse(this.data, module.parent.exports.parse.ident8, { grouped: true });
        this.verified = !!tt;
        this.data = ''; // reset for next group of alarm digits

        debug.enabled && debug(this.leg.session.sid, new Date, 'timeout:', this.data || '-', JSON.stringify(tt));
        if (!this.verified)
            return this.signal('release');

        Object.assign(this.leg.session.payload, {
            protocol: 'TT Old',
            tt: tt,
            scheme: +tt.identity.replace(/^D/g, '0'), // populated by Select for Grouped legs
            unit: undefined, // populated by Select for Grouped legs
            event: tt.callcode,
            grouped: tt.grouped,
            location: tt.padding,
        });
        Object.assign(this.leg, { grouped: tt.grouped ? new module.parent.exports.Grouped : undefined, hvs: tt.hvs });
        this.signal('actionAck');
    },
});
