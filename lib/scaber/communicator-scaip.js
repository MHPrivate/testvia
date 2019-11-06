#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cluster = require('cluster');
var debug = require('debug')('communicator:scaip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = CommunicatorScaip; // THIS MODULE IS NOT YET FULLY IMPLEMENTED

require('util').inherits(CommunicatorScaip, require('../state-machine'));
function CommunicatorScaip(session) {
    if (this instanceof CommunicatorScaip === false)
        throw new Error('Constructor CommunicatorScaip requires \'new\'');
    CommunicatorScaip.super_.call(this, communicatorState, {
        session: session,
    });
}

var communicatorState = { // _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorScaipEnter() { // websvc accepted our offer to handl
        console.log('onCommunicatorScaipEnter:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
        return this;
    },
    leave: function onCommunicatorScaipLeave() {
        console.log('onCommunicatorScaipLeave:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
    },
    answer: function onCommunicatorNowipAnswer() { // request to answer a-leg if not already answered
        console.log('onCommunicatorNowipAnswer:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
        if (this.session.locals.alegEvt.type === 'CHANNEL_ANSWER')
            return this;
        esl.bgapiX('uuid_answer', [this.session.locals.alegEvt.headers['Unique-ID']]);
    },
    jsonReceived: function onCommunicatorScaipJsonReceived(json) { // { ?? }
        console.log('onCommunicatorScaipJsonReceived:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
        this.session.locals.scaipJson = json.scaip;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorScaipChannelDestroy(evt, aleg) { // a-leg has ended
        console.log('onCommunicatorScaipChannelDestroy:', this.session.locals.alegEvt && this.session.locals.alegEvt.header['Unique-ID']);
        return this.session.enter(null) || this;
    },
};
