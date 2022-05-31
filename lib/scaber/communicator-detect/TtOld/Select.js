var chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    util = require('util'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Select, require('../../../state-machine'));
function Select(communicator, conclude, args) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Communicator:Detect:TtOld:' + exports.name + ' requires \'new\'');

    debug.enabled && debug(communicator.session.sid, exports.name + ':', util.inspect(args, { breakLength: Infinity }));
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
        callbacks: [args.pop()],    // Consumer callback - updated by 'acknowledge'
        communicator: communicator, // reference to parent state-machine
        conclude: [conclude].filter(Boolean), // callback to signal State complete
        data: '',                   // received DTMF
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        parsed: undefined,          // most recently parsed input
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    alarmMs: 3500,          // 1st alarm-digits timeout
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

        var fetched = this.communicator.grouped.fetch(true),
            payload = this.communicator.session.payload;
        Object.assign(payload.tt, {
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
            //events: [ // tt.battery not present in ttold
            //    payload.tt.callcode + payload.tt.battery,
            //    payload.tt.callcode + '*',
            //    '*' + payload.tt.battery,
            //],
            fetched: fetched,
            grouped: true,
            //location: payload.tt.location, // tt.location not present in ttold
        });
        if (this.data[0] === 'D') // select-confirmation indicates tone-controlled
            this.communicator.speech = 'legacy';
        debug.enabled && debug(this.communicator.session.sid, 'leave:', JSON.stringify({ speech: this.communicator.speech || 'duplex', fetched: fetched, parsed: this.parsed, payload: payload }));
        this.callbacks.length && this.callbacks.shift()(null, ''); // TODO 
        this.conclude.length && this.conclude.shift()(); // Select
    },
    action: function () {
        if (this.actioned++) // already actioned
            return;

        debug(this.communicator.session.sid, 'action:', new Date);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'action.1:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            var selectTones = ('000' + sm.args[2]).slice(-3).replace(/0/g, 'd') + 'b@80';
            debug(sm.communicator.session.sid, 'action.2:', 'send_dtmf', selectTones, esl.dtmfMs(selectTones) + 'ms', new Date);
            esl.executeAsyncX('send_dtmf', [selectTones], sm.communicator.uuid, this);

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
        this.signal('action'); // send Full Duplex Capable message if not already sent
        if (this.parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.alarm8)) // alarm-digits
            this.communicator.grouped.alarms[this.parsed.raw] = this.parsed; // overwrites if already present, but retains order
        else if (this.parsed = module.parent.exports.parse(this.data, module.parent.exports.parse.selco)) // select-confirmation-messa
            this.enter(null);
        debug(this.communicator.session.sid, 'timeout:', this.data, this.parsed ? 'parsed' : 'invalid', JSON.stringify(this.communicator.grouped.alarms), new Date);
        this.data = ''; // reset for further groups of alarm-digits
        return this;
    },
    acknowledge: function (match, cb) { // from Consumer
        debug(this.communicator.session.sid, 'acknowledge:');
        return cb() || this;
    },
});
