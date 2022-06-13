var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Catalogue, require('../../../state-machine'));
function Catalogue(communicator, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Communicator:Detect:TtOld:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(communicator.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
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
        communicator: communicator, // reference to parent state-machine
        conclude: [conclude].filter(Boolean), // callback to signal State complete
        data: '',                   // received DTMF
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    alarmMs: 3500,          // 1st alarm-digits timeout
    fdcTones: 'ddda@80',    // acceptor is full duplex capable tones
    pauseMs: 230,           // end of alarm-digits timeout

    enter: function () {
        debug(this.communicator.session.sid, 'enter:', this.args[0], this.args.slice(2));
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.alarmMs);
        return this;
    },
    leave: function (abort) {
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        if (this.leaving++) // already leaving - prevent recursion
            return;

        if (abort)
            return debug(this.communicator.session.sid, 'leave: aborted');

        debug.enabled && debug(this.communicator.session.sid, 'leave:', JSON.stringify(this.communicator.grouped));
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '-ABORTED');
        else
            this.callbacks.shift()(null, ''); // TODO - need to format available alarms
        this.conclude.length && this.conclude.shift()(); // Catalogue
    },
    action: function () {
        if (this.communicator.grouped.fdcSent || !this.communicator.hvs)
            return;

        debug(this.communicator.session.sid, 'action:', new Date);
        this.communicator.grouped.forcePending = false;
        this.communicator.grouped.fdcSent = true;

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'action:', err);
            sm.signal('timeout'); // re-signal timeout after sending full-duplex-capable

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'action.2:', 'send_dtmf', exports.fdcTones, 'FDC', esl.dtmfMs(exports.fdcTones) + 'ms', new Date);
            esl.executeAsyncX('send_dtmf', [exports.fdcTones], sm.communicator.uuid, this);

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
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), exports.pauseMs);
        return this;
    },
    timeout: function () {
        if (this.signal('action')) // send Full Duplex Capable message if not already sent
            return;

        var parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.alarm8);
        this.data = ''; // reset for next group of alarm digits

        if (parsed)
            this.communicator.grouped.alarms[parsed.raw] = parsed; // overwrites if already present, but retains order
        debug(this.communicator.session.sid, 'timeout:', this.data || '-', parsed ? 'parsed' : 'invalid', JSON.stringify(this.communicator.grouped.alarms), new Date);
        if (!this.callbacks.length)
            null;
        else if (this.callbacks.outcomes)
            this.callbacks.shift()(null, '+SUCCESS');
        else
            this.callbacks.shift()(); // TODO - need to format available alarms
        this.conclude.length && this.conclude.shift()(); // Catalogue
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.communicator.session.sid, 'acknowledge:');
        return cb() || this;
    },
});
