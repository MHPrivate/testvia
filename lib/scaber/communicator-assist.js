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
    enter: function onCommunicatorAssistEnter() {
        console.log('onCommunicatorAssistEnter:');
        this.session.signal('consume');
        return this;
    },
    leave: function onCommunicatorAssistLeave() {
        console.log('onCommunicatorAssistLeave:');
    },
    CHANNEL_: function onCommunicatorAssistChannel(evt, aleg) {
        console.log('onCommunicatorAssistChannel:', evt.type);
        this.session.locals.alegEvt = evt
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorAssistChannelDestroy(evt, aleg) { // terminate session on aleg-destroy
        console.log('onCommunicatorAssistChannelDestroy:');
        return this.session.enter(null) || this;
    },
};
