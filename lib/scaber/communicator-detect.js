#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    cluster = require('cluster'),
    debug = require('debug')('communicator:detect'),
    esl = require('../esl'),
    main = require.main.exports,
    StateMachine = require('../state-machine'),
    worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

require('util').inherits(module.exports = exports = CommunicatorDetect, StateMachine);
function CommunicatorDetect(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorDetect === false)
        throw new Error('Constructor CommunicatorDetect requires \'new\'');

    CommunicatorDetect.super_.call(this, CommunicatorDetect, {
        answered: undefined,        // communicator answered state
        createEvt: evt,             // used by some protocols, e.g. bridge
        dataset: undefined,         // placeholder for INVITE request parameter 'ds=' set by CHANNEL_CREATE
        direction: undefined,       // tristate to track prevailing state (undefined, 'speak', 'listen')
        grouped: undefined,         // placeholder for grouped/dispersed object - set/updated by sub-protocol-establish
        hvs: undefined,             // handsfree-voice-switched - set by sub-protocol-establish
        interval: undefined,        // interval handle
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        protocols: exports.Protocols.slice(), // list of protocol Constructors to try - shift'd on failure
        released: false,            // communicator released state
        session: session,           // a reference to the owning session
        speech: undefined,          // tristate to track prevailing state (undefined, 'simplex', 'duplex')
        stmf: false,                // whether we're using STMF - updated & used by sub-protocols
        substates: Object.assign([], { _: undefined }), // chronology of past substates (attr:_ is current substate)
        //tasks: new main.modules.Tasks,  // list of grouped-alarms
        timeout: undefined,         // timeout handle
        uuid: undefined,            // channel-id of inbound call
    }, evt); // this, ?initial, ?assign, ?enterArgs...
    Object.defineProperties(this, {
        protocols: { writable: false },
        session: { writable: false, enumerable: false },
        substates: { writable: false },
        //tasks: { writable: false, enumerable: false },
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
    //delayMs: 3700,              // delay to 1st protocol - to accomodate junk tones - e.g. %(200,2500,1850)
    //dtmfMaxMs: 2500,            // max valid DTMF duration
    selectedMs: 1500,        // delay following selected

    enter: function onCommunicatorDetectEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorDetectLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        if (this.substates._) // active substate need archiving
            this.substates.push(this.substates._) && (this.substates._ = null);
        for (var i = 0; i < this.substates.length; i++) // ensure all substates are exited
            this.substates[i].enter(null, true);
        if (this.uuid && !this.released) {
            debug(this.session.sid, 'leave:', 'hangup', this.uuid);
            esl.executeAsyncX('hangup', [], this.uuid);
        }
        this.session.signal('detached');
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
        this.interval = worker.resetInterval.call(this.session.sid, this.interval);
    },
    release: function onCommunicatorDetectRelease() { // forced release timeout - from close/closed/establish
        debug(this.session.sid, 'release:');
        if (!this.uuid)
            return this.enter(null) || this;

        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    close: function onCommunicatorClose() { // from clear/cleared/catalogued
        debug(this.session.sid, 'close:');
        this.interval = worker.resetInterval.call(this.session.sid, this.interval);

        var args = this.protocols[0].transaction && Object.assign(args = ['quick', [, 'd'], 'close', Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'closed' });
        if (args && args.Transaction)
            this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
        else
            this.signal('release');
        return this;
    },
    closed: function onCommunicatorClosed(data) { // from close
        debug(this.session.sid, 'closed:');
        return this.signal('release');
    },
    clear: function onCommunicatorDetectClear() { // from session.detach
        debug(this.session.sid, 'clear:');
        if (!this.grouped || !this.protocols[0].transaction)
            return this.signal('close');

        var args = Object.assign(args = ['quick', [, '9'], 'clear', Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'cleared' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    cleared: function onCommunicatorDetectCleared(data) { // from clear
        debug(this.session.sid, 'cleared: pending', this.grouped.pending, data);
        if (!this.grouped.pending)
            return this.signal('close');

        var args = {};
        if (this.grouped.unit) // the clear substate identified the next unit to select
            args = Object.assign(args = ['select', [, this.grouped.unit.toString()], this.grouped.unit, Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'selected' });
        else
            args = Object.assign(args = ['catalogue', [, '0'], 0, Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'catalogued' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    answer: function onCommunicatorDetectAnswer(cb) { // request to answer a-leg if not already answered - from protocol Guard.action
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        cb || (cb = function (err) { err && console.log(this.session.sid, 'onCommunicatorDetectAnswer:', err) });
        this.answered ? cb() : esl.executeAsyncX('answer', [], this.uuid, cb);
        return this;
    },
    establish: function onCommunicatorDetectEstablish(conclusion) { // from establish/CHANNEL_CREATE
        if (this.leaving)
            return;

        debug(this.session.sid, 'establish:', conclusion);
        switch (conclusion) { // undefined/true/false OR undefined/verified/refused/answer/release
            case 'release': // explicit release from any-of Bs8521/Tt92/TtNew
                this.signal('release');
                break;

            case 'verified': // establish-success - from a protocol-Establish
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
    established: function onCommunicatorDetectEstablished() { // from establish
        debug.enabled && debug(this.session.sid, 'established:', JSON.stringify({ grouped: this.grouped, hvs: this.hvs}));
        if (this.protocols[0].Generic && this.protocols[0].hack)
            return this.signal('hack');

        var args = {};
        if (!this.grouped || !this.protocols[0].transaction)
            null;
        else if (this.grouped.unit) // grouped and have an first unit - select the first unit
            args = Object.assign(args = ['select', [, this.grouped.unit.toString()], this.grouped.unit, Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'selected' });
        else // first unit is unknown - so query
            args = Object.assign(args = ['catalogue', [, '0'], 0, Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'catalogued' });

        args.Transaction ? this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args)) : this.session.signal('consume', undefined);
        return this;
    },
    catalogued: function onCommunicatorDetectCatalogued() { // from cleared/established
        var unit = this.grouped.unit;
        debug(this.session.sid, 'catalogued: unit', unit);
        if (!this.grouped.unit)
            return this.signal('close');

        var args = Object.assign(args = ['select', [, unit.toString()], unit, Object], { Transaction: this.protocols[0].transaction.apply(this, args), signal: 'selected' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    selected: function onCommunicatorDetectSelected() { // from established/catalogued
        debug(this.session.sid, 'selected: unit', this.grouped.unit);
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.session.signal.bind(this.session, 'consume', undefined), exports.selectedMs);
    },
    speeched: function onCommunicatorDetectSpeeched() { // from established
        debug(this.session.sid, 'speeched:');
        this.session.signal('consume', undefined);
        return this;
    },
    hack: function onCommunicatorDetectHack(arg) {
        if (isNaN(this.nxt)) {
            isNaN(exports.max) && (exports.max = 1657);
            this.nxt = exports.max;
            exports.max += 60;
            debug.enabled && debug(this.session.sid, 'hack: init', JSON.stringify({ nxt: this.nxt, max: exports.max, arg: arg }));
        } else if (arg === 'B') { // received an ACK
            if (this.nxt < 0) // succeeded on 2nd attempt
                this.nxt = -this.nxt;
            exports.max = this.nxt - 1; // this is what worked
            debug.enabled && debug(this.session.sid, 'hack: ackn', JSON.stringify({ nxt: this.nxt, max: exports.max, arg: arg }), '**** SUCCESS ****', exports.max);
            return this.session.signal('consume', undefined);
        } else if (arg) { // received a NAK
            if (this.nxt < 0) // failed on 2nd attempt
                this.nxt = -this.nxt;
            debug.enabled && debug(this.session.sid, 'hack: nack', JSON.stringify({ nxt: this.nxt, max: exports.max, arg: arg }));
        } else { // received nothing
            if (this.nxt < 0) { // was 2nd attempt
                this.nxt = -this.nxt;
                exports.max = this.nxt - 1;
                debug.enabled && debug(this.session.sid, 'hack: abrt', JSON.stringify({ nxt: this.nxt, max: exports.max, arg: arg }), '**** ABORTED ****');
                return this.session.signal('consume', undefined);
            }
            // otherwise retry
            this.nxt = -this.nxt;
            debug.enabled && debug(this.session.sid, 'hack: rtry', JSON.stringify({ nxt: this.nxt, max: exports.max, arg: arg }));
        }
        if (this.nxt >= Math.min(exports.max, 10000)) {
            debug.enabled && debug(this.session.sid, 'hack: done', JSON.stringify({ nxt: this.nxt, max: exports.max, arg: arg }), '**** FINISHED ****');
            return this.session.signal('consume', undefined);
        }

        var pin = ('000' + (this.nxt < 0 ? -this.nxt - 1 : this.nxt++)).slice(-4);
        this.signal('substate', this.protocols[0].Generic, 'hack', ['program', { send: 'ac' + pin + '#@80' }, pin, Object]);
    },
    substate: function onCommunicatorDetectSubstate(Substate, signal, arg) { // helper to activate a new Substate
        var sm = Substate && Substate.super_;
        if (Substate) { // ensure Substate is derived from StateMachine
            while (sm && sm != StateMachine)
                sm = sm.super_;
            if (!sm) // does not inherit from StateMachine
                throw new Error('Substate must be an instance of StateMachine');
        }

        debug(this.session.sid, 'substate:', Substate && Substate.name, new Date);
        if (sm = this.substates._) // existing substate assignment test
            this.substates.push(this.substates._) && sm.enter(this.substates._ = null, true); // push first to filter the callback
        this.substates._ = Substate && new Substate(this, signal && function conclude(index) {
            if (index === this.substates.length) // is still the active substate
                this.signal.apply(this, [signal].concat(Array.from(arguments).slice(1)));
        }.bind(this, this.substates.length), arg); // index is a snapshot the current substate index for callback filtering
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorDetectChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID'], new Date);
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];
        var match = exports.DS.exec(evt.headers['variable_sip_req_params']);
        this.dataset = match ? match[1] : '';
        this.uuid = evt.headers['Unique-ID'];
        return this.signal('establish', 'start'); // start-establishing
    },
    CHANNEL_: function onCommunicatorDetectChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID'], new Date);
        if (evt.type === 'CHANNEL_ANSWER')
            this.answered = new Date;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorDetectChannelDestroy(evt, first) { // a-leg has ended
        this.released = true;
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], new Date);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorDetectCustom(evt, first) { // received custom event
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorDetectTone(evt, first) { // received tone
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorDetectDtmf(evt, first) { // received dtmf
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    transaction: function onCommunicatorDetectTransaction(type, match, /* ..., cb */) { // consumer-to-communicator transaction
        if (type === 'acknowledge' && this.substates._ && this.substates._.signal.apply(this.substates._, arguments))
            return this;

        var transaction = (this.protocols[0] || {}).transaction, // does the Protocol implement transactions
            Transaction = transaction && transaction.apply(this, arguments); // (type, match, ..., cb)
        debug.enabled && debug(this.session.sid, 'transaction:', JSON.stringify(argsMap(arguments)), !transaction ? 'UNSUPPORTED by protocol' : !Transaction ? 'UNIMPLEMENTED for protocol' : Transaction.name);
        if (!Transaction) // no Transaction StateMachine available
            return arguments[arguments.length - 1]() || this;

        return this.signal('substate', Transaction, undefined, Array.from(arguments)); // [type, match, ..., cb]
    },
});
