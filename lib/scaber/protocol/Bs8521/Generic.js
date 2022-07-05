var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    nowip = require('../../../nowip'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Generic, require('../../../state-machine'));
function Generic(leg, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Protocol:Bs8521:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(leg.session.sid, 'Generic:', util.inspect(args, { breakLength: Infinity }));
    exports.super_.call(this, exports, { // instance setup
        args: args,                 // arguments for Generic transaction e.g.
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
        attempts: 2,                // max number of send attempts
        callbacks: Object.assign([args.pop()], { outcomes: !Array.isArray(args[1]) }), // Consumer callback - updated by 'acknowledge'
        conclude: conclude,         // callback to signal State complete
        data: '',                   // received DTMF
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        leg: leg,                   // reference to parent state-machine
        list: [],                   // list of catalogue responses
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    ackMs: 100,     // delay after received ACK
    hashMs: NaN,    // delay after a received '#'
    moreMs: 230,    // delay waiting for more data
    regexMs: 120,   // delay after regex match
    retryMs: 400,   // extra delay after sending CMD

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

        var bs8521,
            data = this.data || this.list.shift() || '';
        debug.enabled && debug(this.leg.session.sid, 'leave:', JSON.stringify({ type: this.args[0], subtype: this.args[2], data: data }));
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS', data);
        else
            this.callbacks.shift()(null, data);
        if (['catalogue', 'select'].includes(this.args[0]) && (bs8521 = nowip.parse(data.slice(1, -1), 'unit,event,location,priority,status'))) {
            if (this.args[0] === 'select')
                this.leg.selected = bs8521.unit;
            debug.enabled && debug(this.leg.session.sid, 'leave: updating payload', JSON.stringify({ selected: this.leg.selected, bs8521: bs8521 }));
            Object.assign(this.leg.session.payload.bs8521.$, bs8521.$); // for stringify
            Object.assign(this.leg.session.payload.bs8521, bs8521); // for easy access
            Object.assign(this.leg.session.payload, {
                unit: this.leg.grouped.unit = bs8521.unit,
                originUser: (bs8521.$.controller + bs8521.$.unit).replace(/^0+/, '') || 0,
                event: bs8521.$.event,
                events: [
                    bs8521.$.event + bs8521.$.status,
                    bs8521.$.event + '**',
                    '***' + bs8521.$.status,
                ],
                grouped: true,
                location: bs8521.$.location,
                status: bs8521.$.status,
            });
        } else if ('quick' === this.args[0] && 'clear' === this.args[2] && (bs8521 = data.match(/A0000(\d\d)#/))) {
            this.leg.selected = null;
            debug.enabled && debug(this.leg.session.sid, 'leave: pending', +bs8521[1], JSON.stringify({ selected: this.leg.selected, bs8521: bs8521 }));
            Object.assign(this.leg.grouped, { pending: +bs8521[1], unit: 0 });
        }
        this.conclude && this.conclude(data); // Generic
    },
    action: function () {
        var timeoutMs = exports.retryMs + esl.dtmfMs(this.args[1].send);
        debug(this.leg.session.sid, 'action: attempts', this.attempts, this.args[1].send, new Date);
        if (!this.attempts-- || !this.args[1].send)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'action'), timeoutMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, 'action:', err);

        }, function () {
            debug(sm.leg.session.sid, 'action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.leg.uuid, this);

        }, function (evt) {
            debug(sm.leg.session.sid, 'action.2:', 'send_dtmf', sm.args[1].send, timeoutMs + 'ms', new Date);
            esl.executeAsyncX('send_dtmf', [sm.args[1].send], sm.leg.uuid, this);

        }, function () {
            debug(sm.leg.session.sid, 'action.3:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.leg.uuid, this);

        });
        return this;
    },
    DTMF: function (evt) {
        var digit = evt.headers['DTMF-Digit'],
            durationMs = evt.headers['DTMF-Duration'] / 8,
            regex = this.args[1].regex,
            timeoutMs;
        if (durationMs > module.parent.exports.dtmfMaxMs)
            return debug(this.leg.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG', new Date);

        this.data += digit;
        (this.args[1].regex || {}).lastIndex = this.lastIndex;
        if (digit === '#')
            timeoutMs = exports.hashMs; // usually NaN - leaves the timeout unchanged
        else if (digit === 'B')
            timeoutMs = exports.ackMs; // usually 0
        else if (this.args[1].regex && this.args[1].regex.exec('#' + this.data))
            timeoutMs = exports.regexMs; // usually 110
        else
            timeoutMs = exports.moreMs; // usually 230
        debug(this.leg.session.sid, 'DTMF:', digit + '@' + durationMs, this.data, timeoutMs + 'ms', new Date);
        if (timeoutMs)
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs);
        else if (isNaN(timeoutMs))
            null; // leave the current timeout unchanged
        else // timeoutMs is zero - clear existing timeout AND immediately signal
            (this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout)) || this.signal('timeout');
        return this;
    },
    timeout: function () {
        (this.args[1].regex || {}).lastIndex = this.lastIndex;
        if (this.data.endsWith('B') || !this.args[1].regex) { // received ACK or not seeking a pattern match
            debug(this.leg.session.sid, 'timeout:', this.data, '- DONE', new Date);
            this.list.push(this.data) && (this.data = '');
            if (this.conclude) // having a conclude method means we're running a non-ARC/single-stage transaction
                return this.enter(null);

            else if (!this.callbacks.length) // otherwise try calling multi-phase callbacks
                null;
            else if (this.callbacks.outcomes)
                this.callbacks.shift()(null, '+SUCCESS', this.list.shift());
            else
                this.callbacks.shift()(null, this.list.shift());
            return this;

        } else if (!this.args[1].regex.exec('#' + this.data)) { // still seeking a pattern match
            debug(this.leg.session.sid, 'timeout:', this.data, '- MORE', exports.moreMs + 'ms', new Date);
            this.timeout = worker.resetTimeout.call(this.leg.session.sid, this.timeout, this.enter.bind(this, null), exports.moreMs);
            return this;

        } else { // have a pattern match - send ACK (below)
            this.lastIndex = this.args[1].regex.lastIndex;
            debug(this.leg.session.sid, 'timeout:', this.data, '- ACK', new Date);
        }

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.leg.session.sid, err);
            sm.list.push(sm.data) && (sm.data = '');
            return sm.enter(null);

            if (sm.conclude) // having a conclude method means we're running a non-ARC/single-stage transaction
                return sm.enter(null);

            else if (!sm.callbacks.length) // otherwise try calling multi-phase callbacks
                null;
            else if (sm.callbacks.outcomes)
                sm.callbacks.shift()(null, '+SUCCESS', sm.list.shift());
            else
                sm.callbacks.shift()(null, sm.list.shift());

        }, function () {
            debug(sm.leg.session.sid, 'timeout.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.leg.uuid, this);

        }, function (evt) {
            var ack = 'b@80';
            debug(sm.leg.session.sid, 'timeout.2:', 'send_dtmf', ack, sm.data, new Date);
            esl.executeAsyncX('send_dtmf', [ack], sm.leg.uuid, this);

        }, function () {
            debug(sm.leg.session.sid, 'timeout.3:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.leg.uuid, this);

        });
        return this;
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.leg.session.sid, 'acknowledge:');
        if (this.list.length) // already have a followup Leg-response to dispatch
            Array.isArray(match) ? cb(null, this.list.shift()) : cb(null, '+SUCCESS', this.list.shift());
        else // save the callback ready for the next complete Leg-response
            this.callbacks.outcomes = this.callbacks.push(cb) && !Array.isArray(match);
        return this;
    },
});
