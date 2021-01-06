#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:detect');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = CommunicatorDetect;

require('util').inherits(CommunicatorDetect, require('../state-machine'));
function CommunicatorDetect(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorDetect === false)
        throw new Error('Constructor CommunicatorDetect requires \'new\'');
    CommunicatorDetect.super_.call(this, CommunicatorDetect, {
        answered: false, // communicator answered state
        grouped: undefined, // grouped/dispersed - set from sub-protocol parse output
        hvs: undefined, // handsfree-voice-switched - set from sub-protocol parse output
        interval: undefined,
        leaving: 0, // used to prevent recursive calls to state:leave method
        phases: [], // last-to-first stack of attempted protocol states
        protocols: CommunicatorDetect.Protocols.slice(), // list of protocol Constructors to try - shift'd on failure
        session: session, // a reference to the owning session
        simplex: undefined, // tri-state [undefined=unknown, false=duplex, true=simplex] - updated by sub-protocols on speech-command success/failure
        stmf: false, // whether we're using STMF - updated & used by sub-protocols
        timeout: undefined,
        uuid: undefined, // channel-id of inbound call
    }, evt); // this, ?initial, ?assign, ?enterArgs...
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
        if (this.uuid) {
            debug(this.session.sid, 'leave:', 'hangup', this.uuid);
            esl.executeAsyncX('hangup', [], this.uuid);
        }
        for (var n in this.phases)
            this.phases[n].enter(null);
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
        this.phases.length && this.phases[0].enter(null);
        this.phases.unshift(new this.protocols[0].Close(this));
        return this;
    },
    clear: function onCommunicatorClear() {
        debug(this.session.sid, 'clear:');
        this.signal('close');
    },
    answer: function onCommunicatorDetectAnswer(cb) { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:');
        cb || (cb = function (err) { err && console.log(this.session.sid, 'onCommunicatorDetectAnswer:', err) });
        this.answered ? cb() : esl.executeAsyncX('answer', [], this.uuid, cb);
        return this;
    },
    establish: function onCommunicatorDetectEstablish(success) {
        if (this.leaving)
            return;

        debug(this.session.sid, 'establish:', success);
        switch (success) {
            case true:// establish-success
                this.signal('phase', 'establish');
                return this;

            case false: // establish-failed
                this.phases.length && this.phases[0].enter(null); // wrap-up any existing phases
                this.protocols.shift(); // discard the failed protocol
                while (this.protocols.length && !this.protocols[0].Establish) // hunt for an Establish phase
                    this.protocols.shift();
                if (!this.protocols.length) // no available establish phases
                    return this.signal('release');

                this.phases.unshift(new this.protocols[0].Establish(this));
                return this;

            default: // initial timeout
                while (this.protocols.length && !this.protocols[0].Establish) // hunt for an Establish phase
                    this.protocols.shift();
                if (!this.protocols.length) // no available establish phases
                    return this.signal('release');

                this.phases.unshift(new this.protocols[0].Establish(this));
                return this;
        }
    },
    phase: function onCommunicatorDetectPhase(completed) {
        debug(this.session.sid, 'phase:', completed);
        if (this.protocols[0].keepaliveMs)
            this.interval = worker.resetInterval(this.interval, this.signal.bind(this, 'phase', 'interval'), this.protocols[0].keepaliveMs);
        switch (completed) {
            case 'establish':
                if (this.hvs && this.protocols[0].Speech)
                    return this.phases.unshift(new this.protocols[0].Speech(this, true));
                // fallthru
            case 'speech':
                return this.session.signal('consume');
            case 'interval':
                if (this.protocols[0].Keepalive)
                    this.phases.unshift(new this.protocols[0].Keepalive(this, 0));
                return this;
        }
    },
    CHANNEL_CREATE: function onCommunicatorDetectChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];
        var match = CommunicatorDetect.DS.exec(evt.headers['variable_sip_req_params']);
        this.dataset = match ? match[1] : '';
        this.uuid = evt.headers['Unique-ID'];
        return this.signal('establish', undefined); // begin-establishing
    },
    CHANNEL_: function onCommunicatorDetectChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        if (evt.type === 'CHANNEL_ANSWER')
            this.answered = true;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorDetectChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        return this.enter(null), this;
    },
    CUSTOM: function onCommunicatorDetectCustom(evt, first) { // received custom event
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        this.phases[0] && this.phases[0].signal('CUSTOM', evt);
        return this;
    },
    DETECTED_TONE: function onCommunicatorDetectTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        this.phases[0] && this.phases[0].signal(evt.type, evt);
        return this;
    },
    DTMF: function onCommunicatorDetectDtmf(evt, first) { // received dtmf
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        this.phases[0] && this.phases[0].signal(evt.type, evt);
        return this;
    },
});
