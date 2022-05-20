var azure = require('../../../azure'),
    chain = require('scope-chain'),
    debug,
    esl = require('../../../esl'),
    nowip = require('../../../nowip'),
    worker = require('../../worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

require('util').inherits(module.exports = exports = Establish, require('../../../state-machine'));
function Establish(communicator, conclude) {
    debug || (debug = module.parent.exports.debug.extend(exports.name.toLowerCase()));
    if (this instanceof exports === false)
        throw new Error('Constructor Communicator:Detect:Bsia:' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
        attempts: isNaN(communicator.session.context.bsia) ? 2 : communicator.session.context.bsia, // number of HANDSHAKE attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: [''],                 // accumulator for received data
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: [],        // array of {account,channels,status}
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(exports, { // class setup
    a4c8s:  /^(?<account>\w{4})(?<channels>\d{8})(?<status>[789])$/,
    a5c8s:  /^(?<account>\w{5})(?<channels>\d{8})(?<status>[789])$/,
    a6c8s:  /^(?<account>\w{6})(?<channels>\d{8})(?<status>[789])$/,
    a4c16s: /^(?<account>\w{4})(?<channels>\d{16})(?<status>[789])$/,
    a5c16s: /^(?<account>\w{5})(?<channels>\d{16})(?<status>[789])$/,
    a6c16s: /^(?<account>\w{6})(?<channels>\d{16})(?<status>[789])$/,
    a4c24s: /^(?<account>\w{4})(?<channels>\d{24})(?<status>[789])$/,
    a5c24s: /^(?<account>\w{5})(?<channels>\d{24})(?<status>[789])$/,
    a6c24s: /^(?<account>\w{6})(?<channels>\d{24})(?<status>[789])$/,
    ackMs: 0,                   // delay to check ACK has been heard
    ackTones: '%(750,0,1400)',  // tones to ACK device data
    hsMs: 1500,                 // repeat hand-shake delay
    hsTones: '%(100,100,1400);%(100,1,2300)',    // hand-shake tones
    silenceMs: 1000,            // end of data delay

    enter: function () {
        debug(this.communicator.session.sid, 'enter:');
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), 0);

        var sm = this;
        chain(function (err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.enter', err);
            sm.signal('action');

        }, function () {
            debug(sm.communicator.session.sid, 'enter:', 'spandsp_start_dtmf', new Date);
            esl.executeAsyncX('spandsp_start_dtmf', [], sm.communicator.uuid, this);

        })
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified.length ? 'verified' : 'refused')); // Establish

        }, function () {
            debug(sm.communicator.session.sid, 'action:', 'spandsp_stop_dtmf', new Date);
            esl.executeAsyncX('spandsp_stop_dtmf', [], sm.communicator.uuid, this);

        }, function () {
            if (!sm.verified.length) // only drop_dtmf when successfully verified
                return this();

            debug(sm.communicator.session.sid, 'leave.1:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
    },
    release: function () {
        debug(this.communicator.session.sid, 'release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    action: function () {
        debug(this.communicator.session.sid, 'action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.hsMs); // usually 1500ms
        debug(this.communicator.session.sid, 'action:', 'gentones', 'HS', exports.hsTones, exports.hsMs + 'ms', new Date);
        esl.executeAsyncX('gentones', [exports.hsTones], this.communicator.uuid);
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var timeoutMs = exports.silenceMs,
            durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.parent.exports.dtmfMaxMs) {
            this.data[0] += evt.headers['DTMF-Digit'];
            if (this.data.length > 1 && this.data[0] === this.data[1]) { // two identical digit strings
                timeoutMs = exports.ackMs; // usually 0ms
            } else if (this.data[0].length > 6 && '789'.includes(evt.headers['DTMF-Digit'])) { // status digit
                this.data.unshift('');
            }
        }

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs);
        debug(this.communicator.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, JSON.stringify(this.data), timeoutMs + 'ms', new Date);
        return this;
    },
    timeout: function () {
        debug(this.communicator.session.sid, 'timeout:', JSON.stringify(this.data));
        var data = this.data[0],
            match;
        switch (data.length) {
            case 13: match = exports.a4c8s.exec(data); break;
            case 14: match = exports.a5c8s.exec(data); break;
            case 15: match = exports.a6c8s.exec(data); break;
            case 21: match = exports.a4c16s.exec(data); break;
            case 22: match = exports.a5c16s.exec(data); break;
            case 23: match = exports.a6c16s.exec(data); break;
            case 29: match = exports.a4c24s.exec(data); break;
            case 30: match = exports.a5c24s.exec(data); break;
            case 31: match = exports.a6c24s.exec(data); break;
        }
        if (!match)
            return;

        this.verified.push(Object.assign({ when: new Date }, match.groups));

        debug(this.communicator.session.sid, 'timeout:', 'gentones', 'ACK', exports.ackTones, exports.ackMs + 'ms', new Date);
        Object.assign(this.communicator.session.payload, { protocol: 'BSIA', originUser: match.groups.account, bsia: this.verified });
        esl.executeAsyncX('gentones', [exports.ackTones], this.communicator.uuid);
    },
});
