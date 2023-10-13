var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Select, require('../../../state-machine'));
function Select(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:Tt92:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        actioned: 0,                // count of times action'd
        args: args,                 // arguments for Select transaction e.g.
                                    //  [
                                    //      'select',                   - purpose of transaction
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
        parsed: undefined,          // most recently parsed input
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    alarmMs: 3500,          // 1st alarm-digits timeout
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

        var fetched,
            payload = this.leg.session.payload;
        if (typeof this.args[2] === 'number') { // alarm-driven select - not a directed select
            fetched = this.leg.grouped.fetch(true);
            fetched && Object.assign(payload.tt, {
                callcode: fetched.callcode,
                speech: this.parsed.speech.replace(/D/g, '0'), // D=simplex, 1=duplex
                battery: fetched.battery.replace(/D/g, '0'), // D=ok, 1=low
                location: fetched.location.replace(/D/g, '0'),
            });
            Object.assign(payload, {
                scheme: payload.tt.identity.replace(/\**$/, '').replace(/^0+/, '') || '0',
                unit: '0' + this.parsed.unit.replace(/D/g, '0'),
                originUser: (payload.tt.identity.replace(/\**$/, '') + '0' + this.parsed.unit.replace(/D/g, '0')).replace(/^0+/, ''),
                event: payload.tt.callcode,
                events: [
                    payload.tt.callcode + payload.tt.battery,
                    payload.tt.callcode + '*',
                    '*' + payload.tt.battery,
                ],
                fetched: fetched,
                grouped: true,
                location: payload.tt.location,
            });
        }
        if (!payload.tt.hvs) // use payload capability instead of 1st digit of select-confirmation (D=tone/1=hvs)
            this.leg.speech = 'legacy';
        this.leg.selected = this.args[2];
        debug.enabled && debug(this.leg.session.sid, 'leave:', UTIL.stringify({ selected: this.leg.selected, speech: this.leg.speech || 'duplex', fetched: fetched, parsed: this.parsed, payload: payload }));
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS'); // TODO
        else
            this.callbacks.shift()(); // TODO
        this.conclude.length && this.conclude.shift()(); // Select
    },
    action: function () {
        if (this.actioned++) // already actioned
            return;

        debug(this.leg.session.sid, 'action:', new Date);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, 'action:', err);

        }, function () {
            var selectDtmf = ('000' + sm.args[2]).slice(-3).replace(/0/g, 'd') + 'b@80';
            worker.legDtmf(sm.leg, selectDtmf, null, 'sel', this); // allow+send+block
            debug(sm.leg.session.sid, 'action.2:', selectDtmf, new Date);

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
        this.signal('action');
        if (this.parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.alarm8)) // alarm-digits
            this.leg.grouped.alarms[this.parsed.raw] = this.parsed; // overwrites if already present, but retains order
        else if (this.parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.selco)) // select-confirmation-messa
            this.enter(null);
        debug.enabled && debug(this.leg.session.sid, 'timeout:', this.data, this.parsed ? 'parsed' : 'invalid', this.leg.grouped && UTIL.stringify(this.leg.grouped.alarms), new Date);
        this.data = ''; // reset for further groups of alarm-digits
        return this;
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.leg.session.sid, 'acknowledge:');
        return cb() || this;
    },
});
