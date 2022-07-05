#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    debug = require('debug')('consumer:callback'),
    esl = require('../esl'),
    main = require.main.exports,
    os = require('os'),
    StateMachine = require('../state-machine'),
    worker = require('./worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags };

require('util').inherits(module.exports = exports = ConsumerCallback, StateMachine);
function ConsumerCallback(session) {
    if (this instanceof ConsumerCallback === false)
        throw new Error('Constructor ConsumerCallback requires \'new\'');

    ConsumerCallback.super_.call(this, ConsumerCallback, {
        //answered: undefined,        // consumer answered state
        callback: undefined,        // { to_number, to_unit }
        data: '',                   // tone/dtmf accumulator
        //direction: undefined,       // tristate to track prevailing state (undefined, 'speak', 'listen')
        grouped: undefined,         // placeholder for grouped/dispersed object - set/updated by sub-protocol-establish
        hvs: undefined,             // handsfree-voice-switched - set by sub-protocol-establish
        //interval: undefined,        // interval handle
        leaving: 0,                 // used to prevent recursive calls to state:leave method
        protocol: undefined,        // protocol Constructor
        released: false,            // consumer released state
        selected: null,             // track which unit is selected - updated by sub-protocol-action
        session: session,           // a reference to the owning session
        //speech: undefined,          // tristate to track prevailing state (undefined, 'simplex', 'duplex')
        spandsp: false,             // keep track whether spandsp is running
        stmf: false,                // whether we're using STMF - updated & used by sub-protocols
        substates: Object.assign([], { _: undefined }), // chronology of past substates (attr:_ is current substate)
        timeout: undefined,         // timeout handle
        uuid: undefined,
        uuids: {},                  // { uuid: boolean } collection of active outbound channel-ids
    }); // this, ?initial, ?assign, ?enterArgs...
    Object.defineProperties(this, {
        session: { writable: false, enumerable: false },
        substates: { writable: false },
    });
}

Object.assign(ConsumerCallback, { // _this_ of all methods is the StateMachine instance
    abortMs: 5000,  // abort-phase timeout
    dtmfMs: 230,    // dtmf silence timeout
    toneMs: 2500,   // tone silence timeout
    rtpMs: 20,

    enter: function onConsumerCallbackEnter() {
        debug(this.session.sid, 'enter:');
        return this;
    },
    leave: function onConsumerCallbackLeave() {
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
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
            this.uuids[this.uuid] = false;
        }
        for (var uuid in this.uuids) {
            if (!this.uuids[uuid])
                continue;
            debug(this.session.sid, 'leave:', 'hangup', uuid);
            esl.executeAsyncX('hangup', [], uuid);
        }
    },
    activate: function onConsumerCallbackActivate(callback) { // { to_number, to_unit }
        debug.enabled && debug(this.session.sid, 'activate:', JSON.stringify(callback), callsites()[2].toString());
        this.callback = callback;

        var sm = this;
        chain(function (err) {
            err && console.log('onConsumerCallbackActivate:', err);

        }, function () {
            debug(sm.session.sid, 'activate:', 'bridge', sm.callback, new Date);
            sm.session.payload.paid = sm.session.context.paid && ('sip:' + sm.session.context.paid + '@' + os.hostname());
            var bridge = esl.nvp({
                appello_consumer: !undefined, // true as we are a consumer leg
                appello_unique: sm.session.sid,
                //drop_dtmf: true,
                originate_timeout: 15,
                park_after_bridge: true,
                rtp_digit_delay: ConsumerCallback.rtpMs || 20,
                sip_cid_type: 'rpid',
                'sip_h_P-Asserted-Identity': sm.session.payload.paid,
                //sip_invite_call_id: sm.session.evoId,
            }, '{}' + 'sofia/gateway/magrathea/' + callback.to_number);
            debug(sm.session.sid, 'activate:', 'bridge', bridge);
            esl.executeAsyncX('bridge', [bridge], sm.session.communicator.uuid, this);

        });

        return this;
    },
    stabilised: function onConsumerCallbackStabilised() {
        var unit = +this.callback.to_unit;
        debug.enabled && debug(this.session.sid, 'stabilised: unit', unit, callsites()[2].toString());
        var args = Object.assign(args = ['select', [, unit.toString()], unit, Object], { Transaction: this.protocol.transaction.apply(this, args), signal: 'selected' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    selected: function onCommunicatorDetectSelected() { // from established/catalogued
        debug(this.session.sid, 'selected:', this.grouped.unit);
    },
    substate: function onConsumerCallbackSubstate(Substate, signal, arg) { // helper to activate a new Substate
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
        this.substates._ = new Substate(this, signal && function conclude(index) {
            if (index === this.substates.length) // is still the active substate
                this.signal.apply(this, [signal].concat(Array.from(arguments).slice(1)));
        }.bind(this, this.substates.length), arg); // index is a snapshot the current substate index for callback filtering
        return this;
    },
    orphaned: function onConsumerCallbackOrphaned() { // communicator has detached
        var orphaned = { selected: this.selected || '-', protocol: this.session.payload.protocol || '-', leg: this.uuid || '-' };
        debug(this.session.sid, 'orphaned:');
        //return this.enter(null); // returns undefined unless consumer should be retained
        if (!this.uuid)
            return undefined; // permit session cleanup

        this.signal(this.selected ? 'clear' : this.session.payload.protocol ? 'close' : 'release');
        return this.uuid; // continue session as we have a consumer-leg to cleanup
    },
    clear: function onConsumerCallbackClear() {
        debug(this.session.sid, 'clear:');
        var args = this.protocol.transaction && Object.assign(args = ['quick', {}, 'clear', Object], { Transaction: this.protocol.transaction.apply(this, args), signal: 'close' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    close: function onConsumerCallbackClose() {
        debug(this.session.sid, 'close:');
        var args = this.protocol.transaction && Object.assign(args = ['quick', {}, 'close', Object], { Transaction: this.protocol.transaction.apply(this, args), signal: 'release' });
        args.Transaction && this.signal.call(this, 'substate', args.Transaction, args.signal, Array.from(args));
    },
    release: function onConsumerCallbackRelease() {
        debug(this.session.sid, 'release:');
        esl.executeAsyncX('hangup', [], this.uuid);
    },
    CHANNEL_CREATE: function onConsumerCallbackChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.uuids[this.uuid = evt.headers['Unique-ID']] = true;
        return this;
    },
    CHANNEL_: function onConsumerCallbackChannel(evt, first) { // miscellaneous CHANNEL_*** events
        switch (evt.type) {
            case 'CHANNEL_PROGRESS_MEDIA':
                debug(this.session.sid, evt.type + ':', 'spandsp_start_tone_detect:grouped', new Date);
                this.spandsp = esl.executeAsyncX('spandsp_start_tone_detect', ['telecare-grouped'], this.uuid) || true;
                break;

            case 'CHANNEL_ANSWER':
                debug(this.session.sid, evt.type + ':');
                this.session.signal('answer');
                break;

            case 'CHANNEL_BRIDGE':
                debug(this.session.sid, evt.type + ':');
                this.bridged = true;
                //esl.executeAsyncX('set', ['park_after_bridge=true'], this.uuid);
                break;

            default:
                debug(this.session.sid, evt.type + ':');
                break;
        }
        return this;
    },
    CHANNEL_DESTROY: function onConsumerCallbackChannelDestroy(evt, first) { // b-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID'], 'bridged =', this.bridged);
        this.uuid = (this.uuids[evt.headers['Unique-ID']] = false) || undefined;
        this.session.signal('consume', true);
        return this;
    },
    CUSTOM: function onConsumerCallbackCustom(evt, first) {
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onConsumerCallbackTone(evt, first) {
        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone'] + (this.protocol ? ' ignored' : ''), ConsumerCallback.toneMs + 'ms');
        if (this.protocol)
            return this;

        if (!evt.headers['Detected-Tone'].startsWith('telecare-grouped:'))
            return this;

        this.data += 'T' + evt.headers['Detected-Tone'].slice('telecare-grouped:'.length);
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ConsumerCallback.toneMs);
        return this;
    },
    DTMF: function onConsumerCallbackDtmf(evt, first) {
        if (this.spandsp) {
            debug(this.session.sid, 'DTMF:', 'spandsp_stop_tone_detect', new Date);
            this.spandsp = esl.executeAsyncX('spandsp_stop_tone_detect', [], this.uuid) && false;
        }

        if (this.substates._ && this.substates._.signal(evt.type, evt, first))
            return this;

        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8) + (this.protocol ? ' ignored' : ''), ConsumerCallback.dtmfMs + 'ms');
        if (this.protocol)
            return this;

        this.data += evt.headers['DTMF-Duration'] < 4000 ? evt.headers['DTMF-Digit'] : evt.headers['DTMF-Digit'].toLowerCase();
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), ConsumerCallback.dtmfMs);
        return this;
    },
    timeout: function onConsumerCallbackTimeout() {
        switch (this.data) {
            case 'b': // Bs8521
                this.protocol = require('./protocol/Bs8521');
                break;

            case '0#': // Tt92
                this.protocol = require('./protocol/Tt92');
                break;

            case 'DB': // TtNew
                this.protocol = require('./protocol/TtNew');
                break;

            case 'T1850': // TtOld
            case 'T1850T1400':
                this.protocol = require('./protocol/TtOld');
                break;
        }
        debug(this.session.sid, 'timeout:', this.data, this.protocol && this.protocol.constructor.name);
        (this.protocol || {}).Stabilise && this.signal('substate', this.protocol.Stabilise, 'stabilised', undefined);
        return this;
    },
});
