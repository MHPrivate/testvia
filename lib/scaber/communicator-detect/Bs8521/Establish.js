var chain = require('scope-chain');
var debug;
var esl = require('../../../esl');
var nowip = require('../../../nowip');
var worker = require('../../worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = exports = function Establish(communicator, conclude) {
    debug || (debug = exports.debug);
    if (this instanceof exports === false)
        throw new Error('Constructor', 'Communicator:Detect:' + exports.protocol.constructor.name + ':' + exports.name + ' requires \'new\'');

    exports.super_.call(this, exports, { // instance setup
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
Object.assign(exports, { // class setup
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
        debug.enabled && debug(this.communicator.session.sid, exports.name + '.enter:', JSON.stringify({ enterMs: Date.now() - this.communicator.answered }));
        if (!this.attempts)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), 0);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), 0);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug.enabled && debug(this.communicator.session.sid, exports.name + '.leave:', JSON.stringify({ leaveMs: Date.now() - this.communicator.answered }));
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, exports.name + '.leave:', err);
            sm.conclude(conclusion || (sm.verified ? 'verified' : 'refused')); // Establish

        }, function () {
            if (!sm.verified) // only drop_dtmf when successfully verified
                return this();

            debug(sm.communicator.session.sid, exports.name + '.leave.1:', 'drop_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.communicator.uuid, this);

        });
    },
    release: function () {
        debug(this.communicator.session.sid, exports.name + '.release:', this.communicator.stmf ? 'STMF' : 'DTMF');
        this.enter(null, 'release');
    },
    action: function () {
        debug.enabled && debug(this.communicator.session.sid, exports.name + '.action:', this.attempts, JSON.stringify({ actionMs: Date.now() - this.communicator.answered }));
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), exports.enqMs);
        debug(this.communicator.session.sid, exports.name + '.action:', 'send_dtmf', 'ENQ', exports.enqTones);
        esl.executeAsyncX('send_dtmf', [exports.enqTones], this.communicator.uuid);
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, exports.name + '.TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var timeoutMs, match, durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < exports.protocol.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        exports.A26H.lastIndex = this.lastIndex;
        if (!this.data.length || this.data.endsWith('#'))
            timeoutMs = exports.hashMs; // usually NaN - i.e. leaves the timeout unchanged
        else if (match = exports.A26H.exec('#' + this.data))
            timeoutMs = exports.a26Ms; // usually 110
        else
            timeoutMs = exports.silenceMs // usually 230
        isNaN(timeoutMs) || (this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs));
        debug(this.communicator.session.sid, exports.name + '.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data, timeoutMs + 'ms');
        return this;
    },
    timeout: function () {
        debug(this.communicator.session.sid, exports.name + '.timeout:', this.lastIndex, this.data.slice(this.lastIndex));
        var match, parsed = {}, data = this.data;
        exports.A26H.lastIndex = this.lastIndex;
        while (match = exports.A26H.exec('#' + data)) { // until verified, for-each matching segment
            this.lastIndex = exports.A26H.lastIndex; // remember what we've matched so far
            if (this.verified = (parsed = nowip.parse(match[1]) || {}).verified) // parse & validate the NOWIP digits
                break;
        }
        if (!parsed.verified)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), exports.dumpMs);

        parsed.grouped = ['1', '2', '3'].includes(parsed.$.system);
        if (parsed.grouped && 'bs8521Grp' in this.communicator.session.context) // redirect dial-string for any BS8521 Grouped Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.bs8521Grp, _bs8521Grp: data });

        if ('bs8521Any' in this.communicator.session.context) // redirect dial-string for any BS8521 Communicator
            return this.communicator.session.signal('contextRelease', { bridge: this.communicator.session.context.bs8521Any, _bs8521Any: data });

        //parsed.$.speech = 1; // VOX
        parsed.$.controller = this.communicator.dataset + parsed.$.controller.slice(this.communicator.dataset.length);
        data = nowip.stringify(parsed);
        Object.assign(this.communicator.session.payload, { ATM: { data: [data] }, bs8521: parsed, originUser: data.slice(4, 16).replace(/^0+/, '') });
        Object.assign(this.communicator, { grouped: parsed.grouped, hvs: parsed.$.speech === 1 });
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), exports.ackMs);
        debug(this.communicator.session.sid, exports.name + '.timeout:', 'send_dtmf', 'ACK', exports.ackTones);
        esl.executeAsyncX('send_dtmf', [exports.ackTones], this.communicator.uuid);
    },
});
