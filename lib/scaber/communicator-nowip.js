#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
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
        debug(this.session.sid, 'CHANNEL_CREATE:', 'ring_ready');
        esl.executeAsyncX('ring_ready', [], this.uuid = evt.headers['Unique-ID']);
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
        evt.parsed && esl.atm(evt, atm = { type: err ? '5' : 'A' });
        debug(this.session.sid, 'MESSAGE:', evt.headers['Event-Sequence'], atm.xml);
        if (err)
            return console.log(this.session.sid, 'onCommunicatorNowipMessage:', err) || this.signal('clear') || this;

        Object.assign(this.session.payload, evt.parsed); // copies ATM
        this.session.signal('consume');
        return this;
    },
});
