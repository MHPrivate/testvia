#! /usr/bin/env node-strict
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:bs8521pnc');
var esl = require('../esl');
var main = require.main.exports;
var mysql = require('../mysql');
var nowip = require('../nowip');
var StateMachine = require('../state-machine');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

function SlsUser(o) {
    if (this instanceof SlsUser === false)
        throw new Error('Constructor SlsUser requires \'new\'');

    Object.assign(this, o);
}

require('util').inherits(module.exports = exports = CommunicatorBs8521Pnc, StateMachine);
function CommunicatorBs8521Pnc(session, evt, dialPrefix) {
    if (this instanceof CommunicatorBs8521Pnc === false)
        throw new Error('Constructor CommunicatorBs8521Pnc requires \'new\'');

    var privacy, map = { 'Caller-Screen-Bit': 'screen', 'Caller-Privacy-Hide-Name': 'hide_name', 'Caller-Privacy-Hide-Number': 'hide_number' };
    Object.keys(map).forEach(function (key, idx, arr) {
        evt.headers[key] === 'true' && this.push(map[key]);
    }, privacy = []);
    CommunicatorBs8521Pnc.super_.call(this, CommunicatorBs8521Pnc, {
        answered: undefined,    // timestamp
        bridged: false,         // set by CHANNEL_BRIDGE, cleared by CHANNEL_PARK
        dialPrefix: dialPrefix, // ?dialPrefix - optional pre-selection
        leaving: 0,             // used to prevent recursive calls to state:leave method
        released: undefined,    // communicator released timestamp
        session: session,       // a reference to the owning session
        slsuser: new SlsUser({  // for passing to the ConsumerSlsUser for for use with originate
            codec: undefined, // will be updated on CHANNEL_ANSWER,
            from_name: evt.headers['Caller-Caller-ID-Name'],
            from_number: evt.headers['Caller-Caller-ID-Number'],
            privacy: privacy.join(':'),
            to_number: undefined, // updated before each signal to Session.consume
        }),
        substates: Object.assign([], { _: undefined }), // chronology of past substates (attr:_ is current substate)
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorBs8521Pnc, { // _this_ of all methods is the StateMachine instance
    advisee: 0,             // arc
    dtmfMaxMs: 2500,
    Commands: Commands,     // state-machine to handle ARC commands
    Establish: Establish,   // state-machine to establish the BS8521 dialog
    Identity: Identity,     // state-machine to acquire the ARC identification data string
    Scheme: Scheme,         // state-machine to collect&&validate scheme dialPrefix

    enter: function onCommunicatorBs8521PncEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorBs8521PncLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        if (this.substates._) // active substate need archiving
            this.substates.push(this.substates._) && (this.substates._ = null);
        for (var i = 0; i < this.substates.length; i++) // ensure all substates are exited
            this.substates[i].enter(null);
        if (this.uuid && !this.released) {
            debug(this.session.sid, 'leave:', 'hangup', this.uuid);
            esl.executeAsyncX('hangup', [], this.uuid);
        }
        this.session.signal('detached');
    },
    clear: function onCommunicatorBs8521PncClear() { // from session.detach - on consumer gone
        debug(this.session.sid, 'clear:', callsites()[2].toString());
        return this;
    },
    release: function onCommunicatorBs8521PncRelease() { // from session.contextRelease
        debug(this.session.sid, 'release:');
        if (!this.uuid)
            return this.enter(null) || this;

        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    answer: function onCommunicatorScaipAnswer(cb) { // from session.answer
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        cb || (cb = function (err) { err && console.log(this.session.sid, 'onCommunicatorDetectAnswer:', err) });
        this.answered ? cb() : esl.executeAsyncX('answer', [], this.uuid, cb);
        return this;
    },
    substate: function onCommunicatorBs8521PncSubstate(Substate, signal, arg) { // helper to activate a new Substate
        var sm = Substate && Substate.super_;
        if (Substate) { // ensure Substate is derived from StateMachine
            while (sm && sm != StateMachine)
                sm = sm.super_;
            if (!sm) // does not inherit from StateMachine
                throw new Error('Substate must be an instance of StateMachine');
        }

        debug(this.session.sid, 'substate:', Substate && Substate.name);
        if (sm = this.substates._) // existing substate assignment test
            this.substates.push(this.substates._) && sm.enter(this.substates._ = null, true); // push first to filter the callback
        this.substates._ = Substate && new Substate(this, signal && function conclude(index) {
            if (index === this.substates.length) // is still the active substate
                this.signal.apply(this, [signal].concat(Array.from(arguments).slice(1)));
        }.bind(this, this.substates.length), arg); // index is a snapshot the current substate index for callback filtering
        return this;
    },
    scheme: function onCommunicatorBs8521PncScheme(conclusion) {
        debug.enabled && debug(this.session.sid, 'scheme:', JSON.stringify(conclusion));
        if (typeof conclusion !== 'object')
            return this.signal('release');

        Object.assign(this.session.context, conclusion); // { lhdigits, dialPrefix }
        this.signal('substate', Identity, 'identity', undefined);
    },
    identity: function onCommunicatorBs8521PncIdentity(conclusion) {
        debug.enabled && debug(this.session.sid, 'identity:', JSON.stringify(conclusion));
        if (typeof conclusion !== 'object')
            return this.signal('release');

        Object.assign(this.session.payload, conclusion); // { ARC, bs8521 }
        var data26 = nowip.stringify({ system: 1, controller: this.session.context.lhdigits.slice(0, 8) }, undefined, true);
        this.signal('substate', Establish, 'establish', data26);
    },
    establish: function onCommunicatorBs8521PncEstablish(conclusion) {
        debug(this.session.sid, 'establish:', conclusion);
        if (conclusion === 'release')
            return this.signal('release');

        this.signal('substate', Commands, 'commands', this.session.context.dialPrefix);
    },
    commands: function onCommunicatorBs8521PncCommands(conclusion) {
        debug.enabled && debug(this.session.sid, 'commands:', JSON.stringify(conclusion));
        var match;
        if (conclusion === 'release') {
            return this.signal('release');
        } else {
            this.session.signal('consume', conclusion);
        }
    },
    CHANNEL_CREATE: function onCommunicatorBs8521PncChannelCreate(evt, first) { // from esl
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        this.session.payload.outbound = true;
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];

        var sm = Object.assign(this, { uuid: evt.headers['Unique-ID'] });
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, evt.type + ':', err);

        }, function () {
            esl.executeAsyncX('set', ['park_after_bridge=true'], sm.uuid, this);

        }, function () {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'record_session', main.hack.record || false);
            if (!sm.session.context.record && !main.hack.record)
                return this();

            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'answer');
            esl.executeAsyncX('answer', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorBs8521PncChannel(evt, first) {  // from esl - miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        switch (evt.type) {
            case 'CHANNEL_ANSWER':
                this.session.advisees[exports.advisee] = this;
                Object.assign(this.slsuser, { codec: evt.headers['variable_rtp_use_codec_name'] });
                this.answered = new Date;
                this.signal('substate', Scheme, 'scheme', this.dialPrefix); // dialPrefix maybe an empty string
                break;

            case 'CHANNEL_BRIDGE':
                this.bridged = true;
                break;

            case 'CHANNEL_PARK':
                this.bridged = false;
                break;

        }
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorBs8521PncChannelDestroy(evt, first) { // from esl a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        this.session.advisees[exports.advisee] = undefined;
        this.released = new Date;
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorBs8521PncCustom(evt, first) {
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorBs8521PncTone(evt, first) { // received tone
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorBs8521PncDtmf(evt, first) { // received BS8521 dtmf
        var durationMs = evt.headers['DTMF-Duration'] / 8; // convert 8khz samples to msec
        switch (evt.headers['DTMF-Digit']) {
            case 'A':
                if (durationMs > 200)
                    evt.headers['DTMF-Digit'] = 'a';
                break;
            case 'B':
                if (durationMs > 500)
                    evt.headers['DTMF-Digit'] = 'b';
                break;
        }
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + evt.headers['DTMF-Duration']);
        return this;
    },
});

//==================================================
require('util').inherits(Scheme, StateMachine);
function Scheme(communicator, conclude, dialPrefix) {
    if (this instanceof Scheme === false)
        throw new Error('Constructor CommunicatorBs8521Pnc:Scheme requires \'new\'');

    Scheme.super_.call(this, Scheme, { // instance setup
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        dtmfs: '',                  // dtmf accumulator
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // cli-match outcome flag
    }, dialPrefix); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Scheme, { // class setup
    rePrefix: /^(4\d{5,6})#$/,  // regex for dialPrefix
    timeoutMs: 15000,       // max time to wait for 4\d{5,6}

    enter: function (dialPrefix) {
        debug(this.communicator.session.sid, 'Scheme.enter:');
        if (dialPrefix)
            return this.signal('lookup', [, dialPrefix]);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), Scheme.timeoutMs);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Scheme.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(conclusion); // Scheme
    },
    timeout: function () {
        debug(this.communicator.session.sid, 'Scheme.timeout:', new Date);
        this.enter(null, 'release');
        return this;
    },
    CUSTOM: function onCommunicatorBs8521PncCustom(evt, first) {
        debug(this.communicator.session.sid, 'Scheme.CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, 'Scheme.TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        if (this.dtmfs.includes('#'))
            return this;

        this.dtmfs += evt.headers['DTMF-Digit'];
        debug(this.communicator.session.sid, 'Scheme.DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8), this.dtmfs);
        var match = this.dtmfs.match(Scheme.rePrefix);
        if (!match)
            return this;

        this.signal('lookup', match);
    },
    lookup: function (match) {
        debug.enabled && debug(this.communicator.session.sid, 'Scheme.lookup:', JSON.stringify(match));
        chain({ index: this.communicator.session.sid }, function (err, configs, meta) {
            err && console.log(this.communicator.session.sid, 'CommunicatorBs8521Pnc:Scheme.DTMF:', err);
            try {
                this.enter(null, (configs || []).length ? Object.assign(JSON.parse(configs[0].valueString), { dialPrefix: match[1] }) : 'release');
            } catch (ex) {
                console.log('CommunicatorBs8521Pnc:Scheme.DTMF:', ex.message, configs[0].valueString);
                this.enter(null, 'release');
            }

        }.bind(this), function () {
            mysql('select * from config where schemeId=0 and nameSlashed=?', ['/scaber/from/' + (match[1] + 'xxx').slice(0, 9) + '/context'], this);
            // context: see Session:Establish.contextRelease

        });
        return this;
    },
});

//==================================================
require('util').inherits(Identity, StateMachine);
function Identity(communicator, conclude) {
    if (this instanceof Identity === false)
        throw new Error('Constructor CommunicatorBs8521Pnc:Identity requires \'new\'');

    Identity.super_.call(this, Identity, { // instance setup
        attempts: Identity.attempts,// number of HELLO attempts
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        data: '',                   // dtmf accumulator
        lastIndex: 0,               // last successful A26H scan point
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        timeout: undefined,         // timeout handle
        verified: undefined,        // cli-match outcome flag
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Identity, { // class setup
    A26H: /#A?(\d{26})#?/g,     // regexp to scan BS8521 digits
    a26Ms: 250,                 // inter-digit delay when next expecting '#'
    ackMs: 950,                 // delay to check ACK has been heard
    ackTones: 'b@80',           // tones to ACK device data
    attempts: 4,                // number of HELLO attempts
    dumpMs: 10000,              // silence delay to forced hangup
    hashMs: NaN,                // special silence delay following a '#'
    helloMs: 8000,              // repeat hello delay
    helloTones: 'b@1000',       // tones to provoke device data
    initialMs: 0,               // delay before 1st HELLO
    silenceMs: 230,             // end of data delay

    enter: function () {
        debug(this.communicator.session.sid, 'Identity.enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), Identity.initialMs);
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Identity.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(conclusion || (this.verified ? 'verified' : 'release')); // Identity
    },
    action: function () {
        debug(this.communicator.session.sid, 'Identity.action:');
        if (!this.attempts--)
            return this.enter(null);

        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'action'), Identity.helloMs);
        debug(this.communicator.session.sid, 'Identity.action:', 'send_dtmf', 'ENQ', Identity.helloTones, new Date);
        worker.legDtmf(this.communicator, Identity.helloTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Identity.helloTones], this.communicator.uuid);

    },
    CUSTOM: function onCommunicatorBs8521PncCustom(evt, first) {
        debug(this.communicator.session.sid, 'Identity.CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, 'Identity.TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt) {
        var timeoutMs, match, durationMs = evt.headers['DTMF-Duration'] / 8;
        if (durationMs < CommunicatorBs8521Pnc.dtmfMaxMs)
            this.data += evt.headers['DTMF-Digit'];
        Identity.A26H.lastIndex = this.lastIndex;
        if (!this.data.length || this.data.endsWith('#'))
            timeoutMs = Identity.hashMs; // usually NaN - i.e. leaves the timeout unchanged
        else if (match = Identity.A26H.exec('#' + this.data))
            timeoutMs = Identity.a26Ms; // usually 250
        else
            timeoutMs = Identity.silenceMs // usually 230
        isNaN(timeoutMs) || (this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'timeout'), timeoutMs));
        debug(this.communicator.session.sid, 'Identity.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.data, timeoutMs + 'ms');
        return this;
    },
    timeout: function () {
        debug(this.communicator.session.sid, 'Identity.timeout:', this.lastIndex, this.data.slice(this.lastIndex));
        var parsed = {}, match;
        Identity.A26H.lastIndex = this.lastIndex;
        while (match = Identity.A26H.exec('#' + this.data)) { // until verified, for-each matching segment
            this.lastIndex = Identity.A26H.lastIndex; // remember what we've matched so far
            if (this.verified = (parsed = nowip.parse(match[1]) || {}).verified) // parse & validate the NOWIP digits
                break;
        }
        if (!parsed.verified)
            return this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'release'), Identity.dumpMs);

        var data = nowip.stringify(parsed);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null, { ARC: { data: [data] }, bs8521: parsed }), Identity.ackMs);
        debug(this.communicator.session.sid, 'Identity.timeout:', 'send_dtmf', 'ACK', Identity.ackTones, new Date);
        worker.legDtmf(this.communicator, Identity.ackTones, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Identity.ackTones], this.communicator.uuid);
    },
});

//==================================================
require('util').inherits(Establish, StateMachine);
function Establish(communicator, conclude, data26) {
    if (this instanceof Establish === false)
        throw new Error('Constructor CommunicatorBs8521Pnc:Establish requires \'new\'');

    Establish.super_.call(this, Establish, {
        communicator: communicator, // reference to parent state-machine
        conclude: conclude,         // callback to signal State complete
        conclusion: undefined,      // pending conclusion once queue is empty
        dataDtmf: Establish.dataDtmf.replace('26', data26), // candidate A26# data to send
        dataTries: Establish.dataTries, // initialised from the Class
        guardTries: Establish.guardTries, // initialised from the Class
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        sent: false,                // flag indicating whether the data has been sent
        timeout: undefined,         // timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Establish, {
    dataMs: 20000, // (160 * 28) + 700,       // delay between repeat data28 sequence
    dataTries: 4,                   // attempts to send the A26#
    dataDtmf: 'A26#@80',            // base DTMF - '26' will be replaced
    guardMs: 3000,                  // delay between repeat guard tones
    guardTone: '%(250,0,1850)',     // guard-tone to send periodically
    guardTries: 10,                 // number of guard-tones to send
    initialMs: 10000,               // delay to 1st guard tone

    enter: function () {
        debug(this.communicator.session.sid, 'Establish.enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'sendGuard'), Establish.initialMs);
        return this;
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Establish.leave:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude(conclusion);
    },
    sendGuard: function () {
        if (!this.guardTries)
            return this.enter(null, 'release');

        debug(this.communicator.session.sid, 'Establish.guard:', this.guardTries--, 'gentones', Establish.guardTone, new Date);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'sendGuard'), Establish.guardMs || 2000);
        esl.executeAsyncX('gentones', [Establish.guardTone], this.communicator.uuid);
    },
    sendData: function () {
        if (!this.dataTries)
            return this.enter(null, 'release');

        debug(this.communicator.session.sid, 'Establish.sendData:', this.dataTries--, 'send_dtmf', this.dataDtmf, new Date);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.signal.bind(this, 'sendData'), Establish.dataMs || 5180);
        this.sent = true;
        worker.legDtmf(this.communicator, this.dataDtmf, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [this.dataDtmf], this.communicator.uuid);
    },
    CUSTOM: function onCommunicatorBs8521PncCustom(evt, first) {
        debug(this.communicator.session.sid, 'Establish.CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function (evt) {
        debug(this.communicator.session.sid, 'Establish.TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function (evt, first) {
        var durationMs = evt.headers['DTMF-Duration'] / 8, dtmf;
        if (CommunicatorBs8521Pnc.testing && evt.headers['DTMF-Digit'] === '#')
            evt.headers['DTMF-Digit'] = durationMs > 500 ? 'b' : 'B';

        debug(this.communicator.session.sid, 'Establish.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs);
        if (evt.headers['DTMF-Digit'] === 'b') // DataRequest
            return this.signal('sendData') || this;
        else if (!this.sent || evt.headers['DTMF-Digit'] !== 'B') // not sent AND not Acknowledged
            return this;

        return this.enter(null, 'established') || this;
    },
});

//==================================================
require('util').inherits(Commands, StateMachine);
function Commands(communicator, conclude, dialPrefix) {
    if (this instanceof Commands === false)
        throw new Error('Constructor CommunicatorBs8521Pnc:Commands requires \'new\'');

    Commands.super_.call(this, Commands, { // instance setup
        communicator: communicator, // reference to parent state-machine
        dialPrefix: dialPrefix,     // the SLS scheme dialPrefix
        dtmfs: Object.assign([], { _: '' }), // chronology of dtmf phrases (attr:_ is current dtmf phrase)
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        conclude: conclude,         // callback to signal State complete
        queue: [],                  // queue of Ablah# messages to trot out on each successive ACK (attrib selected records unit selected)
        retries: undefined,         // retries for missed acknowledgements
        retry: undefined,           // retry timeout handle
        timeout: undefined,         // general timeout handle
    }); // this, ?initial, ?assign, ?enterArgs...
}
Object.assign(Commands, { // class setup
    ackDtmf: 'b@80',
    ackCtrl: 'ATTNN#@80',
    ackParm: 'ATT000#@80',
    ackProg: 'A0000#@80',
    retries: 4,
    retryMs: 4000,

    enter: function (cb) {
        debug(this.communicator.session.sid, 'Commands.enter:');
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), CommunicatorBs8521Pnc.nullMs || 130000);
        return this;
    },
    leave: function (conclusion) {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.communicator.session.sid, 'Commands.leave:');
        this.retry = worker.resetTimeout.call(this.communicator.session.sid, this.retry);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout);
        this.conclude('release'); // typically releases the communicator
    },
    DTMF: function (evt, first) {
        var durationMs = evt.headers['DTMF-Duration'] / 8;
        if (CommunicatorBs8521Pnc.testing && durationMs > 237)
            evt.headers['DTMF-Digit'] = CommunicatorBs8521Pnc.testing[evt.headers['DTMF-Digit']] || evt.headers['DTMF-Digit'];

        this.dtmfs._ += evt.headers['DTMF-Digit'];
        debug(this.communicator.session.sid, 'Commands.DTMF:', evt.headers['DTMF-Digit'] + '@' + durationMs, this.dtmfs._);
        var match;
        for (var cmd in Commands) {
            if (cmd[0] !== '/') // regex indicator
                continue;
            if (!Commands[cmd].re)
                Commands[cmd].re = new RegExp(cmd.slice(1));
            if (!(match = this.dtmfs._.match(Commands[cmd].re)))
                continue;
            this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), CommunicatorBs8521Pnc.nullMs || 130000);
            this.dtmfs.push(this.dtmfs._) && (this.dtmfs._ = '');
            this.signal(cmd, match);
            break;
        }
        return this;
    },
    dispatch: function (retries) {
        this.retry = worker.resetTimeout.call(this.communicator.session.sid, this.retry);
        if (!this.queue.length)
            return this.conclusion && (this.conclusion = this.conclude(this.conclusion) && undefined);

        if (retries)
            this.retries = retries;
        debug.enabled && debug(this.communicator.session.sid, 'Commands.dispatch:', this.retries, JSON.stringify(this.queue), new Date);
        if (!this.retries--)
            return;

        this.retry = worker.resetTimeout.call(this.communicator.session.sid, this.retry, this.signal.bind(this, 'dispatch', undefined), this.queue[0].indexOf('@') * 160 + Commands.retryMs);
        worker.legDtmf(this.communicator, this.queue[0], undefined); // send only
        //esl.executeAsyncX('send_dtmf', [this.queue[0]], this.communicator.uuid);

    },
    '/A0(\\d{4})#$': function (match) { // select unit
        var ackSelect = 'A' + match[1] + '00000000#@80';
        var sls4n8 = this.dialPrefix + match[1].slice(this.dialPrefix.length - 9);
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.communicator.session.sid, 'CommunicatorBs8521Pnc:Commands.select:', err);

        }, function () {
            if (!sm.communicator.bridged)
                return this();

            // must use uuid_park as dptool-park is blocked by the CF_CONTROLLED internal FS flag
            debug.enabled && debug(sm.communicator.session.sid, 'Commands.select:', JSON.stringify(match), 'uuid_park');
            esl.executeAsyncX('eval', ['${uuid_park ${uuid}}'], sm.communicator.uuid, this); // instead of bgapiX

        }, function () {
            debug.enabled && debug(sm.communicator.session.sid, 'Commands.select:', JSON.stringify(match), 'queue', ackSelect, sls4n8);
            sm.conclusion = Object.assign(sm.communicator.slsuser, { to_number: sls4n8 });
            sm.queue.push(ackSelect) && sm.signal('dispatch', Commands.retries);
            this();

        });
    },
    '/A1(\\d{4})#$': function (match) { // request catalogue
        var ackPend = 'A000000000000#@80';
        debug.enabled && debug(this.communicator.session.sid, 'Commands.pendings:', JSON.stringify(match), 'queue', ackPend);
        this.queue.push(ackPend) && this.signal('dispatch', Commands.retries);
    },
    '/A2(\\d{2})(\\d{2})#$': function (match) { // equipment control (testing: [2]21234#)
        var txt = 'unsupported', ackCtrl = Commands.ackCtrl.replace('TT', match[1]); // A2TTNN#@80
        if (match[1] !== '00') { // TT
            null;
        } else switch (match[2]) { // NN
            case '01':// Activate door release 1
                txt = 'Activate door release 1';
                this.conclusion = 'atmCommandControlRelease1';
                ackCtrl = ackCtrl.replace('NN', match[2]);
                break;

            case '02':// Activate door release 1
                txt = 'Activate door release 2';
                this.conclusion = 'atmCommandControlRelease2';
                ackCtrl = ackCtrl.replace('NN', match[2]);
                break;

            case '03':// Activate key safe lock release
                txt = 'Activate door release 1';
                this.conclusion = 'atmCommandControlReleaseKeysafe';
                ackCtrl = ackCtrl.replace('NN', match[2]);
                break;

            case '04':// Unlock all (fire/evacuation state)
                txt = 'Unlock all (fire/evacuation state)';
                this.conclusion = 'atmCommandControlReleaseAll';
                ackCtrl = ackCtrl.replace('NN', match[2]);
                break;
        }
        ackCtrl = ackCtrl.replace('NN', '00'); // catch-all NAK incase we match/replace NN above
        debug.enabled && debug(this.communicator.session.sid, 'Commands.control:', JSON.stringify(match), 'queue', ackCtrl, txt);
        this.queue.push(ackCtrl) && this.signal('dispatch', Commands.retries);
    },
    '/A3(\\d)#$': function (match) { // speech-control (testing: [2]3n#)
        var speech = 'default,quiet,normal,loud,up,down,speaker1,speaker2,duplex,simplex'.split(',');
        debug.enabled && debug(this.communicator.session.sid, 'Commands.' + speech[match[1]] + ':', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf, new Date);
        worker.legDtmf(this.communicator, Commands.ackDtmf, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.communicator.uuid);
    },
    '/A4(\\d{2})(\\d{3})(\\d{20})#$': function (match) { // parameter define  (testing: [2]41234501234568901234567890#)
        var ackParm = Commands.ackParm.replace('TT', match[1]);
        debug.enabled && debug(this.communicator.session.sid, 'Commands.define:', JSON.stringify(match), 'send_dtmf', ackParm, new Date);
        this.queue.push(ackParam) && this.signal('dispatch', Commands.retries);
    },
    '/A5(\\d{2})(\\d{3})#$': function (match) { // parameter enquiry (testing: [2]512345#)
        var ackParm = Commands.ackParm.replace('TT', match[1]);
        debug.enabled && debug(this.communicator.session.sid, 'Commands.enquiry:', JSON.stringify(match), 'send_dtmf', ackParm, new Date);
        this.queue.push(ackParam) && this.signal('dispatch', Commands.retries);
    },
    '/AC(\\d{4})#$': function (match) { // programming mode (testing: [28]1234#)
        debug.enabled && debug(this.communicator.session.sid, 'Commands.program:', JSON.stringify(match), 'send_dtmf', Commands.ackProg, new Date);
        this.queue.push(Commands.ackProg) && this.signal('dispatch', Commands.retries);
    },
    '/B$': function (match) { // ack (testing: [5]#)
        this.queue.shift();
        debug.enabled && debug(this.communicator.session.sid, 'Commands.ack:', JSON.stringify(match));
        this.signal('dispatch', undefined);
    },
    '/a7$': function (match) { // speak (testing: [*]7)
        debug.enabled && debug(this.communicator.session.sid, 'Commands.speak:', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf, new Date);
        worker.legDtmf(this.communicator, Commands.ackDtmf, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.communicator.uuid);
    },
    '/a8$': function (match) { // listen (testing: [*]8)
        debug.enabled && debug(this.communicator.session.sid, 'Commands.listen:', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf, new Date);
        worker.legDtmf(this.communicator, Commands.ackDtmf, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.communicator.uuid);
    },
    '/a9$': function (match) { // clear (testing: [*]9)
        var ackClear = 'A000000#@80';
        debug.enabled && debug(this.communicator.session.sid, 'Commands.clear:', JSON.stringify(match), 'send_dtmf', ackClear, new Date);
        this.queue.push(ackClear) && this.signal('dispatch', Commands.retries);
        if (!this.communicator.bridged)
            return this;

        // must use uuid_park as dptool-park is blocked by the CF_CONTROLLED internal FS flag
        debug.enabled && debug(this.communicator.session.sid, 'Commands.select:', JSON.stringify(match), 'uuid_park');
        esl.executeAsyncX('eval', ['${uuid_park ${uuid}}'], this.communicator.uuid); // instead of bgapiX

    },
    '/aD$': function (match) { // close (testing: [*0])
        debug.enabled && debug(this.communicator.session.sid, 'Commands.close:', JSON.stringify(match), 'send_dtmf', Commands.ackDtmf, new Date);
        worker.legDtmf(this.communicator, Commands.ackDtmf, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.communicator.uuid);
        this.timeout = worker.resetTimeout.call(this.communicator.session.sid, this.timeout, this.enter.bind(this, null), CommunicatorBs8521Pnc.closeMs);
    },
    '/a#$': function (match) { // null (testing: [*]#)
        debug.enabled && debug(this.communicator.session.sid, 'Commands.null:', JSON.stringify(match), new Date);
        worker.legDtmf(this.communicator, Commands.ackDtmf, undefined); // send only
        //esl.executeAsyncX('send_dtmf', [Commands.ackDtmf], this.communicator.uuid);
    },
});
