#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:nowip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = CommunicatorNowip;

process.on('sipMessagePreProcess', function onSipMessageProProcessNowip(evt) {
    var err, mandatory = new Set(['version', 'type', 'data', 'time', 'mac']); // each of these attributes must have content
    evt.parsed || xml2js.parseString(evt.body, function (err, js) {
        evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
    });
    (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
    if (err || !evt.parsed || !evt.parsed.ATM)
        return err && console.log('onSipMessageProProcessNowip:', err);

    mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.ATM || {});
    mandatory.size && (err = Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
    if (err)
        return console.log('onSipMessageProProcessNowip:', err);
});

require('util').inherits(CommunicatorNowip, require('../state-machine'));
function CommunicatorNowip(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorNowip === false)
        throw new Error('Constructor CommunicatorNowip requires \'new\'');

    CommunicatorNowip.super_.call(this, CommunicatorNowip, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        msgEvt: undefined, // latest received MESSAGE
        session: session, // a reference to the owning session
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorNowip, {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorNowipEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorNowipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.session.signal('detached');
    },
    answer: function onCommunicatorNowipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', (this.session.firstEvt || {}).type, callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
        return this;
    },
    clear: function onCommunicatorNowipClear(err, evt) {
        debug.enabled && debug(this.session.sid, 'clear:', evt ? JSON.stringify(evt) : '', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'clear:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorNowipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        Object.assign(this.session.payload, { originUser: evt.headers['Caller-Caller-ID-Number'] });

        var sm = Object.assign(this, { uuid: evt.headers['Unique-ID'] });
        chain(null, function () {
            debug(sm.session.sid, 'send:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.uuid, this);

        }, function (evt) {
            esl.executeAsyncX('set', ['park_after_bridge=true'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'record_session');
            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'ring_ready');
            esl.executeAsyncX('ring_ready', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorNowipChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorNowipChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorNowipCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorNowipTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorNowipDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorNowipMessage(evt, first) { // received NOWIP message
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], evt.body);
        var err, mandatory = new Set(['version', 'type', 'data', 'time', 'mac']), atm;
        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
        if (!err) {
            mandatory.forEach(function (key, idx, arr) { key in this && arr.delete(key) }, evt.parsed.ATM || {});
            mandatory.size && (err = Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
        }
        if (evt.parsed && evt.parsed.ATM.type[0] === '1') // only ACK an Alarm message
            esl.atm(this.msgEvt = evt, atm = { type: err ? '5' : 'A' });
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], atm && atm.xml);
        if (err)
            return console.log(this.session.sid, 'onCommunicatorNowipMessage:', err) || this.signal('clear') || this;

        if (!atm) // a NOWIP-ACK - stop here
            return this;

        Object.assign(this.session.payload, evt.parsed); // copies ATM
        this.session.signal('consume', undefined);
        return this;
    },
    controlRelease1: function onCommunicatorNowipControlRelease1() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlRelease1:', atm.xml);
        return this;
    },
    controlRelease2: function onCommunicatorNowipControlRelease2() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlRelease2:', atm.xml);
        return this;
    },
    atmCommandControlReleaseKeysafe: function onCommunicatorNowipControlReleaseKeysafe() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlReleaseKeysafe:', atm.xml);
        return this;
    },
    atmCommandControlReleaseAll: function onCommunicatorNowipControlReleaseAll() {
        var atm;
        esl.atm(this.msgEvt, atm = { type: '2', data: '20001' }); // map to Release1
        debug(this.session.sid, 'controlReleaseAll:', atm.xml);
        return this;
    },
});
