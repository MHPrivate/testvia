#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain')
var cluster = require('cluster');
var debug = require('debug')('communicator:assist');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = CommunicatorAssist;

require('util').inherits(CommunicatorAssist, require('../state-machine'));
function CommunicatorAssist(session, evt) {
    session.fallbackUris = '01472000000@volt-acton.appello.care:5066,01472000000@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorAssist === false)
        throw new Error('Constructor CommunicatorAssist requires \'new\'');

    CommunicatorAssist.super_.call(this, CommunicatorAssist, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorAssist, {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorAssistEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorAssistLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.session.signal('detached');
    },
    answer: function onCommunicatorAssistAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
        return this;
    },
    clear: function onCommunicatorAssistClear(err, evt) {
        debug.enabled && debug(this.session.sid, 'clear:', evt ? JSON.stringify(evt) : '', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'clear:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorAssistChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        Object.assign(this.session.payload, { originUser: evt.headers['Caller-Caller-ID-Number'] });

        var sm = Object.assign(this, { uuid: evt.headers['Unique-ID'] });
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, 'CommunicatorAssist:CHANNEL_CREATE', err);
            this.session.signal('consume', undefined);

        }, function () {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'resord_session');
            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'ring_ready');
            esl.executeAsyncX('ring_ready', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorAssistChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorAssistChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorAssistCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorAssistTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorAssistDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
});
