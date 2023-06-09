var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    nowip = require('../../../nowip'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(leg, conclude) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:Bs8521:' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
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
Object.assign(exports, { // class setup
    A26H: /#A?(\d{26})#?/g,     // regexp to scan BS8521 digits
    a26Ms: 110,                 // inter-digit delay when next expecting '#'
    ackMs: 1340,                // delay to check ACK has been heard
    ackDtmf: 'b@80',            // tones to ACK device data
    dumpMs: 10000,              // silence delay to forced hangup
    enqMs: 700,                 // repeat enquire delay
    enqDtmf: 'b@600',           // tones to provoke device data
    hashMs: NaN,                // special silence delay following a '#'
    silenceMs: 230,             // end of data delay

    enter: function () {
        debug(this.leg.session.sid, 'enter:');
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
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
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.leg.session.sid, 'leave.1:', 'block_dtmf');
            worker.legDtmf(sm.leg, '', true, '?', this); // block only

        });
    },
    release: function () {
        debug(this.leg.session.sid, 'release:', this.leg.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    action: function () {
        debug(this.leg.session.sid, 'action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        var ms = worker.legDtmf(this.leg, exports.enqDtmf, undefined, 'enB') + exports.enqMs; // send only
        debug(this.leg.session.sid, 'action:', 'ENQ', exports.enqDtmf, ms + 'ms', new Date);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), ms);
    },
    DETECTED_TONE: function (evt) {
        debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var match,
            timeoutMs,
            durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs || +evt.headers['DTMF-Duration'] === 65535)
            this.data += evt.headers['DTMF-Digit'];
        exports.A26H.lastIndex = this.lastIndex;
        if (!this.data.length || this.data.endsWith('#'))
            timeoutMs = exports.hashMs; // usually NaN - i.e. leaves the timeout unchanged
        else if (match = exports.A26H.exec('#' + this.data))
            timeoutMs = exports.a26Ms; // usually 110
        else
            timeoutMs = exports.silenceMs // usually 230
        isNaN(timeoutMs) || (this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs));
        debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data, timeoutMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        debug(this.leg.session.sid, 'timeout:', this.lastIndex, this.data.slice(this.lastIndex));
        if (this.data) // received DTMF - so note the protocol for CDR generation
            this.leg.session.payload.protocol = 'BSI 8521:2009';

        var match,
            bs8521 = {},
            data = this.data;
        exports.A26H.lastIndex = this.lastIndex;
        while (match = exports.A26H.exec('#' + data)) { // until verified, for-each matching segment
            this.lastIndex = exports.A26H.lastIndex; // remember what we've matched so far
            bs8521 = nowip.parse(match[1]) || {};
            if (bs8521.verified === false && this.leg.session.context.ignoreChksm) // parsed unverified BUT ignored
                bs8521.verified = 'ignored';
            if (this.verified = bs8521.verified) // parse & validate the NOWIP digits
                break;
        }
        if (!bs8521.verified)
            return this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);

        bs8521.grouped = ['1', '2', '3'].includes(bs8521.$.system);
        if (bs8521.grouped && 'bs8521Grp' in this.leg.session.context) // redirect dial-string for any BS8521 Grouped Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.bs8521Grp, _bs8521Grp: data });

        if ('bs8521Any' in this.leg.session.context) // redirect dial-string for any BS8521 Leg
            return this.leg.session.signal('contextRelease', { bridge: this.leg.session.context.bs8521Any, _bs8521Any: data });

        data = nowip.stringify(bs8521);
        Object.assign(this.leg.session.payload, {
            protocol: 'BSI 8521:2009',
            bs8521: bs8521,
            scheme: bs8521.$.controller,
            unit: bs8521.$.unit,
            originUser: (bs8521.$.controller + bs8521.$.unit).replace(/^0+/, '') || 0,
            event: bs8521.$.event,
            events: [
                bs8521.$.event + bs8521.$.status,
                bs8521.$.event + '**',
                '***' + bs8521.$.status,
            ],
            grouped: Boolean(+bs8521.$.system),
            location: bs8521.$.location,
            status: bs8521.$.status,
        });
        Object.assign(this.leg, { grouped: bs8521.grouped ? { unit: bs8521.unit } : undefined, hvs: bs8521.$.speech === 1 });
        var ms = worker.legDtmf(this.leg, exports.ackDtmf, undefined, 'ack') + exports.ackMs; // send only
        debug(this.leg.session.sid, 'timeout:', 'ACK', exports.ackDtmf, ms + 'ms', new Date);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), ms);
    },
});
