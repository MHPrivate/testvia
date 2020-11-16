#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
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
        return debug(this.session.sid, 'enter:', evt.type) || this;
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
        esl.bgapiX('uuid_answer', [this.uuid]);
        return this;
    },
    clear: function onCommunicatorAssistClear(err, evt) {
        debug.enabled && debug(this.session.sid, 'clear:', evt ? JSON.stringify(evt) : '', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        esl.bgapiX('uuid_kill', [this.uuid]);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorAssistChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        Object.assign(this.session.payload, { originUser: evt.headers['Caller-Caller-ID-Number'] });
        esl.bgapiX('uuid_ring_ready', [this.uuid = evt.headers['Unique-ID']]);
        this.session.signal('consume');
        return this;
    },
    CHANNEL_: function onCommunicatorAssistChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorAssistChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:');
        return this.enter(null) || this;
    },
});
