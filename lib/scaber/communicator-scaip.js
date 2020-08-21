#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:scaip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

var reCrd = /^([^:]+:).*/;
var reReq = /\bappello=scaber\b/;
module.exports = Object.assign(CommunicatorScaip, {
    defaults: defaults,
});

require('util').inherits(CommunicatorScaip, require('../state-machine'));
function CommunicatorScaip(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorScaip === false)
        throw new Error('Constructor CommunicatorScaip requires \'new\'');
    CommunicatorScaip.super_.call(this, communicatorState, {
        callerId: undefined, // only set where handling a long-lived MESSAGE (eg gsm:+372... OR sip:user@ip)
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        timeout: undefined, // reference to a call-arrival (60s) or clear-down(5s) timeout
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

defaults.mrq = { // message-request defaults (when omitted)
    ver: ['01.00'], // version
    sco: ['0'],     // system-config
    cha: ['0'],     // call-handling
    mty: ['ME'],    // message-type
    hbo: ['0'],     // heartbeat-options
    crd: ['sip:'],  // caller-id
    stc: ['10'],    // status-code
    pri: ['0'],     // priority
    lco: ['0'],     // location-code
    ame: ['0'],     // additional-message
};

defaults.mrs = { // message-response defaults (when omitted)
    cve: ['01.00'], // common-version
    mre: ['0'],     // media-reply
    cre: ['61'],    // callhandling-reply
};

function defaults(parsed, type) {
    if (typeof parsed !== 'object' || typeof parsed[type] !== 'object')
        return;
    for (var key in defaults[type])
        if (!Array.isArray(parsed[type][key]) || !parsed[type][key].length)
            parsed[type][key] = defaults[type][key];
    return parsed;
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

        return debug(this.session.sid, 'enter:', evt.type) || this;
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
        if (reReq.test(evt.headers['variable_sip_req_params']))
            this.session.payload.e164 = evt.headers['Caller-Caller-ID-Number'];
        this.uuid = evt.headers['Unique-ID'];
        var sm = this;
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, evt.type + ':', err);
            sm.session.signal('consume');

        }, function () {
            esl.bgapiX('uuid_setvar_multi', [sm.uuid, 'drop_dtmf=true;park_after_bridge=true'], this);

        }, function (evt) {
            esl.bgapiX('uuid_ring_ready', [sm.uuid], this);

        });
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
            defaults(evt.parsed, 'mrq') && mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.mrq || {});
            mandatory.size && (err = Object.assign(new Error('invalid SCAIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
        }
        if (err)
            return console.log(this.session.sid, 'onCommunicatorScaipMessage:', err) || this.enter(null) || this;

        var mrq = evt.parsed.mrq, mrs = evt.parsed.mrs = { ref: mrq.ref[0], snu: '0' }; // undefined=noch; false=drop, true=keep
        var stc = +mrq.stc[0], crds; // crds={no-voice:,gsm:,sip:,sip-pp:}
        mrq.crd.forEach(function (crd, idx, arr) {
            //var crd_ = crd;
            (crd = crd.match(reCrd)) && (this[crd[1]] = crd[0])
            //debug(JSON.stringify({ crd: crd_, match: crd, crds: this }));
        }, crds = {});
        //debug(this.session.sid, evt.type + ':', JSON.stringify({ stc: stc, crds: crds, callerId: this.callerId }));
        switch (mrq.mty[0]) {
            case 'ME':// message - alarm notify
                if (stc === 19) // 19='Cancel'
                    crds = undefined; // immediate cleanup
                else if (stc === 102) // 102='Test transmission, primary channel'
                    crds = undefined;
                else if (![9, 10].includes(stc)) // non-alarm, therefore non-call - simply acknowledge
                    crds = undefined;
                else if (this.callerId) // already expecing/have the Communicator call
                    mrs.snu = 6; // busy
                else if (Object.assign(mrs, { mre: 1, cre: 62 })) // always true
                    Object.assign(this.session.payload, evt.parsed); // copies mrq & mrs
                break;

            case 'RE': // reset - alarm withdrawn
                this.callerId = crds = undefined;
                break;

            case 'IN': // information - alarm update
                Object.assign(this.session.payload, evt.parsed); // copies mrq & mrs
                break;

            case 'PI': // hearbeat
                crds = undefined;
                break;

            default:
                console.log(JSON.stringify(evt.parsed));
                Object.assign(mrs, { snu: 99 }); // undefined error
                cdrs = undefined;
                break;
        }

        //debug(this.session.sid, evt.type + ':', JSON.stringify({ mrs: mrs, crds: crds, callerId: this.callerId }));
        if (this.uuid) { // already have the Communicator call

        }
        if (!mrs.mre) { // non-call SCAIP message
            esl.mrs(evt, mrs);
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], '---:', mrs.xml);
            return this.callerId || this.enter(null) || this; // ongoing alarm OR cleanup
        }

        // if we get here this.callerId is not yet set
        if (this.callerId = crds['sip:']) {
            sm.timeout = clearTimeout(sm.timeout) || setTimeout(sm.enter.bind(sm, null), 60000); // exit Communicator unless call arrives within 60sec
            Object.assign(mrs, { tnu: evt.headers['login'].replace('mod_sofia', evt.headers['to_user']) });
            esl.mrs(evt, mrs);
            return debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], 'sip:', mrs.xml) || this;

        } else if (this.callerId = crds['gsm:']) {
            var sm = this;
            chain(function cleanup(err) {
                if (err)
                    console.log(sm.session.sid, 'onCommunicatorScaipMessage:', err) || sm.enter(null);
                debug(sm.session.sid, evt.type + ':', evt.headers['Event-Sequence'], 'gsm:', mrs.xml);


            }, function () {
                worker.scaipCid2Tnu(sm.session, mrq.cid[0], this);

            }, function (tnu) {
                Object.assign(mrs, { tnu: tnu });
                sm.timeout = clearTimeout(sm.timeout) || setTimeout(sm.enter.bind(sm, null), 60000); // exit Communicator unless call arrives within 60sec
                esl.mrs(evt, mrs, this);

            });
            return this;

        } else {
            esl.mrs(evt, Object.assign(mrs, { mre: 0, cre: 0 } ));
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], '???:', mrs.xml);
            return this.enter(null) || this;

        }
    },
};

/// heartbeats:
// essence:     <mrq><ref>00001A85</ref><cha>0</cha><mty>PI</mty><cid>26317</cid><dty>02</dty><did>00</did><crd>no-voice:</crd><stc>102</stc></mrq>
// possum:      <mrq><mty>PI</mty><ref>1998218577</ref><cid>10149471</cid><dty>2</dty></mrq>
// telealarm:   <mrq><ref>v6l7eiuzBTfybE7j</ref><cid>999998</cid><dty>0002</dty><mty>PI</mty><stc>0009</stc><lco>002</lco><crd>gsm:</crd><cha>0</cha></mrq>

/// alarms:
// essence:     <mrq><ref>00001883</ref><cha>0</cha><mty>ME</mty><cid>26317</cid><dty>02</dty><did>00</did><crd>gsm:+37284463906</crd><stc>010</stc></mrq>
// possum:      <mrq><ref>1193308443</ref><cid>10149471</cid><dty>3</dty><stc>10</stc><crd>gsm:</crd></mrq>
// possum:      <mrq><ref>1925996942</ref><cid>10149471</cid><dty>4</dty><stc>10</stc><crd>gsm:</crd></mrq>
// telealarm    <mrq><ref>lmepivnFqmI8Jvv1</ref><cid>999998</cid><dty>0002</dty><mty>ME</mty><stc>0067</stc><crd>gsm:</crd><cha>0</cha></mrq>
// telealarm    <mrq><ref>yhexGeV5E49zglfi</ref><cid>999998</cid><dty>0004</dty><mty>ME</mty><stc>0010</stc><lco>002</lco><crd>gsm:</crd><cha>0</cha></mrq>
