#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:scaip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

module.exports = CommunicatorScaip; // THIS MODULE IS NOT YET FULLY IMPLEMENTED

require('util').inherits(CommunicatorScaip, require('../state-machine'));
function CommunicatorScaip(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorScaip === false)
        throw new Error('Constructor CommunicatorScaip requires \'new\'');
    CommunicatorScaip.super_.call(this, communicatorState, {
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        timeout: undefined, // reference to a call-arrival (60s) or clear-down(5s) timeout
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

var communicatorState = { // _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorScaipEnter(evt) { // websvc accepted our offer to handle
        var err, sid = this.session.sid;
        if (this.session.firstEvt.type !== 'MESSAGE')
            return debug(this.session.sid, 'enter:', evt.type) || this;

        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;

        var match = ((((evt.parsed || {}).mrq || {}).crd || [])[0] || 'sip:').match(/([^:]*:)\+?(.*)/); // no-voice: gsm: sip: sip-pp:
        if (!match || !match[2])
            return debug(this.session.sid, 'enter:', evt.type) || this;

        this.session.callerId = match;
        this.session.sid = '$' + (this.session.origin = match[2]) + '$' + this.session.unique;
        return debug(this.session.sid, 'enter:', evt.type, 'was', sid) || this;
    },
    leave: function onCommunicatorScaipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.timeout = clearTimeout(this.timeout);
        this.session.signal('detached');
    },
    answer: function onCommunicatorScaipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:');
        if (!this.uuid)
            return this.enter(null) || this;
        esl.bgapiX('uuid_answer', [this.uuid]);
        return this;
    },
    clear: function onCommunicatorNowipClear() {
        debug(this.session.sid, 'clear:');
        if (!this.uuid)
            return this.enter(null) || this;
        this.timeout = setTimeout(this.signal.bind(this, 'timeout'), 5000); // allow the scaip device upto 5s to disconnect
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, 'onCommunicatorNowipClear:', err);

        }, function () {
            debug(sm.session.sid, 'clear: drop_dtmf off');
            esl.bgapiX('uuid_drop_dtmf', [sm.uuid, 'off mask_digits ""'], this);

        }, function (evt) {
            debug(sm.session.sid, 'clear: send_dtmf:0');
            esl.bgapiX('uuid_send_dtmf', [sm.uuid, '0@150'], this);

        });
        return this;
    },
    timeout: function onCommunicatorScaipTimeout() {
        debug(this.session.sid, 'timeout:');
        this.timeout = clearTimeout(this.timeout);
        if (!this.uuid)
            return this.enter(null) || this;
        esl.bgapiX('uuid_kill', [this.uuid]);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorScaipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.timeout = clearTimeout(this.timeout);
        esl.bgapiX('uuid_ring_ready', [this.uuid = evt.headers['Unique-ID']]);
        this.session.signal('consume');
        return this;
    },
    CHANNEL_: function onCommunicatorScaipChannel(evt, first) {
        debug(this.session.sid, evt.type + ':');
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorScaipChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:');
        this.timeout = clearTimeout(this.timeout);
        return this.enter(null) || this;
    },
    MESSAGE: function onCommunicatorScaipMessage(evt, first) {
        var err, mandatory = new Set(['ref', 'cid', 'dty']);
        debug(this.session.sid, evt.type, evt.headers['Event-Sequence'], evt.body);
        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
        if (!err) {
            mandatory.forEach(function (key, idx, arr) { key in this && arr.delete(key) }, evt.parsed.mrq || {});
            mandatory.size && (err = Object.assign(new Error('invalid SCAIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
        }
        if (err)
            return console.log(this.session.sid, 'onCommunicatorScaipMessage:', err) || this;

        var mrq = evt.parsed.mrq, mrs = { ref: mrq.ref[0] };
        var callerId = ((mrq.crd || [])[0] || 'sip:').match(/([^:]*:)\+?(.*)/); // no-voice: gsm: sip: sip-pp
        switch ((mrq.mty || ['ME'])[0]) {
            case 'ME': // message - alarm notify
                (+(mrq.stc || [])[0] === 19) && (this.session.callerId = callerId); // 19=cancel
                callerId && callerId[2] && (mrs.mre = '1');

            case 'RE': // reset - alarm withdrawn
            case 'IN': // information - alarm update
            case 'PI': // hearbeat
                break;
            default:
                console.log(JSON.stringify(evt.parsed));
                mrs.snu = '99'; // undefined error
                break;
        }
        esl.mrs(evt, mrs);
        if ((!callerId || callerId[1] === 'no-voice:') && (!this.session.callerId || this.session.callerId[1] === 'no-voice:'))
            return this.enter(null) || this;
        this.session.payload.mrq = evt.parsed.mrq;
        if (this.uuid) // already have the Communicator call
            return this;

        this.timeout = clearTimeout(this.timeout) || setTimeout(this.enter.bind(this, null), 60000); // exit Communicator unless call arrives within 60sec
        return this;
    },
};
