#! /usr/bin/env node-strict
module.exports = new (function Bs8521() {
    Object.assign(this, {
        Close: Close,           // state-machine to action channel-close
        Establish: Establish,   // state-machine to action the channel establish
        Keepalive: Null,        // state-machine to action the keepalive control
        Speech: Speech,         // state-machine to action simplex/duplex control
        dtmfMaxMs: 2500,        // max valid DTMF duration
        keepaliveMs: 60000,     // time between keep-online messages
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name;
var chain = require('scope-chain');
var debug = require('debug')(Variant.toLowerCase());
var esl = require('../../esl');
var main = require.main.exports;
var nowip = require('../../nowip');
var worker = require('../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        attempts: isNaN(communicator.session.context.bs8521) ? 2 : communicator.session.context.bs8521, // number of ENQ attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: '',                   // accumulator for received data
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    A26H: /#A?(\d{26})#?/g,     // regexp to scan BS8521 digits
    a26Ms: 110,                 // inter-digit delay when next expecting '#'
    ackMs: 1500,                // delay to check ACK has been heard
    ackTones: 'b@80',           // tones to ACK device data
    dumpMs: 10000,              // silence delay to forced hangup
    enqMs: 1300,                // repeat enquire delay
    enqTones: 'b@600',          // tones to provoke device data
    hashMs: NaN,                // special silence delay following a '#'
    silenceMs: 230,             // end of data delay

    enter: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.enter:', JSON.stringify({ enterMs: Date.now() - this.communicator.answered }));
        if (!this.attempts)
            return this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.communicator.session.sid, 'Establish.leave:', JSON.stringify({ leaveMs: Date.now() - this.communicator.answered }));
        this.timeout = worker.resetTimeout(this.timeout);
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
    release: function () {
        debug(this.communicator.session.sid, 'Establish.release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    action: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.action:', this.attempts, JSON.stringify({ actionMs: Date.now() - this.communicator.answered }));
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), Establish.enqMs);
        debug(this.communicator.session.sid, 'Establish.action:', 'send_dtmf', 'ENQ', Establish.enqTones);
        esl.executeAsyncX('send_dtmf', [Establish.enqTones], this.communicator.uuid);
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, 'Establish.TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var timeoutMs, match, durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < module.exports.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        Establish.A26H.lastIndex = this.lastIndex;
        if (!this.data.length || this.data.endsWith('#'))
            timeoutMs = Establish.hashMs; // usually NaN - i.e. leaves the timeout unchanged
        else if (match = Establish.A26H.exec('#' + this.data))
            timeoutMs = Establish.a26Ms; // usually 110
        else
            timeoutMs = Establish.silenceMs // usually 230
        isNaN(timeoutMs) || (this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'timeout'), timeoutMs));
        debug(this.communicator.session.sid, 'Establish.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data, timeoutMs + 'ms');
        return this;
    },
    timeout: function () {
        debug(this.communicator.session.sid, 'Establish.timeout:', this.lastIndex, this.data.slice(this.lastIndex));
        var match, parsed = {}, data = this.data;
        Establish.A26H.lastIndex = this.lastIndex;
        while (match = Establish.A26H.exec('#' + data)) { // until verified, for-each matching segment
            this.lastIndex = Establish.A26H.lastIndex; // remember what we've matched so far
            if (this.verified = (parsed = nowip.parse(match[1]) || {}).verified) // parse & validate the NOWIP digits
                break;
        }
        if (!parsed.verified)
            return this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'release'), Establish.dumpMs);

        parsed.grouped = ['1', '2', '3'].includes(parsed.$.system);
        if (parsed.grouped && 'bs8521Grp' in this.communicator.session.context) // redirect dial-string for any TTNew Grouped Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.bs8521Grp, _bs8521Grp: data });

        if ('bs8521Any' in this.communicator.session.context) // redirect dial-string for any TTNew Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.bs8521Any, _bs8521Any: data });

        parsed.$.speech = 1; // VOX
        parsed.$.controller = this.communicator.dataset + parsed.$.controller.slice(this.communicator.dataset.length);
        data = nowip.stringify(parsed);
        Object.assign(this.communicator.session.payload, { ATM: { data: [data] }, bs8521: parsed, originUser: data.slice(4, 16).replace(/^0+/, '') });
        Object.assign(this.communicator, { grouped: false, hvs: true }); // these may need to change as we accomodate more equipment
        this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), Establish.ackMs);
        debug(this.communicator.session.sid, 'Establish.timeout:', 'send_dtmf', 'ACK', Establish.ackTones);
        esl.executeAsyncX('send_dtmf', [Establish.ackTones], this.communicator.uuid);
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
    tones: 'a@250+d@80',        // pathClose tones

    enter: function () {
        debug(this.communicator.session.sid, 'Close.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Close.leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.conclude(); // Close
    },
    action: function () {
        debug(this.communicator.session.sid, 'Close.action:');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'release'), Close.dumpMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Close.timeout:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'Close.action:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);


        }, function (evt) {
            debug(sm.communicator.session.sid, 'Close.action:', 'send_dtmf', Close.tones);
            esl.executeAsyncX('send_dtmf', [Close.tones], sm.communicator.uuid, this);

        });
        return this;
    },
    release: function () {
        debug(this.communicator.session.sid, 'Close.release:');
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
        attempts: 2,                // send twice
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        tones: duplex ? Speech.duplexTones : Speech.simplexTones, // desired mode tones
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Speech, { // class setup
    duplexTones: 'a38#@80',     // pathDuplex tones
    silenceMs: 2000,            // delay after detecting any tones
    simplexTones: 'a39#@80',    // pathSimplex tones

    enter: function () {
        debug(this.communicator.session.sid, 'Speech.enter:', Speech.actionMs);
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Speech.leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.conclude(); // Speech
    },
    action: function () {
        debug(this.communicator.session.sid, 'Speech.action:', this.attempts);
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), Speech.silenceMs);
        var sm = this;
        chain(function (err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Speech.block:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'Speech.action:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'Speech.action:', 'send_dtmf', sm.tones);
            esl.executeAsyncX('send_dtmf', [sm.tones], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'Speech.action:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
});

//==================================================
require('util').inherits(Null, require('../../state-machine'));
function Null(communicator, conclude) {
    if (this instanceof Null === false)
        throw new Error('Constructor', Variant + ':Null requires \'new\'');

    Null.super_.call(this, Null, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Null, { // class setup
    tones: 'a@250+#@80',        // pathNull tone
    silenceMs: 2000,            // delay after detecting any tones

    enter: function () {
        debug(this.communicator.session.sid, 'Null.enter:');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'action'), 0);
        return this;
    },
    leave: function () {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Null.leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.conclude(); // Null
    },
    action: function () {
        debug(this.communicator.session.sid, 'Null.action:');
        this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), Null.silenceMs);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Null.action:', err);

        }, function () {
            debug(sm.communicator.session.sid, 'Null.action:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.communicator.uuid, this);

        }, function (evt) {
            debug(sm.communicator.session.sid, 'Null.action:', 'send_dtmf', Null.tones);
            esl.executeAsyncX('send_dtmf', [Null.tones], sm.communicator.uuid, this);

        }, function () {
            debug(sm.communicator.session.sid, 'Null.action:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
});
