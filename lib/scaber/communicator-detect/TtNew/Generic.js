var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Generic, require('../../../state-machine'));
function Generic(communicator, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Communicator:Detect:TtNew:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(communicator.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
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
        communicator: communicator, // reference to parent state-machine
        conclude: [conclude].filter(Boolean), // callback to signal State complete
        data: '',                   // received DTMF
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        parsed: undefined,          // most recently parsed input
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    idleMs: 230,            // delay waiting for further digits
    retryMs: 240,           // extra delay before retry

    enter: function () {
        debug(this.communicator.session.sid, 'enter:', this.args[0], this.args.slice(2));
        typeof this.args[1].send === 'string' ? this.signal('action') : this.enter(null);
        return this;
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.communicator.session.sid, 'leave: aborted');

        debug(this.communicator.session.sid, 'leave:');
        if (this.args[1].send === true) // fake success (false indicates failure)
            this.parsed = true;
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            (this.parsed || !this.args[1].regex ? this.callbacks.shift()(null, '+SUCCESS') : this.callbacks.shift()(null, '-ABORTED'));
        else
            (this.parsed || !this.args[1].regex ? this.callbacks.shift()() : this.callbacks.shift()(null, ''));
        this.conclude.length && this.conclude.shift()(); // Generic
    },
    action: function () {
        debug(this.communicator.session.sid, 'action: attempts', this.attempts, this.args[1].send, new Date);
        if (!this.attempts-- || !this.args[1].send)
            return this.enter(null);

        var dtmfMs = esl.dtmfMs(this.args[1].send);
        if (this.args[1].regex) // expecting a response
            this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), dtmfMs + (this.args[1].retryMs || exports.retryMs));
        else // no response expected
            this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), dtmfMs + (this.args[1].delayMs || 70));

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'action.2:', 'send_dtmf', sm.args[1].send, dtmfMs + 'ms', new Date);
            esl.executeAsyncX('send_dtmf', [sm.args[1].send], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'action.3:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
    DTMF: function (evt) {
        var digit = evt.headers['DTMF-Digit'],
            durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs > module.parent.exports.dtmfMaxMs)
            return debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, '- TOO LONG', new Date);

        this.data += digit;
        debug(this.communicator.session.sid, 'DTMF:', digit + '@' + durationMs, this.data, exports.pauseMs + 'ms', new Date);
        if (this.args[1].regex) // only update timeout if we're waiting for a response
            this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.idleMs);
        return this;
    },
    timeout: function () {
        if (this.args[1].regex)
            this.parsed = this.data.match(this.args[1].regex);
            leave = true;
        debug(this.communicator.session.sid, 'timeout:', this.data, this.parsed ? 'parsed' : 'invalid', new Date);
        return this.enter(null);
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.communicator.session.sid, 'acknowledge:');
        cb();
        return this;
    },
});
