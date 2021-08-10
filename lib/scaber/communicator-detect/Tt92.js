#! /usr/bin/env node-strict
module.exports = exports = new (function Tt92() {
    Object.assign(this, {
        Close: Close,           // state-machine to action channel-close
        Establish: Establish,   // state-machine to action the channel establish
        Keepalive: Listen,      // state-machine to action the keepalive control
        //Speech: Speech,         // state-machine to action simplex/duplex control - TyneTec Reach doesn't like Duplex
        dtmfMaxMs: 2500,        // max valid DTMF duration
        keepaliveMs: 120000,    // time between keep-online messages
        parse: parse,           // validating parser function for TT92 data
    });
})();

var Variant = 'Communicator:Detect:' + module.exports.constructor.name,
    chain = require('scope-chain'),
    debug = require('debug')(Variant.toLowerCase()),
    esl = require('../../esl'),
    main = require.main.exports,
    worker = require('../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

var tonesCmd = ['send_dtmf', 'gentones'];

//==================================================
require('util').inherits(Establish, require('../../state-machine'));
function Establish(communicator, conclude) {
    if (this instanceof Establish === false)
        throw new Error('Constructor', Variant + ':Establish requires \'new\'');

    Establish.super_.call(this, Establish, { // instance setup
        attempts: isNaN(communicator.session.context.tt92) ? 2 : communicator.session.context.tt92, // number of ENQ attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: 'D',                  // accumulator for received data - predict the 'D' in-case we miss it
        lastDetect: undefined,      // last STMF detection-evt timestamp
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // checksum outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, { // class setup
    DH22: /D#([0-9*ABCD#]{22})/g,  // regexp to scan TT92 digits
    ackMs: 3000,                // delay to check ACK has been heard
    ackTones: ['b0@80', '%(80,5,770);%(80,5,1633);%(80,5,941);%(80,80,1336)'], // tones to ACK device data
    dumpMs: 10000,              // silence delay to forced hangup
    enqMs: 1500,                // repeat enquire delay
    enqTones: ['0#@80', '%(80,5,941);%(80,115,1336);%(80,80,941,1336);%(80,80,941,1477)'], // combined STMF:0 + DTMF:0#
    silenceMs: 230,             // end of data delay

    enter: function () {
        debug.enabled && debug(this.communicator.session.sid, 'Establish.enter:', JSON.stringify({ enterMs: Date.now() - this.communicator.answered }));
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
        debug(this.communicator.session.sid, 'Establish.enter:', this.communicator.session.context.tt92NoStmf ? 'DTMF only' : 'spandsp_start_tone_detect:stmf');

        if (!this.communicator.session.context.tt92NoStmf)
            esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-stmf'], this.communicator.uuid);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.communicator.session.sid, 'Establish.leave:', JSON.stringify({ leaveMs: Date.now() - this.communicator.answered }));
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);

        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.leave:', err);
            sm.conclude && sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (sm.communicator.stmf || sm.communicator.session.context.tt92NoStmf) // retain spandsp-tone-detection if we have established using STMF
                return this();

            debug(sm.communicator.session.sid, 'Establish.leave.1:', 'spandsp_stop_tone_detect');
            esl.executeAsyncX('spandsp_stop_tone_detect', [], sm.communicator.uuid, this);

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.communicator.session.sid, 'Establish.leave.2:', 'drop_dtmf');
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
            var n = sm.communicator.session.context.tt92NoStmf ? 0 : 1;
            debug(sm.communicator.session.sid, 'Establish.action:', tonesCmd[n], 'ENQ', Establish.enqTones[n]);
            esl.executeAsyncX(tonesCmd[n], [Establish.enqTones[n]], sm.communicator.uuid, this);

        });
    },
    release: function () {
        debug(this.communicator.session.sid, 'Establish.release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    DETECTED_TONE: function (evt) {
        this.communicator.stmf = true;
        var gapMs,
            lastDetect = this.lastDetect;
        this.lastDetect = evt.when;
        if (lastDetect) // only backfill on 2nd and subsequent tone-detect
            this.data += backfill(this.data, (gapMs = this.lastDetect - lastDetect) / 160 - 1);
        this.data += evt.headers['Detected-Tone']['telecare-stmf:'.length];

        var data = this.data.slice(this.lastIndex), // prevent multiple ACK for same data
            index = data.indexOf('D#'), // find latest instance of 'D#' in received data
            segment = data.slice(index), // extract candidate D#22 segment
            pendingMs = (25 - segment.length) * 160;
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), pendingMs);
        debug(this.communicator.session.sid, 'Establish.TONE:', evt.headers['Detected-Tone'], this.data.slice(1), gapMs || '-', pendingMs);
        return this;
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
        var match,
            parsed,
            data = this.data + backfill(this.data, this.lastDetect && 1);
        Establish.DH22.lastIndex = this.lastIndex;
        while (match = Establish.DH22.exec(data)) { // until verified, for-each matching segment
            this.lastIndex = Establish.DH22.lastIndex; // to prevent re-ACK'ing the same data
            if (this.verified = (parsed = parse(match[1], parse.alarm) || {}).verified) // parse & validate the TT digits
                break;
        }
        debug.enabled && debug(this.communicator.session.sid, 'Establish.timeout:', JSON.stringify(parsed));
        if (!(parsed || {}).verified)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), Establish.dumpMs);

        if (this.communicator.stmf && 'tt92Stmf' in this.communicator.session.context) // STMF Communicator and have STMF redirect dial-string
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Stmf, _tt92Stmf: data });

        if (parsed.grouped && 'tt92Grp' in this.communicator.session.context) // redirect dial-string for any TT92 Grouped Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Grp, _tt92Grp: data });

        if ('tt92Any' in this.communicator.session.context) // redirect dial-string for any TT92 Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Any, _tt92Any: data });

        if (!parsed.hvs && 'tt92Tvs' in this.communicator.session.context) // non-HVS Communicator and have non-HVS redirect dial-string
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.tt92Tvs, _tt92Tvs: data });

        Object.assign(this.communicator.session.payload, { tt: parsed, originUser: parsed.identity.replace(/\**$/, '') });
        Object.assign(this.communicator, { grouped: parsed.grouped, hvs: parsed.hvs });
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, Variant + ':Establish.timeout:', err);
            sm.enter(null);

        }, function () {
            debug(sm.communicator.session.sid, 'Establish.timeout:', tonesCmd[+sm.communicator.stmf], 'ACK', Establish.ackTones[+sm.communicator.stmf]);
            esl.executeAsyncX(tonesCmd[+sm.communicator.stmf], [Establish.ackTones[+sm.communicator.stmf]], sm.communicator.uuid, this);

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
    tones: ['#@2000', '%(80,5,941);%(80,5,1477);%(80,5,941);%(80,80,1477)'], // STMF:##

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
        this.conclude && this.conclude(); // Close
    },
    action: function () {
        debug(this.communicator.session.sid, 'Close.action:', this.communicator.stmf ? 'STMF' : 'DTMF');
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
            debug(sm.communicator.session.sid, 'Close.action:', tonesCmd[+sm.communicator.stmf], Close.tones[+sm.communicator.stmf]);
            esl.executeAsyncX(tonesCmd[+sm.communicator.stmf], [Close.tones[+sm.communicator.stmf]], sm.communicator.uuid, this);

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
    duplexTones: ['701@80', '%(80,5,852);%(80,5,1209);%(80,5,941);%(80,5,1336);%(80,5,697);%(80,80,1209)'], // STMF:701
    silenceMs: 2000,            // delay after detecting any tones
    simplexTones: ['702@80', '%(80,5,852);%(80,5,1209);%(80,5,941);%(80,5,1336);%(80,5,697);%(80,80,1336)'], // STMF:702

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
        this.conclude && this.conclude(); // Speech
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
            debug(sm.communicator.session.sid, 'Speech.action:', tonesCmd[+sm.communicator.stmf], sm.tones[+sm.communicator.stmf]);
            esl.executeAsyncX(tonesCmd[+sm.communicator.stmf], [sm.tones[+sm.communicator.stmf]], sm.communicator.uuid, this);

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
    tones: ['*@80', '%(80,5,941);%(80,80,1209)'], // STMF:*

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
        this.conclude && this.conclude(); // Listen
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
            debug(sm.communicator.session.sid, 'Listen.action:', tonesCmd[+sm.communicator.stmf], Listen.tones[+sm.communicator.stmf]);
            esl.executeAsyncX(tonesCmd[+sm.communicator.stmf], [Listen.tones[+sm.communicator.stmf]], sm.communicator.uuid, this);

        }, function () {
            if (sm.communicator.stmf)
                return this();

            debug(sm.communicator.session.sid, 'Listen.action:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
        return this;
    },
});

function backfill(data, n) {
    return (data && n) ? data[data.length - 1].repeat(n) : '';
}

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
        var a,
            b = parse.checksum1[Array.from(self.raw).reduce(function (wksp, digit, idx, arr) {
                var x = (wksp ^ (a[idx] = parse.checksum.indexOf(digit))) & 0xFF;
                return (((x | x << 8) >> 3) + 1) & 0xFF;
            }.bind(a = Array(self.raw.length)), 0) & 0xF] + parse.checksum2[0];
        self.$.checksum = Array.from(('00' + (100 - (a.reduce(function (wksp, val, idx, arr) {
            return wksp + parse.checksum3[(val + b) & 0xF];
        }, 0) % 100))).slice(-2)).map(function (n, idx, arr) { return (+n + 1) % 10 }).join(''); // #3
        self.verified = self.$.checksum === data.slice(-2);
    }
    return self;
}
Object.assign(parse, {
    checksum: Array.from('0123456789ABCD*#'),
    checksum1: [12, 4, 10, 13, 0, 6, 8, 15, 7, 11, 2, 5, 14, 1, 9, 3],
    checksum2: [4, 12, 8, 14, 6, 13, 2, 9, 15, 3, 11, 7, 1, 5, 0, 10],
    checksum3: [9, 1, 14, 7, 13, 10, 3, 6, 15, 4, 8, 11, 12, 5, 0, 2],
});
parse.alarm = Object.assign('type,reserved,generic,callcode,identity,padding'.split(','), {
    grouped: Array.from('23'),
    simplex: '00,01,02,03,10,11,12,13,14,20,21'.split(','),
    regex: /^([\dA-D*#])([\dA-D*#])([\dA-D*#])([\dA-D*#])([\dA-D*#]{12})([\dA-D*#]{4})/,
});
