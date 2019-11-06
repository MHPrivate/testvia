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
    session.locals.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorNowip === false)
        throw new Error('Constructor CommunicatorNowip requires \'new\'');
    CommunicatorNowip.super_.call(this, communicatorState, {
        session: session,
    });
}

var communicatorState = {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorNowipEnter() { // websvc accepted our offer to handle
        console.log('onCommunicatorNowipEnter:', this.session.locals.alegEvt && this.session.locals.alegEvt.headers['Unique-ID']);
        if (!this.session.locals.alegEvt)
            return this;
        if (this.session.locals.alegEvt.type === 'CHANNEL_CREATE') // invoke ring_ready
            esl.bgapiX('uuid_ring_ready', [this.session.locals.alegEvt.headers['Unique-ID']]);
        return this;
    },
    leave: function onCommunicatorNowipLeave() {
        console.log('onCommunicatorNowipLeave:', this.session.locals.alegEvt && this.session.locals.alegEvt.headers['Unique-ID']);
    },
    answer: function onCommunicatorNowipAnswer() { // request to answer a-leg if not already answered
        console.log('onCommunicatorNowipAnswer:', this.session.locals.alegEvt && this.session.locals.alegEvt.headers['Unique-ID'], (this.session.locals.alegEvt || {}).type);
        if (!this.session.locals.alegEvt)
            return this;
        if (this.session.locals.alegEvt.type === 'CHANNEL_ANSWER')
            return this;
        esl.bgapiX('uuid_answer', [this.session.locals.alegEvt.headers['Unique-ID']]);
    },
    jsonReceived: function onCommunicatorNowipJsonReceived(json) { // { tba }
        console.log('onCommunicatorNowipJsonReceived:', this.session.locals.alegEvt && this.session.locals.alegEvt.headers['Unique-ID']);
        this.session.locals.json = json;
        this.session.signal('consume');
        return this;
    },
    CHANNEL_: function onCommunicatorNowipChannel(evt, aleg) { // miscellaneous CHANNEL_*** events
        console.log('onCommunicatorNowipChannel:', this.session.locals.alegEvt && this.session.locals.alegEvt.headers['Unique-ID'], evt.type);
        this.session.locals.alegEvt = evt;
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorNowipChannelDestroy(evt, aleg) { // a-leg has ended
        console.log('onCommunicatorNowipChannelDestroy:', this.session.locals.alegEvt && this.session.locals.alegEvt.headers['Unique-ID']);
        return this.session.enter(null) || this;
    },
    MESSAGE: function onCommunicatorNowipMessage(evt, aleg) { // received NOWIP message
        var sm = this;
        chain(function cleanup(err, js) {
            console.log('onCommunicatorNowipMessage:', sm.session.locals.alegEvt && sm.session.locals.alegEvt.headers['Unique-ID'], err ? err : JSON.stringify(js));
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
