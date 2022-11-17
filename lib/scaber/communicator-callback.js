#! /usr/bin/env node-strict
var argsMap = require('../args-map'),
    callsites = require('callsites'),
    chain = require('scope-chain'),
    cluster = require('cluster'),
    debug = require('debug')('communicator:callback'),
    esl = require('../esl'),
    main = require.main.exports,
    nowip = require('../nowip'),
    worker = require('./worker'); // { __proto__: cluster.worker, esl, sendCb(), sent(), sessions, tags }

function Callback(o) {
    if (this instanceof Callback === false)
        throw new Error('Constructor Callback requires \'new\'');

    Object.assign(this, o);
}

require('util').inherits(module.exports = exports = CommunicatorCallback, require('../state-machine'));
function CommunicatorCallback(session, evt) {
    if (this instanceof CommunicatorCallback === false)
        throw new Error('Constructor CommunicatorCallback requires \'new\'');

    CommunicatorCallback.super_.call(this, CommunicatorCallback, {
        genid: undefined, // genesys interaction-id
        leaving: 0, // used to prevent recursive calls to state:leave method
        released: undefined, // communicator released timestamp
        session: session, // a reference to the owning session
        uuid: undefined, // channel-id of inbound call
    }, evt);
    Object.defineProperties(this, {
        session: { writable: false, enumerable: false },
    });
}

Object.assign(CommunicatorCallback, {// _this_ of all methods is the StateMachine instance
    advisee: 0,             // arc

    enter: function onCommunicatorCallbackEnter(evt) {
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorCallbackLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;

        debug(this.session.sid, 'leave:');
        this.session.signal('detached');
    },
    answer: function onCommunicatorCallbackAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
        return this;
    },
    cleanup: function onCommunicatorCallbackCleanup(err, evt) {
        debug.enabled && debug(this.session.sid, 'cleanup:', evt ? JSON.stringify(evt) : '', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'cleanup:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    clear: function onCommunicatorCallbackClear(err, evt) {
        debug.enabled && debug(this.session.sid, 'clear:', evt ? JSON.stringify(evt) : '', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;

        debug(this.session.sid, 'clear:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorCallbackChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        var originUser = evt.headers['Caller-Caller-ID-Number'];
        Object.assign(this.session.payload, { ATM: { data: [nowip.stringify({ controllerunit: originUser })]}, originUser: originUser, outbound: true });

        var sm = Object.assign(this, { uuid: evt.headers['Unique-ID'] }),
            target = evt.headers['Caller-Destination-Number'].match(/^(\+?\d+)\D(\d{4})$/);
        if (!target)
            return this.signal(clear);

        if (this.genid = evt.headers['sip_rh_x-inin-cnv'])
            this.session.advertise('bridge:genid:' + this.genid);
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, 'CommunicatorCallback:CHANNEL_CREATE', err);
            sm.session.signal('consume', new Callback({
                to_number: target[1],
                to_unit: target[2],
            }));

        }, function () {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'record_session', main.hack.record || false);
            if (!main.hack.record)
                return this();

            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'block_dtmf');
            worker.legDtmf(sm, '', true, this); // just block
            //esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'pre_answer');
            esl.executeAsyncX('pre_answer', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorCallbackChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        if (evt.type !== 'CHANNEL_ANSWER')
            return this;

        var dueMs = +this.session.keepalived - Date.now() + 60000;
        this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), dueMs);
        return this.session.advisees[exports.advisee] = this;
    },
    CHANNEL_DESTROY: function onCommunicatorCallbackChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        this.session.advisees[exports.advisee] = undefined;
        this.released = new Date;
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorCallbackCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorCallbackTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorCallbackDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    transaction: function (type, subtype /* , ..., cb */) {
        debug(this.session.sid, 'transaction:', argsMap(arguments));
        var cb = arguments[arguments.length - 1];
        if (type !== 'consumer') // legacy necessary
            return cb(null, '-UNIMPLEMENTED') || this;

        var dueMs = +this.session.keepalived - Date.now() + 60000;
        debug(this.session.sid, 'transaction:', JSON.stringify({ keepalived: this.session.keepalived, dueMs: dueMs }));
        switch (subtype) {
            case 'dequeue':
                this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout);
                cb(null, '+SUCCESS', dueMs);
                break;
            case 'enqueue':
                if (!isNaN(dueMs)) // will be NaN if no successful transaction so far
                    this.timeout = worker.resetTimeout.call(this.session.sid, this.timeout, this.signal.bind(this, 'timeout'), dueMs);
                cb(null, '+SUCCESS', dueMs);
                break;
            default:
                return cb(null, '-UNIMPLEMENTED') || this;
        }
        return this;
    },
});
