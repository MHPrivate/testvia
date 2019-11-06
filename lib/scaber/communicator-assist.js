#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:assist');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = CommunicatorAssist;

require('util').inherits(CommunicatorAssist, require('../state-machine'));
function CommunicatorAssist(session) {
    session.locals.fallbackUris = '01472000000@volt-acton.appello.care:5066,01472000000@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorAssist === false)
        throw new Error('Constructor CommunicatorAssist requires \'new\'');
    CommunicatorAssist.super_.call(this, communicatorState, {
        session: session,
    });
}

var communicatorState = {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorAssistEnter() { // websvc accepted our offer to handle
        console.log('onCommunicatorAssistEnter:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID'], (this.session.locals.alegEvt || {}).type);
        if (!this.session.locals.alegEvt)
            return this;
        if (this.session.locals.alegEvt.type === 'CHANNEL_CREATE') // invoke ring_ready
            esl.bgapiX('uuid_ring_ready', [this.session.locals.alegEvt.headers['Unique-ID']])
        this.session.signal('consume');
        return this;
    },
    leave: function onCommunicatorAssistLeave() {
        console.log('onCommunicatorAssistLeave:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
    },
    answer: function onCommunicatorAssistAnswer() { // request to answer a-leg if not already answered
        console.log('onCommunicatorAssistAnswer:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID'], (this.session.locals.alegEvt || {}).type);
        if (!this.session.locals.alegEvt)
            return this;
        if (this.session.locals.alegEvt.type === 'CHANNEL_ANSWER')
            return this;
        esl.bgapiX('uuid_answer', [this.session.locals.alegEvt.headers['Unique-ID']]);
    },
    CHANNEL_: function onCommunicatorAssistChannel(evt, aleg) { // miscellaneous CHANNEL_*** events
        console.log('onCommunicatorAssistChannel:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID'], evt.type);
        this.session.locals.alegEvt = evt
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorAssistChannelDestroy(evt, aleg) { // a-leg has ended
        console.log('onCommunicatorAssistChannelDestroy:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
        return this.session.enter(null) || this;
    },
};
