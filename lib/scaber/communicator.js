#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cluster = require('cluster');
var debug = require('debug')('communicator');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }

module.exports = Communicator;

require('util').inherits(Communicator, require('../state-machine'));
function Communicator(session) {
    if (this instanceof Communicator === false)
        throw new Error('Constructor Communicator requires \'new\'');
    Communicator.super_.call(this, communicatorState, {
        session: session,
    });
}

var communicatorState = { // _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorEnter() {
        console.log('onCommunicatorEnter:');
        return this;
    },
    leave: function onCommunicatorLeave() {
        console.log('onCommunicatorLeave:');
    },
    jsonReceived: function onCommunicatorJsonReceived(json) {
        console.log('onCommunicatorJsonReceived');
        if (json.nowip)
            this.locals.communicator = this.enter(null) || new main.modules.CommunicatorNowip(this.session);
        else if (json.scaip)
            this.locals.communicator = this.enter(null) || new main.modules.CommunicatorScaip(this.session);
        else
            return; // not consumed
        this.locals.communicator.signal('jsonReceived', json);
    },
    CHANNEL_DESTROY: function onCommunicatorChannelDestroy(evt, aleg) { // terminate session on aleg-destroy
        console.log('onCommunicatorChannelDestroy:');
        return this.session.enter(null) || this;
    },
};
