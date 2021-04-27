#! /usr/bin/env node-strict
var argsMap = require('../args-map');
var callsites = require('callsites');
var chain = require('scope-chain');
var cluster = require('cluster');
var debug = require('debug')('communicator:scaip');
var esl = require('../esl');
var main = require.main.exports;
var worker = require('./worker'); // { __proto__: cluster.worker, esl, routes, sendCb(), sent(), sessions }
var xml2js = require('xml2js');

var reCrd = /^([^:]+:).*/; // no-voice: / gsm: / sip: / tel:
module.exports = Object.assign(CommunicatorScaip, {
    allowStcs: undefined && [9, 10, 16, 110, 123, 124],
    blockStcs: process.env.FALLBACKURIS && [102, 113, 123],
    defaults: defaults,
    sends: {
        pathClose: '0@200', // clear (clear speech)
        speechDuplex: '4@200', // duplex
    },
});

process.on('sipMessagePreProcess', function onSipMessageProProcessScaip(evt) {
    var err, mandatory = new Set(['ref', 'cid', 'dty']); // each of these attributes must have content
    if (evt.headers['type'] !== 'application/scaip+xml')
        return;

    evt.parsed || xml2js.parseString(evt.body, function (err, js) {
        evt.parsed = err ? Object.assign(err, { xml: evt.body }) : js;
    });
    (evt.parsed instanceof Error) && (err = evt.parsed) && delete evt.parsed;
    if (err || !defaults(evt.parsed, 'mrq'))
        return err && console.log('onSipMessageProProcessScaip:', err);

    mandatory.forEach(function (key, idx, arr) { this[key] && this[key].length && arr.delete(key) }, evt.parsed.mrq || {});
    mandatory.size && (err = Object.assign(new Error('invalid SCAIP message missing [' + Array.from(mandatory).join() + ']'), { xml: evt.body }));
    if (err)
        return console.log('onSipMessageProProcessScaip:', err);

    evt.scaber = {
        origin: evt.headers['from_user'],
        unique: evt.parsed.mrq.ref[0],
    };
    evt.scaber.sid = '$' + evt.scaber.origin + '$' + evt.scaber.unique;
});

require('util').inherits(CommunicatorScaip, require('../state-machine'));
function CommunicatorScaip(session, evt) {
    session.fallbackUris = '01472278521@volt-acton.appello.care:5066,01472278521@volt-slough.appello.care:5066';
    if (this instanceof CommunicatorScaip === false)
        throw new Error('Constructor CommunicatorScaip requires \'new\'');

    CommunicatorScaip.super_.call(this, CommunicatorScaip, {
        callerId: undefined, // only set where handling a long-lived MESSAGE (eg gsm:+372... OR sip:user@ip)
        keepalive: undefined, // reference to keepalive interval
        leaving: 0, // used to prevent recursive calls to state:leave method
        session: session, // a reference to the owning session
        timeout: undefined, // reference to a call-arrival (60s) or clear-down(5s) timeout
        uuid: undefined, // channel-id of inbound call
    }, evt);
}

defaults.mrq = { // message-request defaults (when omitted)
    ame: ['0'],     // additional-message
    cha: ['0'],     // call-handling
    crd: ['sip:'],  // caller-id
    dte: [''],      // device-text (like user-agent)
    hbo: ['0'],     // heartbeat-options
    lco: ['0'],     // location-code
    mty: ['ME'],    // message-type
    pri: ['0'],     // priority
    sco: ['0'],     // system-config
    stc: ['10'],    // status-code
    ver: ['01.00'], // version
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

Object.assign(CommunicatorScaip, {// _this_ of all methods is the StateMachine instance
    enter: function onCommunicatorScaipEnter(evt) { // websvc accepted our offer to handle
        debug(this.session.sid, 'enter:', evt.type);
        return this;
    },
    leave: function onCommunicatorScaipLeave() {
        if (this.leaving++) // already leaving - prevent recursion
            return;
        debug(this.session.sid, 'leave:');
        this.keepalive = worker.resetInterval(this.keepalive);
        this.timeout = worker.resetTimeout(this.timeout);
        this.session.signal('detached');
    },
    send: function onCommunicatorScaipSend(cond, op, /* ..., */ cb) {
        var args = Array.from(arguments);
        cond = typeof args[0] === 'function' ? args.shift() : undefined;
        op = args.shift();
        cb = typeof args.slice(-1)[0] === 'function' ? args.pop() : undefined;
        debug(this.session.sid, 'send:', op, CommunicatorScaip.sends[op]);
        this.timeout = worker.resetTimeout(this.timeout);
        if (!op || !CommunicatorScaip.sends[op] || (cond && !cond.call(this)))
            return cb && cb(), this;

        var sm = this;
        chain(cb || function cleanup(err, evt) {
            err && console.log(sm.session.sid, 'onCommunicatorScaipSend:', err);
            ((evt || { body: '' }).body[0] === '-') && console.log(sm.session.sid, 'onCommunicatorScaipSend:', evt.body.slice(0, -1));

        }, function () {
            debug(sm.session.sid, 'send:', 'allow_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} off mask_digits -}'], sm.uuid, this);

        }, function () {
            var n = -1,
                dtmf = CommunicatorScaip.sends[op].replace(/%{(\d+)}/, function (match, digits) { // replace any %{n} with varargs
                    return (typeof args[++n] !== 'number') ? digits : ('0'.repeat(digits.length) + args[n]).slice(-digits.length);
                });
            debug(sm.session.sid, 'send:', 'send_dtmf', dtmf);
            esl.executeAsyncX('send_dtmf', [dtmf], sm.uuid, this);

        }, function () {
            debug(sm.session.sid, 'send:', 'block_dtmf');
            esl.executeAsyncX('eval', ['${uuid_drop_dtmf ${uuid} on mask_digits -}'], sm.uuid, this);

        });
        return this;
    },
    clear: function onCommunicatorScaipClear(err, evt) {
        debug(this.session.sid, 'clear:', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        this.keepalive = worker.resetInterval(this.keepalive);
        this.signal('send', 'pathClose');
        this.timeout = worker.resetTimeout(this.timeout, this.signal.bind(this, 'release'), 10000); // allow the scaip device upto 5s to disconnect
        return this;
    },
    release: function onCommunicatorScaipRelease() { // forced release timeout
        debug(this.session.sid, 'release:');
        this.timeout = worker.resetTimeout(this.timeout);
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'release:', 'hangup');
        esl.executeAsyncX('hangup', [], this.uuid);
        return this;
    },
    answer: function onCommunicatorScaipAnswer() { // request to answer a-leg if not already answered
        debug(this.session.sid, 'answer:', callsites()[2].toString());
        if (!this.uuid)
            return this.enter(null) || this;
        debug(this.session.sid, 'answer:', 'answer');
        esl.executeAsyncX('answer', [], this.uuid);
        this.keepalive = worker.resetInterval(this.keepalive, this.signal.bind(this, 'send', 'speechDuplex'), 60000);
        return this;
    },
    CHANNEL_CREATE: function onCommunicatorScaipChannelCreate(evt, first) {
        debug(this.session.sid, 'CHANNEL_CREATE:');
        this.timeout = worker.resetTimeout(this.timeout);
        if (worker.appelloScaber.test(evt.headers['variable_sip_req_params'])) // appello=scaber indicates PSTN call
            this.session.payload.e164 = evt.headers['_e164'] || evt.headers['Caller-Caller-ID-Number'];

        var sm = Object.assign(this, { uuid: evt.headers['Unique-ID'] });
        chain(function cleanup(err) {
            err && console.log(sm.session.sid, evt.type + ':', err);
            debug(sm.session.sid, 'CHANNEL_CREATE:', 'ringing');
            sm.session.signal('consume', undefined);

        }, function () {
            esl.executeAsyncX('multiset', ['drop_dtmf=true park_after_bridge=true'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.1:', 'record_session');
            esl.executeAsyncX('record_session', ['${record_file_path}'], sm.uuid, this);

        }, function (evt) {
            debug(sm.session.sid, 'CHANNEL_CREATE.2:', 'ring_ready');
            esl.executeAsyncX('ring_ready', [], sm.uuid, this);

        });
        return this;
    },
    CHANNEL_: function onCommunicatorScaipChannel(evt, first) {
        debug(this.session.sid, evt.type + ':');
        return this;
    },
    CHANNEL_DESTROY: function onCommunicatorScaipChannelDestroy(evt, first) { // a-leg has ended
        debug(this.session.sid, 'CHANNEL_DESTROY:');
        this.timeout = worker.resetTimeout(this.timeout);
        return this.enter(null) || this;
    },
    CUSTOM: function onCommunicatorScaipCustom(evt, first) {
        debug(this.session.sid, 'CUSTOM:', evt.subclass);
        return this;
    },
    DETECTED_TONE: function onCommunicatorScaipTone(evt, first) { // received tone
        debug(this.session.sid, 'TONE:', evt.headers['Detected-Tone']);
        return this;
    },
    DTMF: function onCommunicatorScaipDtmf(evt, first) {
        debug(this.session.sid, 'DTMF:', evt.headers['DTMF-Digit'] + '@' + (evt.headers['DTMF-Duration'] / 8));
        return this;
    },
    MESSAGE: function onCommunicatorScaipMessage(evt, first) {
        debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], evt.body);
        var mrq = evt.parsed.mrq,
            mrs = evt.parsed.mrs = { ref: mrq.ref[0], snu: 99 }, // 99='undefined error'
            stc = +mrq.stc[0],
            crds; // crds={no-voice:,gsm:,sip:,sip-pp:}
        Object.assign(this.session.payload, evt.parsed, { originUser: evt.headers['from_user'] }); // copies mrq & mrs
        mrq.crd.forEach(function (crd, idx, arr) {
            //var crd_ = crd;
            (crd = crd.match(reCrd)) && (this[crd[1]] = crd[0])
            //debug(JSON.stringify({ crd: crd_, match: crd, crds: this }));
        }, crds = {});
        //debug(this.session.sid, evt.type + ':', JSON.stringify({ stc: stc, crds: crds, callerId: this.callerId }));
        switch (mrq.mty[0]) {
            case 'ME':// message - alarm notify
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && undefined; // immediate cleanup
                else if (stc === 19) // 19='Cancel'
                    crds = Object.assign(mrs, { snu: 0 }) && undefined; // immediate cleanup
                else if (CommunicatorScaip.blockStcs && CommunicatorScaip.blockStcs.includes(stc)) // typically 102='Test transmission, primary channel'
                    crds = Object.assign(mrs, { snu: 0 }) && undefined; // immediate cleanup
                else if (CommunicatorScaip.allowStcs && !CommunicatorScaip.allowStcs.includes(stc)) // non-alarm, therefore non-call - simply acknowledge
                    crds = Object.assign(mrs, { snu: 0 }) && undefined; // immediate cleanup
                else
                    Object.assign(mrs, { snu: 0, mre: 1, cre: 62 });
                break;

            case 'RE': // reset - alarm withdrawn
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && undefined; // immediate cleanup
                else
                    this.callerId = crds = Object.assign(mrs, { snu: 0 }) && undefined;
                break;

            case 'IN':// information - alarm update
                Object.assign(this.session.payload, evt.parsed); // copies mrq & mrs
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && undefined; // immediate cleanup
                else
                    Object.assign(mrs, { snu: 0 });
                break;

            case 'PI': // hearbeat
                if (evt.headers['from_user'] !== mrq.cid[0])
                    crds = Object.assign(mrs, { ste: 'from_user & cid must be identical' }) && undefined; // immediate cleanup
                else
                    crds = Object.assign(mrs, { snu: 0 }) && undefined;
                break;

            default:
                console.log(JSON.stringify(evt.parsed));
                cdrs = undefined;
                break;
        }

        //debug(this.session.sid, evt.type + ':', JSON.stringify({ mrs: mrs, crds: crds, callerId: this.callerId }));
        if (!mrs.mre) { // non-call SCAIP message
            esl.mrs(evt, mrs);
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], '---:', mrs.xml);
            return this.callerId || this.enter(null) || this; // ongoing alarm OR cleanup
        }

        // if we get here this.callerId is not yet set
        this.tnu = [evt.headers['login'].replace('mod_sofia', evt.headers['to_user'])];
        if (this.callerId = crds['sip:']) {
            this.timeout = worker.resetTimeout(this.timeout, this.enter.bind(this, null), 60000); // exit Communicator unless call arrives within 60sec
            Object.assign(mrs, { tnu: this.tnu });
            esl.mrs(evt, mrs);
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], 'sip:', mrs.xml);
            return this;

        } else if (this.callerId = crds['tel:'] || crds['gsm:']) {
            var sm = this;
            chain(function cleanup(err) {
                if (err)
                    console.log(sm.session.sid, 'onCommunicatorScaipMessage:', err) || sm.enter(null);
                debug(sm.session.sid, evt.type + ':', evt.headers['Event-Sequence'], 'gsm:', mrs.xml);
                mrs.snu && sm.enter(null);

            }, function () {
                var tag = crds['tel:'] ? 'tel:' : 'gsm:';
                worker.scaipCid2Tnu(sm.session, tag, this);

            }, function (tnu) { // 'gsm:+e164'
                if (!tnu)
                    return esl.mrs(evt, Object.assign(mrs, { snu: 5, mre: 0, cre: 0 }), this);

                sm.tnu.splice(0, main.hack.multiTnu ? 0 : sm.tnu.length, tnu); // multiple OR single <tnu> nodes (multiple not currently supported by Essence & Neat)
                Object.assign(mrs, { tnu: sm.tnu });
                sm.timeout = worker.resetTimeout(sm.timeout, sm.enter.bind(sm, null), 60000); // exit Communicator unless call arrives within 60sec
                esl.mrs(evt, mrs, this);

            });
            return this;

        } else {
            esl.mrs(evt, Object.assign(mrs, { mre: 0, cre: 0 } ));
            debug(this.session.sid, evt.type + ':', evt.headers['Event-Sequence'], '???:', mrs.xml);
            return this.enter(null) || this;

        }
    },
});

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
// doro:        <mrq><ref>803137200003</ref><mty>ME</mty><cid> 8031372</cid><dty>0004</dty><stc>0010</stc><crd>gsm:+</crd></mrq>
