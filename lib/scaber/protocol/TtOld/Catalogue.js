var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Catalogue, require('../../../state-machine'));
function Catalogue(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:TtOld:' + exports.name + ' requires \'new\'');

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
    fdcTones: 'ddda@80',    // acceptor is full duplex capable tones
    pauseMs: 230,           // end of alarm-digits timeout

    enter: function () {
        debug(this.leg.session.sid, new Date, 'enter:', this.args[0], this.args.slice(2));
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.alarmMs);
        return this;
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, new Date, 'leave: aborted');

        debug.enabled && debug(this.leg.session.sid, new Date, 'leave:', JSON.stringify(this.leg.grouped));
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

        debug(this.leg.session.sid, new Date, 'action:');
        this.leg.grouped.forcePending = false;
        this.leg.grouped.fdcSent = true;

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, 'action:', err);
            sm.signal('timeout'); // re-signal timeout after sending full-duplex-capable

        }, function () {
            debug(sm.leg.session.sid, new Date, 'action.2:', 'send_dtmf', exports.fdcTones, 'FDC', esl.dtmfMs(exports.fdcTones) + 'ms');
            worker.legDtmf(sm.leg, exports.fdcTones, null, 'fdc', this); // allow+send+block

        });
        return this;
    },
    DTMF: function (evt) {
        var digit = evt.headers['DTMF-Digit'],
            durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs > module.parent.exports.dtmfMaxMs && evt.headers['DTMF-Duration'] < 65535)
            return debug(this.leg.session.sid, new Date, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG');

        this.data += digit;
        debug(this.leg.session.sid, new Date, 'DTMF:', digit + '@' + durationMs, this.data, exports.pauseMs + 'ms');
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
        debug(this.leg.session.sid, new Date, 'timeout:', this.data || '-', parsed ? 'parsed' : 'invalid', JSON.stringify(this.leg.grouped.alarms));
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS');
        else
            this.callbacks.shift()(); // TODO - need to format available alarms
        this.conclude.length && this.conclude.shift()(); // Catalogue
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.leg.session.sid, new Date, 'acknowledge:');
        return cb() || this;
    },
});
