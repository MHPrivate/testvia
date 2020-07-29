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
        callerId: undefined, // only set where handling a long-lived MESSAGE
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        timeout: undefined, // reference to a call-arrival (60s) or clear-down(5s) timeout
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

var communicatorState = {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorScaipEnter(evt) { // websvc accepted our offer to handle
        var err, sid = this.session.sid;
        if (this.session.firstEvt.type !== 'MESSAGE')
            return debug(this.session.sid, 'enter:', evt.type) || this;

        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;

        if ((((evt.parsed || {}).mrq || {}).crd || ['sip:'])[0].endsWith(':'))
            return debug(this.session.sid, 'enter:', evt.type) || this;

        var match = evt.parsed.mrq.crd[0].match(/:\+?(.*)/); // no-voice: gsm: sip: sip-pp:
        this.session.sid = '$' + (this.session.origin = match[1]) + '$' + this.session.unique;
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
            esl.bgapiX('uuid_drop_dtmf', [sm.uuid, 'off mask_digits ""'], this);

        }, function (evt) {
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
        var err, mandatory = new Set(['ref', 'cid', 'dty']); // each of these attributes must have content
        debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], evt.body);
        evt.parsed || xml2js.parseString(evt.body, function (err, js) {
            evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
        });
        (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
        if (!err) {
            mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.mrq || {});
            mandatory.size && (err = Object.assign(new Error('invalid SCAIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
        }
        if (err)
            return console.log(this.session.sid, 'onCommunicatorScaipMessage:', err) || this.enter(null) || this;

        var mrq = evt.parsed.mrq, mrs = { ref: mrq.ref[0], snu: '0' }; // undefined=noch; false=drop, true=keep
        var stc = +(mrq.stc || ['10'])[0];
        var cid = (mrq.crd || ['sip:'])[0]; // no-voice: gsm: sip: sip-pp:
        //debug(this.session.sid, evt.type + ':', JSON.stringify({ stc: stc, cid: cid, callerId: this.callerId }));
        switch ((mrq.mty || ['ME'])[0]) {
            case 'ME':// message - alarm notify
                if (stc === 19) // 19=cancel
                    cid = undefined; // immediate cleanup
                else if (stc === 102)
                    cid = this.callerId || undefined;
                else if (cid.endsWith(':'))
                    cid = this.callerId || undefined;
                else
                    this.session.payload.mrq = Object.assign(mrs, { mre: 1, cre: 61 }) && evt.parsed.mrq;
                break;

            case 'RE': // reset - alarm withdrawn
                cid = undefined;
                break;

            case 'IN': // information - alarm update
                this.session.payload.mrq = evt.parsed.mrq;
                break;

            case 'PI': // hearbeat
                if (cid.endsWith(':'))
                    cid = this.callerId || undefined;
                break;

            default:
                console.log(JSON.stringify(evt.parsed));
                Object.assign(mrs, { snu: 99}); // undefined error
                break;
        }
        //debug(this.session.sid, evt.type + ':', JSON.stringify({ mrs: mrs, cid: cid, callerId: this.callerId }));
        esl.mrs(evt, mrs);
        debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], mrs.xml);
        if (!cid) // immediate wrapup
            return this.enter(null) || this;

        this.callerId || (this.callerId = cid);
        if (this.uuid) // already have the Communicator call
            return this;

        this.timeout = clearTimeout(this.timeout) || setTimeout(this.enter.bind(this, null), 60000); // exit Communicator unless call arrives within 60sec
        return this;
    },
};

/// heartbeats:
// essence: <mrq><ref>00001A85</ref><cha>0</cha><mty>PI</mty><cid>26317</cid><dty>02</dty><did>00</did><crd>no-voice:</crd><stc>102</stc></mrq>
// possum:  <mrq><mty>PI</mty><ref>1998218577</ref><cid>10149471</cid><dty>2</dty></mrq>

/// alarms:
// essence: <mrq><ref>00001883</ref><cha>0</cha><mty>ME</mty><cid>26317</cid><dty>02</dty><did>00</did><crd>gsm:+37284463906</crd><stc>010</stc></mrq>
// possum:  <mrq><ref>1193308443</ref><cid>10149471</cid><dty>3</dty><stc>10</stc><crd>gsm:+3197025136418</crd></mrq>
// possum:  <mrq><ref>2028140111</ref><cid>10149471</cid><dty>4</dty><stc>10</stc><crd>gsm:+3197025136418</crd></mrq>