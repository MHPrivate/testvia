var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    nowip = require('../../../nowip'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Stabilise, require('../../../state-machine'));
function Stabilise(leg, conclude) {
    debug || (debug = module.parent.exports.debug.extend(Stabilise.name.toLowerCase()));
    if (this instanceof Stabilise === false)
        throw new Error('Constructor Protocol:Bs8521:' + Stabilise.name + ' requires \'new\'');

    Stabilise.super_.call(this, Stabilise, { // instance setup
        attempts: isNaN(leg.session.context.bs8521) ? 2 : leg.session.context.bs8521, // number of ENQ attempts
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
    A26H: /A?(\d{26})#?/g,       // regexp to scan BS8521 digits
    a26Ms: 65,                 // inter-digit delay when next expecting '#'
    ackMs: 230,                 // delay to check ACK has been heard
    ackTones: 'b@80',           // tones to ACK device data
    dumpMs: 10000,              // silence delay to forced hangup
    enqTones: 'b@600',          // tones to provoke device data
    hashMs: NaN,                // special silence delay following a '#'
    idTones: 'A' + nowip.stringify({ system: 'ARC' }, undefined, true) + '#@80',
    silenceMs: 230,             // end of data delay

    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'actionId'), 0);
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
        debug(this.leg.session.sid, 'release:', this.leg.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    actionId: function () {
        debug(this.leg.session.sid, 'actionId:', 'send_dtmf', 'ID', Stabilise.idTones, new Date);
        worker.legDtmf(this.leg, Stabilise.idTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.idTones], this.leg.uuid);
    },
    actionEnq: function () {
        debug(this.leg.session.sid, 'actionEnq:', 'send_dtmf', 'ENQ', Stabilise.enqTones, new Date);
        worker.legDtmf(this.leg, Stabilise.enqTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.enqTones], this.leg.uuid);
    },
    actionAck: function () {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), Stabilise.ackMs);
        debug(this.leg.session.sid, 'actionAck:', 'send_dtmf', 'ACK', Stabilise.ackTones, new Date);
        worker.legDtmf(this.leg, Stabilise.ackTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Stabilise.ackTones], this.leg.uuid);
    },
    DETECTED_TONE: function (evt) {
        debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var timeoutMs,
            durationMs = evt.headers['DTMF-Duration'] / 8;
        this.data += durationMs < 500 ? evt.headers['DTMF-Digit'] : evt.headers['DTMF-Digit'].toLowerCase();
        Stabilise.A26H.lastIndex = this.lastIndex;
        if (this.data.endsWith('B'))
            timeoutMs = Stabilise.ackMs; // usually 230
        else if (this.data.endsWith('#'))
            timeoutMs = Stabilise.hashMs; // usually NaN - i.e. leaves the timeout unchanged
        else if (match = Stabilise.A26H.exec(this.data))
            timeoutMs = Stabilise.a26Ms; // usually 110
        else
            timeoutMs = Stabilise.silenceMs // usually 230
        isNaN(timeoutMs) || (this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs));
        debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data, timeoutMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        debug(this.leg.session.sid, 'timeout:', this.lastIndex, this.data.slice(this.lastIndex));
        var match,
            bs8521 = {};
        Stabilise.A26H.lastIndex = this.lastIndex;
        if (this.data.endsWith('B'))
            return this.signal('actionEnq');

        while (match = Stabilise.A26H.exec(this.data)) { // until verified, for-each matching segment
            this.lastIndex = Stabilise.A26H.lastIndex; // remember what we've matched so far
            if (this.verified = (bs8521 = nowip.parse(match[1]) || {}).verified) // parse & validate the NOWIP digits
                break;
        }
        if (!this.verified)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'release'), Stabilise.dumpMs); // usually 10000

        bs8521.grouped = ['1', '2', '3'].includes(bs8521.$.system);
        Object.assign(this.leg.session.payload, {
            protocol: 'BSI 8521:2009',
            bs8521: bs8521,
            scheme: bs8521.$.controller,
            unit: bs8521.$.unit,
            originUser: (bs8521.$.controller + bs8521.$.unit).replace(/^0+/, '') || 0,
            event: bs8521.$.event,
            grouped: bs8521.grouped,
            location: bs8521.$.location,
            status: bs8521.$.status,
        });
        Object.assign(this.leg, { grouped: bs8521.grouped ? { unit: bs8521.unit } : undefined, hvs: bs8521.$.speech === 1 });
        this.signal('actionAck');
    },
});
