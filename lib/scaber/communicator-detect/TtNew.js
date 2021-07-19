#! /usr/bin/env node-strict
module.exports = new (function TtNew() {
    Object.assign(this, {
        Close: Close,           // state-machine to action channel-close
        Establish: Establish,   // state-machine to action the channel establish
        Keepalive: Listen,      // state-machine to action the keepalive control
        Speech: Speech,         // state-machine to action simplex/duplex control
        dtmfMaxMs: 2500,        // max valid DTMF duration
        keepaliveMs: 120000,    // time between keep-online messages
        parse: parse,           // validating parser function for TT92 data
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name;
var chain = require('scope-chain');
var debug = require('debug')(Variant.toLowerCase());
var esl = require('../../esl');
var main = require.main.exports;
var worker = require('../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        attempts: isNaN(communicator.session.context.ttnew) ? 2 : communicator.session.context.ttnew, // number of ENQ attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,  // regexp to scan TTNew digits
    ackMs: 3000,                // delay to check ACK has been heard
    ackTones: 'db@80',          // DTMF to acknowledge DataMessage
    dumpMs: 10000,              // silence delay to forced hangup
    enqMs: 900,                 // repeat enquire delay
    enqTones: 'db@80',          // DTMF to provoke the DataMessage
    silenceMs: 230,             // end of data delay

    enter: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.enter:', JSON.stringify({ enterMs: Date.now() - this.communicator.answered }));
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.communicator.session.sid, 'Establish.leave:', JSON.stringify({ leaveMs: Date.now() - this.communicator.answered }));
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.leave:', err);
            sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.communicator.session.sid, 'Establish.leave.1:', 'drop_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
    },
    action: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.action:', this.attempts, JSON.stringify({ actionMs: Date.now() - this.communicator.answered }));
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), Establish.enqMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'Establish.action:', 'send_dtmf', 'ENQ', Establish.enqTones);
            esl.executeAsyncX('send_dtmf', [Establish.enqTones], sm.communicator.uuid, this);

        });
    },
    release: function () {
        debug(this.communicator.session.sid, 'Establish.release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), Establish.silenceMs);
        debug(this.communicator.session.sid, 'Establish.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data.slice(1), Establish.silenceMs + 'ms');
        return this;
    },
    timeout: function () {
        var match, parsed, data = this.data;
        Establish.DH22.lastIndex = this.lastIndex;
        while (match = Establish.DH22.exec(data)) { // until verified, for-each matching segment
            this.lastIndex = Establish.DH22.lastIndex; // to prevent re-ACK'ing the same data
            if (this.verified = (parsed = parse(match[1], parse.alarm) || {}).verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.communicator.session.sid, 'Establish.timeout:', JSON.stringify(parsed));
        if (!(parsed || {}).verified)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), Establish.dumpMs);

        if (parsed.grouped && 'ttnewGrp' in this.communicator.session.context) // redirect dial-string for any TTNew Grouped Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.ttnewGrp, _ttnewGrp: data });

        if (!parsed.hvs && 'ttnewTvs' in this.communicator.session.context) // non-HVS Communicator and have non-HVS redirect dial-string
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.ttnewTvs, _ttnewTvs: data });

        if ('ttnewAny' in this.communicator.session.context) // redirect dial-string for any TTNew Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.ttnewAny, _ttnewAny: data });

        Object.assign(this.communicator.session.payload, { tt: parsed, originUser: parsed.identity.replace(/\**$/, '') });
        Object.assign(this.communicator, { grouped: parsed.grouped, hvs: parsed.hvs });
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.timeout:', err);
            sm.enter(null);

        }, function () {
            debug(sm.communicator.session.sid, 'Establish.timeout:', 'send_dtmf', 'ACK', Establish.ackTones);
            esl.executeAsyncX('send_dtmf', [Establish.ackTones], sm.communicator.uuid, this);

        }, function (evt) {
            sm.timeout = worker.resetTimeout.call(sm.communicator.session.sid, sm.timeout, this, Establish.ackMs);

        });
    },
});

//==================================================
require('util').inherits(Close, require('../../state-machine'));
function Close(communicator, conclude) {
    if (this instanceof Close === false)
        throw new Error('Constructor', Variant + ':Close requires \'new\'');

    Close.super_.call(this, Close, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Close, { // class setup
    dumpMs: 10000,              // silence delay to forced hangup
    tones: '#@2000',

    enter: function () {
        debug(this.communicator.session.sid, 'Close.enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Close.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(); // Close
    },
    action: function () {
        debug(this.communicator.session.sid, 'Close.action:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), Close.dumpMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Close.timeout:', err);

        }, function () {
            if (sm.communicator.stmf)
                return this();

            debug(sm.communicator.session.sid, 'Close.action:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'Close.action:', 'send_dtmf', Close.tones);
            esl.executeAsyncX('send_dtmf', [Close.tones], sm.communicator.uuid, this);

        });
        return this;
    },
    release: function () {
        debug(this.communicator.session.sid, 'Close.release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null);
    },
});

//==================================================
require('util').inherits(Speech, require('../../state-machine'));
function Speech(communicator, conclude, duplex) {
    if (this instanceof Speech === false)
        throw new Error('Constructor', Variant + ':Speech requires \'new\'');

    if (typeof conclude !== 'function') {
        duplex = conclude;
        conclude = undefined;
    }
    Speech.super_.call(this, Speech, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: '',                   // accumulator for received data
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        tones: duplex ? Speech.duplexTones : Speech.simplexTones, // desired mode tones
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Speech, { // class setup
    actionMs: 200,              // action delay
    duplexTones: '701@80',
    silenceMs: 2000,            // delay after detecting any tones
    simplexTones: '702@80',

    enter: function () {
        debug(this.communicator.session.sid, 'Speech.enter:', Speech.actionMs);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), Speech.actionMs);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Speech.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(); // Speech
    },
    action: function () {
        debug(this.communicator.session.sid, 'Speech.action:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), Speech.silenceMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Speech.action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'Speech.action:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'Speech.action:', 'send_dtmf', this.tones);
            esl.executeAsyncX('send_dtmf', [sm.tones], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'Speech.action:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
    DETECTED_TONE: function (evt) {
        this.data += evt.headers['Detected-Tone']['telecare-stmf:'.length];
        if (this.data.includes('702'))
            this.communicator.simplex = true;
        else if (this.data.includes('701'))
            this.communicator.simplex = false;
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), isNaN(this.communicator.simplex) ? Speech.silenceMs : 0);
        debug(this.communicator.session.sid, 'Speech.TONE:', evt.headers['Detected-Tone'], this.data);
        return this;
    },
    DTMF: function (evt) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        if (this.data.includes('702'))
            this.communicator.simplex = true;
        else if (this.data.includes('701'))
            this.communicator.simplex = false;
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), isNaN(this.communicator.simplex) ? Speech.silenceMs : 0);
        debug(this.communicator.session.sid, 'Speech.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data);
        return this;
    },
});

//==================================================
require('util').inherits(Listen, require('../../state-machine'));
function Listen(communicator, conclude, duplex) {
    if (this instanceof Listen === false)
        throw new Error('Constructor', Variant + ':Listen requires \'new\'');

    if (typeof conclude !== 'function') {
        duplex = conclude;
        conclude = undefined;
    }
    Listen.super_.call(this, Listen, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: '',                   // accumulator for received data
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        tones: duplex ? Listen.duplexTones : Listen.simplexTones, // desired mode tones
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Listen, { // class setup
    silenceMs: 2000,            // delay after detecting any tones
    tones: '*@80',

    enter: function () {
        debug(this.communicator.session.sid, 'Listen.enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Listen.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(); // Listen
    },
    action: function () {
        debug(this.communicator.session.sid, 'Listen.action:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), Listen.silenceMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Listen.action:', err);

        }, function () {
            if (sm.communicator.stmf)
                return this();

            debug(sm.communicator.session.sid, 'Listen.action:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'Listen.action:', 'send_dtmf', Listen.tones);
            esl.executeAsyncX('send_dtmf', [Listen.tones], sm.communicator.uuid, this);

        }, function () {
            if (sm.communicator.stmf)
                return this();

            debug(sm.communicator.session.sid, 'Listen.action:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
});

function parse(data, fields, self) {
    var match = data.match(fields.regex);
    if (!match)
        return null;
    self = Object.defineProperties(fields.filter(Boolean).reduce(function (wksp, field, idx, arr) {
        wksp[field] = match[1 + idx];
        return wksp;
    }, Object.assign(self || {}, { raw: match[0], $: {} })), { raw: { enumerable: false }, $: { enumerable: false } });
    self.generic && Object.assign(self, { grouped: fields.grouped.includes(self.generic), hvs: !fields.simplex.includes(self.generic + self.type) });

    if (data.length - match[0].length === 2) { // have 2 checksum digits
        self.$.checksum = Array.from(('00' + (100 - Array.from(self.raw.toUpperCase()).reduce(function (checksum, digit, idx, arr) {
            return checksum + parse.checksum.indexOf(digit);
        }, 0) % 100)).slice(-2)).map(function (n, idx, arr) { return (+n + 1) % 10 }).join('');
        self.verified = self.$.checksum === data.slice(-2);
    }
    return self;
}
Object.assign(parse, {
    checksum: Array.from('B1234567890AC*D#'),
});
parse.alarm = Object.assign('type,reserved,generic,callcode,identity,padding'.split(','), {
    grouped: Array.from('23'),
    simplex: '00,01,02,03,10,11,12,13,14,20,21'.split(','),
    regex: /^([\dA-D*#])([\dA-D*#])([\dA-D*#])([\dA-D*#])([\dA-D*#]{12})([\dA-D*#]{4})/,
});
