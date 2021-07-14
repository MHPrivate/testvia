#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:detect');
var esl = require('../esl');
var main = require.main.exports;
var StateMachine = require('../state-machine');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = CommunicatorDetect;

require('util').inherits(CommunicatorDetect, StateMachine);
function CommunicatorDetect(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorDetect === false)
        throw new Error('Constructor CommunicatorDetect requires \'new\'');

    CommunicatorDetect.super_.call(this, CommunicatorDetect, {
        answered: undefined,        // communicator answered state
        createEvt: evt,             // used by some protocols, e.g. bridge
        grouped: undefined,         // grouped/dispersed - set from sub-protocol parse output
        hvs: undefined,             // handsfree-voice-switched - set from sub-protocol parse output
        interval: undefined,        // interval handle
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        protocols: CommunicatorDetect.Protocols.slice(), // list of protocol Constructors to try - shift'd on failure
        released: false,            // communicator released state
        session: session,           // a reference to the owning session
        simplex: undefined,         // tri-state [undefined=unknown, false=duplex, true=simplex] - updated by sub-protocols on speech-command success/failure
        stmf: false,                // whether we're using STMF - updated & used by sub-protocols
        substates: Object.assign([], { _: undefined }), // chronology of past substates (attr:_ is current substate)
        tasks: new main.modules.Tasks,  // list of grouped-alarms
        timeout: undefined,         // timeout handle
        uuid: undefined,            // channel-id of inbound call
    }, evt); // this, ?initial, ?assign, ?enterArgs...
    Object.defineProperties(this, {
        protocols: { writable: false },
        session: { writable: false, enumerable: false },
        substates: { writable: false },
        tasks: { writable: false, enumerable: false },
    });
}

Object.assign(CommunicatorDetect, { // _this_ of all methods is the StateMachine instance
    DS: /\bds=(\d+)\b/,         // regexp to retrieve the dataset from the REQUEST-URI
    Protocols: [
        require('./communicator-detect/Bridge'),
        require('./communicator-detect/Guard'),
        require('./communicator-detect/Bs8521'),
        require('./communicator-detect/Tt92'),
        require('./communicator-detect/TtNew'),
        //require('./communicator-detect/TtOld'),
        require('./communicator-detect/Unknown'),
    ].reduce(function (wksp, protocol, idx, arr) { wksp[protocol.constructor.name] = wksp[idx] = protocol; return wksp }, []),
    delayMs: 3700,              // delay to 1st protocol - to accomodate junk tones - e.g. %(200,2500,1850)
    dtmfMaxMs: 2500,            // max valid DTMF duration

    enter: function onCommunicatorDetectEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorDetectLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.interval = worker.resetInterval(this.interval);
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
    release: function onCommunicatorDetectRelease() { // forced release timeout
        debug(this.session.sid, 'release:');
        if (!this.uuid)
            return this.enter(null) || this;

        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    close: function onCommunicatorClose() {
        debug(this.session.sid, 'close:');
        if (!this.protocols.length || !this.protocols[0].Close)
            return this.signal('release');

        this.interval = worker.resetInterval(this.interval);
        this.signal('substate', this.protocols[0].Close, 'release', undefined); // abandon substate processing
        return this;
    },
    clear: function onCommunicatorClear() {
        debug(this.session.sid, 'clear:');
        this.signal('close');
    },
    answer: function onCommunicatorDetectAnswer(cb) { // request to answer a-leg if not already answered - usually from Guard.action
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        cb || (cb = function (err) { err && console.log(this.session.sid, 'onCommunicatorDetectAnswer:', err) });
        this.answered ? cb() : esl.executeAsyncX('answer', [], this.uuid, cb);
        return this;
    },
    establish: function onCommunicatorDetectEstablish(conclusion) {
        if (this.leaving)
            return;

        debug(this.session.sid, 'establish:', conclusion);
        switch (conclusion) { // undefined/true/false OR undefined/verified/refused/answer/release
            case 'release': // explicit release from any-of Bs8521/Tt92/TtNew
                this.signal('release');
                break;

            case 'verified': // establish-success - from a protocol-Establish
                this.signal('keepalive'); // start keepalive
                this.signal('established', undefined);
                break;

            case 'refused': // establish-failed - move-on to next protocol
                this.protocols.shift();
                // fallthru
            case 'start': // should be from CHANNEL_CREATE
                while (this.protocols.length && !this.protocols[0].Establish) // hunt for an Establish protocol
                    this.protocols.shift();
                if (!this.protocols.length) // no available establish protocols
                    return this.signal('release');

                this.signal('substate', this.protocols[0].Establish, 'establish', undefined); // next protocol - callback to this 'establish' handler
                break;

            default:
                throw new Error('unknown establish conclusion: ' + conclusion);
                break;
        }
        return this;
    },
    keepalive: function () { // setup OR reset keepalive interval
        debug(this.session.sid, 'keepalive:', this.interval ? 'reset' : 'setup');
        if (this.protocols[0].keepaliveMs && this.protocols[0].Keepalive)
            this.interval = worker.resetInterval(this.interval, this.signal.bind(this, 'substate', this.protocols[0].Keepalive, undefined, true), this.protocols[0].keepaliveMs);
        return this;
    },
    established: function () { // communicator-established
        debug(this.session.sid, 'established:');
        if (this.hvs && this.protocols[0].Speech)
            return this.signal('substate', this.protocols[0].Speech, 'speeched', true);

        this.session.signal('consume', undefined);
        return this;
    },
    speeched: function () { // communicator-speeched
        debug(this.session.sid, 'speeched:');
        this.session.signal('consume', undefined);
        return this;
    },
    substate: function onConsumerBs8521PncSubstate(Substate, signal, arg) { // helper to activate a new Substate
        var sm = Substate && Substate.super_;
        if (Substate) { // ensure Substate is derived from StateMachine
            while (sm && sm != StateMachine)
                sm = sm.super_;
            if (!sm) // does not inherit from StateMachine
                throw new Error('Substate must be an instance of StateMachine');
        }

        debug(this.session.sid, 'substate:', Substate && Substate.name);
        if (sm = this.substates._) // existing substate assignment test
            this.substates.push(this.substates._) && sm.enter(this.substates._ = null); // push first to filter the callback
        var index = this.substates.length; // snapshot the current substate index for callback filtering
        this.substates._ = Substate && new Substate(this, function conclude() {
            if (index === this.substates.length) // is still the active substate
                signal && this.signal.apply(this, [signal].concat(Array.from(arguments)));
        }.bind(this), arg);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorDetectChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];
        var match = CommunicatorDetect.DS.exec(evt.headers['variable_sip_req_params']);
        this.dataset = match ? match[1] : '';
        this.uuid = evt.headers['Unique-ID'];
        return this.signal('establish', 'start'); // start-establishing
    },
    CHANNEL_: function onCommunicatorDetectChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        if (evt.type === 'CHANNEL_ANSWER')
            this.answered = new Date;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorDetectChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        this.released = true;
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorDetectCustom(evt, first) { // received custom event
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;
        return this;
    },
    DETECTED_TONE: function onCommunicatorDetectTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;
        return this;
    },
    DTMF: function onCommunicatorDetectDtmf(evt, first) { // received dtmf
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;
        return this;
    },
    arcProgram: function onArcProgram(match, cb) {
        debug(this.session.sid, 'arcProgram:', match);
        cb(null, true);
    },
});
