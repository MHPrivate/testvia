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

var communicatorState = {
 // _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorScaipEnter() {
        console.log('onCommunicatorScaipEnter:');
        return this;
    },
    leave: function onCommunicatorScaipLeave() {
        console.log('onCommunicatorScaipLeave:');
    },
    jsonReceived: function onCommunicatorScaipJsonReceived(json) { // { ?? }
        console.log('onCommunicatorScaipJsonReceived:');
        this.session.locals.scaipJson = json.scaip;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorScaipChannelDestroy(evt, aleg) { // terminate session on aleg-destroy
        console.log('onCommunicatorScaipChannelDestroy:');
        return this.session.enter(null) || this;
    },
};
