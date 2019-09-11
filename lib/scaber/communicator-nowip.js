#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:nowip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = CommunicatorNowip;

require('util').inherits(CommunicatorNowip, require('../state-machine'));
function CommunicatorNowip(session) {
    if (this instanceof CommunicatorNowip === false)
        throw new Error('Constructor CommunicatorNowip requires \'new\'');
    CommunicatorNowip.super_.call(this, communicatorState, {
        session: session,
    });
}

var communicatorState = {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorNowipEnter() {
        console.log('onCommunicatorNowipEnter:');
        return this;
    },
    leave: function onCommunicatorNowipLeave() {
        console.log('onCommunicatorNowipLeave:');
    },
    jsonReceived: function onCommunicatorNowipJsonReceived(json) { // { caller, callid, duid, gps, mac, nowip }
        console.log('onCommunicatorNowipJsonReceived:');
        this.session.locals.nowipJson = json.nowip;
        this.session.signal('consume');
        return this;
    },
    CHANNEL_: function onCommunicatorNowipChannel(evt, aleg) {
        console.log('onCommunicatorNowipChannel:', evt.type);
        this.session.locals.alegEvt = evt
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorNowipChannelDestroy(evt, aleg) { // terminate session on aleg-destroy
        console.log('onCommunicatorNowipChannelDestroy:');
        return this.session.enter(null) || this;
    },
    MESSAGE: function onCommunicatorNowipMessage(evt, aleg) {
        var sm = this;
        chain(function cleanup(err, js) {
            console.log('onCommunicatorNowipMessage:', err ? err : JSON.stringify(js));
            if (!js)
                return;
            sm.session.locals.nowipMesg = js;
            sm.session.signal('consume');
            esl.atm(evt, { type: err ? '5' : 'A' });

        }, function () {
            xml2js.parseString(evt.body, this);

        }, function (js) {
            if (!js.ATM)
                return this(Object.assign(new Error('invalid NOWIP message'), { xml: evt.body }));
            var mandatory = new Set(['version', 'type', 'data', 'time', 'mac']);
            mandatory.forEach(function (key, idx, arr) { key in this && arr.delete(key) }, js.ATM);
            if (mandatory.size)
                return this(Object.assign(new Error('invalid NOWIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
            this(null, js); // { ATM: { version, type, data, time, mac, ?wgs } }

        });
        return this;
    },
};
