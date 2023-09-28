var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Generic, require('../../../state-machine'));
function Generic(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:TtNew:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        actioned: 0,                // count of times action'd
        args: args,                 // arguments for Generic transaction e.g.
                                    //  [
                                    //      'null',                     - purpose of transaction
                                    //      [                           - array augmented with attributes
                                    //          <Empty item>,            - empty item (or CareNet raw digits-string)
                                    //          '0',                     - catalogue unit-string
                                    //          send: 'a10000#@80',      - freeswitch digit-string to send
                                    //          regex: /#A(\d{12})#/g    - expected response regex
                                    //      ],
                                    //      0,                          - numeric catalogue-unit
                                    //      Object,                     - a callback that returns a truthy value
                                    //  ]
        attempts: 2,                // max number of send attempts
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
    idleMs: 230,            // delay waiting for further digits
    retryMs: 240,           // extra delay before retry

    enter: function () {
        debug(this.leg.session.sid, 'enter:', this.args[0], this.args.slice(2));
        typeof this.args[1].send === 'string' ? this.signal('action') : this.enter(null);
        return this;
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, 'leave: aborted');

        debug(this.leg.session.sid, 'leave:');
        if (this.args[1].send === true) // fake success (false indicates failure)
            this.parsed = true;
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            (this.parsed || !this.args[1].regex ? this.callbacks.shift()(null, '+SUCCESS') : this.callbacks.shift()(null, '-ABORTED')); // ? success : failure
        else
            (this.parsed || !this.args[1].regex ? this.callbacks.shift()() : this.callbacks.shift()(null, '')); // ? success : failure
        this.conclude.length && this.conclude.shift()(); // Generic
    },
    action: function () {
        debug(this.leg.session.sid, 'action: attempts', this.attempts, this.args[1].send, new Date);
        if (!this.attempts-- || !this.args[1].send)
            return this.enter(null);

        var ms = worker.legDtmf(this.leg, this.args[1].send, null, '?'); // allow+send+block;
        if (this.args[1].regex) // expecting a response
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), ms += (this.args[1].retryMs || exports.retryMs));
        else // no response expected
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), ms += (this.args[1].delayMs || 70));
        debug(this.leg.session.sid, 'action.1:', this.args[1].send, ms + 'ms', new Date);
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
            durationMs = evt.headers['DTMF-Duration'] / 8,
            ms = this.args[1].regex ? 160 + (this.args[1].delayMs || 70) : undefined;
        if (durationMs > module.parent.exports.dtmfMaxMs && evt.headers['DTMF-Duration'] < 65535)
            return debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG', new Date);

        this.data += digit;
        debug(this.leg.session.sid, 'DTMF:', digit + '@' + durationMs, this.data, ms + 'ms', new Date);
        if (this.args[1].regex) // only update timeout if we're waiting for a response
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ms);
        return this;
    },
    timeout: function () {
        if (this.args[1].regex)
            this.parsed = this.data.match(this.args[1].regex);
        debug(this.leg.session.sid, 'timeout:', this.data, this.parsed ? 'parsed' : 'invalid', new Date);
        return this.enter(null);
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.leg.session.sid, 'acknowledge:');
        cb();
        return this;
    },
});
