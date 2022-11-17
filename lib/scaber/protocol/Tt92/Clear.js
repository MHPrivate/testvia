var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Clear, require('../../../state-machine'));
function Clear(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:Tt92:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        actioned: 0,                // count of times action'd
        args: args,                 // arguments for Clear transaction e.g.
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
    clearTones: ['*@500+0@1000', '%(75,5,941);%(75,5,1336);'],   // digit-string to clear a grouped device
    pauseMs: 230,           // end of alarm-digits timeout

    enter: function () {
        debug(this.leg.session.sid, 'enter:', this.args[0], this.args.slice(2));
        this.signal('action');
        return this;
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.leg.session.sid, 'leave: aborted');

        this.leg.selected = null;
        debug.enabled && debug(this.leg.session.sid, 'leave:', JSON.stringify({ selected: this.leg.selected }));
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS'); // TODO
        else
            this.callbacks.shift()(); // TODO
        this.conclude.length && this.conclude.shift()(); // Clear
    },
    action: function () {
        debug(this.leg.session.sid, 'action:', new Date);
        this.leg.grouped.forcePending = true;
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, 'action:', err);
            sm.timeout = worker.resetTimeout.call(sm.leg.session.sid, sm.timeout, sm.enter.bind(sm, null), exports.alarmMs);

        }, function () {
        //    if (sm.leg.stmf)
        //        return this();
        //
        //    debug(sm.leg.session.sid, 'action.1:', 'allow_dtmf');
        //    esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.leg.uuid, this);
        //
        //}, function (evt) {
            var n = +sm.leg.stmf
                ms = n ? esl.tgmlMs(exports.clearTones[1]) : esl.dtmfMs(exports.clearTones[0]);
            debug(sm.leg.session.sid, 'action.2:', module.parent.exports.tonesCmd[n], exports.clearTones[n], ms + 'ms', new Date);
            if (n)
                esl.executeAsyncX(module.parent.exports.tonesCmd[n], exports.clearTones[n], sm.leg.uuid, this);
            else
                worker.legDtmf(sm.leg, exports.clearTones[n], null, this); // allow+send+block
            //esl.executeAsyncX(module.parent.exports.tonesCmd[n], [exports.clearTones[n]], sm.leg.uuid, this);

        //}, function () {
        //    if (sm.leg.stmf)
        //        return this();
        //
        //    debug(sm.leg.session.sid, 'action.3:', 'block_dtmf');
        //    esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.leg.uuid, this);

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
        if (durationMs > module.parent.exports.dtmfMaxMs)
            return debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG', new Date);

        this.data += digit;
        debug(this.leg.session.sid, 'DTMF:', digit + '@' + durationMs, this.data, exports.pauseMs + 'ms', new Date);
        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.pauseMs);
        return this;
    },
    timeout: function () {
        var leave;
        if (this.parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.alarm8)) // alarm-digits
            this.leg.grouped.alarms[this.parsed.raw] = this.parsed; // overwrites if already present, but retains order
        else if (this.parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.clear)) // select-confirmation-message
            leave = true;
        debug(this.leg.session.sid, 'timeout:', this.data, this.parsed ? 'parsed' : 'invalid', new Date);
        if (leave)
            return this.enter(null);

        this.data = ''; // reset for further groups of alarm-digits
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.leg.session.sid, 'acknowledge:');
        return cb() || this;
    },
});
