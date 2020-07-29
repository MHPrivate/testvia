#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var cluster = require('cluster');
var debug = require('debug')('communicator:nowip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = CommunicatorNowip;

require('util').inherits(CommunicatorNowip, require('../state-machine'));
function CommunicatorNowip(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorNowip === false)
        throw new Error('Constructor CommunicatorNowip requires \'new\'');
    CommunicatorNowip.super_.call(this, communicatorState, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

var communicatorState = {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorNowipEnter(evt) { // websvc accepted our offer to handle
        return debug(this.session.sid, 'enter:', evt.type) || this;
    },
    leave: function onCommunicatorNowipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.session.signal('detached');
    },
    answer: function onCommunicatorNowipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', (this.session.firstEvt || {}).type);
        if (!this.uuid)
            return this.enter(null) || this;
        esl.bgapiX('uuid_answer', [this.uuid]);
        return this;
    },
    clear: function onCommunicatorNowipClear(err, evt) {
        debug.enabled && debug(this.session.sid, 'clear:', evt ? JSON.stringify(evt) : '');
        if (!this.uuid)
            return this.enter(null) || this;
        esl.bgapiX('uuid_kill', [this.uuid]);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorNowipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        esl.bgapiX('uuid_ring_ready', [this.uuid = evt.headers['Unique-ID']]);
        return this;
    },
    CHANNEL_: function onCommunicatorNowipChannel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':');
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorNowipChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:');
        return this.enter(null) || this;
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

        this.session.payload.ATM = evt.parsed.ATM;
        this.session.signal('consume');
        return this;
    },
};
