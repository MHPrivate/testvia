var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Catalogue, require('../../../state-machine'));
function Catalogue(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:Tt92:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        args: args,                 // arguments for Catalogue transaction e.g.
                                    //  [
                                    //      'catalogue',                - purpose of transaction
                                    //      [                           - array augmented with attributes
                                    //          <Empty item>,            - empty item (or CareNet raw digits-string)
                                    //          '0',                     - catalogue unit-string
                                    //          send: 'a10000#@80',      - freeswitch digit-string to send
                                    //          regex: /#A(\d{12})#/g    - expected response regex
                                    //      ],
                                    //      0,                          - numeric catalogue-unit
                                    //      Object,                     - a callback that returns a truthy value
                                    //  ]
        callbacks: Object.assign([args.pop()], { outcomes: !Array.isArray(args[1]) }), // Consumer callback - updated by 'acknowledge'
        conclude: [conclude].filter(Boolean), // callback to signal State complete
        data: '',                   // received DTMF
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    alarmMs: 3500,          // 1st alarm-digits timeout
    fdcTones: ['ddda@80', '%(75,5,941);%(75,5,1633);%(75,5,941);%(75,5,1633);%(75,5,941);%(75,5,1633);;%(75,5,697);%(75,5,1633);'],    // acceptor is full duplex capable tones
    pauseMs: 230,           // end of alarm-digits timeout

    enter: function () {
        debug(this.leg.session.sid, 'enter:', this.args[0], this.args.slice(2));
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.alarmMs);
        return this;
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, 'leave: aborted');

        debug.enabled && debug(this.leg.session.sid, 'leave:', UTIL.stringify(this.leg.grouped));
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '-ABORTED');
        else
            this.callbacks.shift()(null, ''); // TODO - need to format available alarms
        this.conclude.length && this.conclude.shift()(); // Catalogue
    },
    action: function () {
        if (this.leg.grouped.fdcSent || !this.leg.hvs)
            return;

        debug(this.leg.session.sid, 'action:', new Date);
        this.leg.grouped.forcePending = false;
        this.leg.grouped.fdcSent = true;

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, 'action:', err);
            sm.signal('timeout'); // re-signal timeout after sending full-duplex-capable

        }, function () {
            var n = +sm.leg.stmf,
                ms = n ? esl.tgmlMs(exports.fdcTones[n]) : esl.dtmfMs(exports.fdcTones[n]);
            debug(sm.leg.session.sid, 'action.2:', module.parent.exports.tonesCmd[n], exports.fdcTones[n], 'FDC', ms + 'ms', new Date);
            if (n) {
                sm.leg.session.signal('diagnostic', 'fdc');
                esl.executeAsyncX(module.parent.exports.tonesCmd[n], exports.fdcTones[n], sm.leg.uuid, this);
            } else {
                worker.legDtmf(sm.leg, exports.fdcTones[n], null, 'fdc', this); // allow+send+block
            }

        });
        return this;
    },
    DETECTED_TONE: function (evt) {
        if (!this.leg.stmf) // ignore if waiting for DTMF
            return;

        var ms = this.args[1].regex ? 160 + (this.args[1].delayMs || 70) : undefined;
        this.data += evt.headers['Detected-Tone']['telecare-stmf:'.length];
        debug(this.leg.session.sid, 'TONE:', evt.headers['Detected-Tone'], this.data, ms + 'ms', new Date);
        if (this.args[1].regex) // only update timeout if we're waiting for a response
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ms);
        return this;
    },
    DTMF: function (evt) {
        if (this.leg.stmf) // ignore if waiting for STMF
            return;

        var digit = evt.headers['DTMF-Digit'],
            durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs > module.parent.exports.dtmfMaxMs && evt.headers['DTMF-Duration'] < 65535)
            return debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG', new Date);

        this.data += digit;
        debug(this.leg.session.sid, 'DTMF:', digit + '@' + durationMs, this.data, exports.pauseMs + 'ms', new Date);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.pauseMs);
        return this;
    },
    timeout: function () {
        if (this.signal('action')) // send Full Duplex Capable message if not already sent
            return;

        var parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.alarm8);
        this.data = ''; // reset for next group of alarm digits

        if (parsed)
            this.leg.grouped.alarms[parsed.raw] = parsed; // overwrites if already present, but retains order
        debug.enabled && debug(this.leg.session.sid, 'timeout:', this.data || '-', parsed ? 'parsed' : 'invalid', UTIL.stringify(this.leg.grouped.alarms), new Date);
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS');
        else
            this.callbacks.shift()(); // TODO - need to format available alarms
        this.conclude.length && this.conclude.shift()(); // Catalogue
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.leg.session.sid, 'acknowledge:');
        return cb() || this;
    },
});
