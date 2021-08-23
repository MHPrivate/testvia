var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    nowip = require('../../../nowip'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

require('util').inherits(module.exports = exports = Generic, require('../../../state-machine'));
function Generic(communicator, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor', 'Communicator:Detect:Bs8521:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(communicator.session.sid, 'Generic:', util.inspect(args, { breakLength: Infinity }));
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
        callbacks: [args.pop()],    // Consumer callback - updated by 'acknowledge'
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: '',                   // received DTMF
        lastIndex: 0,               // last successful A26H scan point
        list: [],                   // list of catalogue responses
        leaving: 0,                 // used to prevent recursive calls to state:leave method
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
        debug(this.communicator.session.sid, 'enter:', this.args[0], this.args.slice(2));
        this.signal('action');
        return this;
    },
    leave: function (abort) {
        if (this.leaving++ || abort) // already leaving - prevent recursion
            return;

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        var parsed,
            data = this.data || this.list.shift() || '';
        this.callbacks.length && this.callbacks.shift()(null, data);
        if (['catalogue', 'select'].includes(this.args[0]) && (parsed = nowip.parse(data.slice(1, -1), 'unit,event,location,priority,status'))) {
            debug(this.communicator.session.sid, 'leave: updating payload', JSON.stringify(parsed));
            Object.assign(this.communicator.session.payload.bs8521.$, parsed.$); // for stringify
            Object.assign(this.communicator.session.payload.bs8521, parsed); // for easy access
            this.communicator.grouped.unit = parsed.unit;
        } else if ('quick' === this.args[0] && (9 === +this.args[1][1]) && (parsed = data.match(/A0000(\d\d)#/))) {
            debug(this.communicator.session.sid, 'leave: pending', +parsed[1], JSON.stringify(parsed));
            this.communicator.grouped.pending = +parsed[1];
        } else {
            debug(this.communicator.session.sid, 'leave:', JSON.stringify({ type: this.args[0], match1: +this.args[1][1], data: data }));
        }
        this.conclude && this.conclude(data); // Generic
    },
    action: function () {
        var timeoutMs = exports.retryMs + esl.digitsMs(this.args[1].send);
        debug(this.communicator.session.sid, 'action: attempts', this.attempts, this.args[1].send, new Date);
        if (!this.attempts-- || !this.args[1].send)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), timeoutMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'allow_dtmf', new Date);
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'action.2:', 'send_dtmf', sm.args[1].send, timeoutMs + 'ms', new Date);
            esl.executeAsyncX('send_dtmf', [sm.args[1].send], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'action.3:', 'block_dtmf', new Date);
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
    DTMF: function (evt) {
        var digit = evt.headers['DTMF-Digit'],
            durationMs = evt.headers['DTMF-Duration'] / 8,
            regex = this.args[1].regex,
            timeoutMs;
        if (durationMs > module.parent.exports.dtmfMaxMs)
            return debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG', new Date);

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
        debug(this.communicator.session.sid, 'DTMF:', digit + '@' + durationMs, this.data, timeoutMs + 'ms', new Date);
        if (timeoutMs)
            this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs);
        else if (isNaN(timeoutMs))
            null; // leave the current timeout unchanged
        else // timeoutMs is zero - clear existing timeout AND immediately signal
            (this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout)) || this.signal('timeout');
        return this;
    },
    timeout: function () {
        (this.args[1].regex || {}).lastIndex = this.lastIndex;
        if (this.data.endsWith('B') || !this.args[1].regex) { // received ACK or not seeking a pattern match
            debug(this.communicator.session.sid, 'timeout:', this.data, '- DONE', new Date);
            this.list.push(this.data) && (this.data = '');
            if (this.conclude) // having a conclude method means we're running a non-ARC/single-stage transaction
                return this.enter(null);

            else if (this.callbacks.length) // otherwise try calling multi-phase callbacks
                this.callbacks.shift()(null, this.list.shift());
            return this;

        } else if (!this.args[1].regex.exec('#' + this.data)) { // still seeking a pattern match
            debug(this.communicator.session.sid, 'timeout:', this.data, '- MORE', exports.moreMs + 'ms', new Date);
            this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), exports.moreMs);
            return this;

        } else { // have a pattern match - send ACK (below)
            this.lastIndex = this.args[1].regex.lastIndex;
            debug(this.communicator.session.sid, 'timeout:', this.data, '- ACK', new Date);
        }

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, from || 'timeout:', err);
            sm.list.push(sm.data) && (sm.data = '');
            if (sm.conclude) // having a conclude method means we're running a non-ARC/single-stage transaction
                return sm.enter(null);

            else if (sm.callbacks.length) // otherwise try calling multi-phase callbacks
                sm.callbacks.shift()(null, sm.list.shift());

        }, function () {
            debug(sm.communicator.session.sid, 'timeout.1:', 'allow_dtmf', new Date);
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            var ack = 'b@80';
            debug(sm.communicator.session.sid, 'timeout.2:', 'send_dtmf', ack, sm.data, new Date);
            esl.executeAsyncX('send_dtmf', [ack], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'timeout.3:', 'block_dtmf', new Date);
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.communicator.session.sid, 'acknowledge:');
        if (this.list.length) // already have a followup Communicator-response to dispatch
            cb(null, this.list.shift());
        else // save the callback ready for the next complete Communicator-response
            this.callbacks.push(cb);
        return this;
    },
});
