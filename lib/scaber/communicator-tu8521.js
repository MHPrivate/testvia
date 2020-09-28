#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:tu8521');
var esl = require('../esl');
var main = require.main.exports;
var nowip = require('../nowip');
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

var A26H = /A(\d{24,26})#?/;
var sends = {
    dataRequest: 'b@1000',
    acknowledge: 'b@80',
    speechReset:    'a30#@80',  // reset to default setting
    speechVolume1:  'a31#@80',  // volume level 1 (quiet preset)
    speechVolume2:  'a32#@80',  // volume level 2 (normal preset)
    speechVolume3:  'a33#@80',  // volume level 3 (loud preset)
    speechVolumeUp: 'a34#@80',  // volume up
    speechVolumeDn: 'a35#@80',  // volume down
    speechSpeaker1: 'a36#@80',  // select speaker 1
    speechSpeaker2: 'a37#@80',  // select speaker 2
    speechDuplex:   'a38#@80',  // switch to VOX mode
    speechSimplex:  'a39#@80',  // switch to simplex tone controlled (listen) mode
    pathSpeak:      'a@250+7@80',   // speak
    pathListen:     'a@250+8@80',   // listen
    pathClear:      'a@250+9@80',   // clear (clear speech)
    pathClose:      'a@250+d@80',   // clear down
    pathNull:       'a@250+#@80',   // null command (keepalive)
    selectUnit:     'a0%{0000}#',   // select local unit in grouped equipment
    catalogue:      'a1%{0000}#',   // list information on outstanding calls
};
module.exports = CommunicatorTu8521;

require('util').inherits(CommunicatorTu8521, require('../state-machine'));
function CommunicatorTu8521(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorTu8521 === false)
        throw new Error('Constructor CommunicatorTu8521 requires \'new\'');
    CommunicatorTu8521.super_.call(this, CommunicatorTu8521, {
        dtmfs: {}, // dictionary of phase dtmf accumulators
        keepalive: undefined, // reference to keepalive interval
        leaving: 0, // used to prevent recursive calls to state:leave method
        phase: undefined, // current dtmf phase
        session: session, // a reference to the owning session
        timeout: undefined, // timeout handle
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

Object.assign(CommunicatorTu8521, {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorTu8521Enter(evt) { // websvc accepted our offer to handle
        return debug(this.session.sid, 'enter:', evt.type) || this;
    },
    leave: function onCommunicatorTu8521Leave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.timeout = worker.resetTimeout(this.timeout);
        this.session.signal('detached');
    },
    release: function onCommunicatorTu8521Release() { // forced release timeout
        debug(this.session.sid, 'release:');
        this.timeout = worker.resetTimeout(this.timeout);
        if (!this.uuid)
            return this.enter(null) || this;
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    answer: function onCommunicatorScaipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorTu8521ChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:', evt.headers['Unique-ID']);
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];
        this.uuid = evt.headers['Unique-ID'];
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, evt.type + ':', err);

        }, function () {
            //esl.executeAsyncX('multiset', ['drop_dtmf=true park_after_bridge=true'], sm.uuid, this);
            esl.executeAsyncX('multiset', ['park_after_bridge=true'], sm.uuid, this);

        }, function (evt) {
            esl.executeAsyncX('tu_start', ['direction=rw,acks=6'], sm.uuid, this);

        }, function (evt) {
            esl.executeAsyncX('answer', [], sm.uuid, this);

        }, function (evt) {
            esl.executeAsyncX('echo', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorTu8521Channel(evt, first) { // miscellaneous CHANNEL_*** events
        debug(this.session.sid, evt.type + ':', evt.headers['Unique-ID']);
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorTu8521ChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:', evt.headers['Unique-ID']);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorTu8521Custom(evt, first) { // received TU8521 custom event
        var parsed, tu = JSON.parse(evt.headers['Tu-Call-Details']);
        debug(this.session.sid, 'CUSTOM:', evt.subclass, ((tu || {}).alarm_message || {}).encoded);
        if (!tu || tu.alarm_message_received !== 'true' || !(parsed = nowip.parse(tu.alarm_message.encoded.slice(1)))) // skip-over the 'A'
            return this.signal('release');

        parsed.$.speech = 1; // VOX
        Object.assign(this.session.payload, { ATM: { data: [nowip.stringify(parsed)] } });
        return this.session.signal('consume'), this;
    },
    DTMF: function onCommunicatorTu8521Dtmf(evt, first) { // received BS8521 dtmf
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
});
